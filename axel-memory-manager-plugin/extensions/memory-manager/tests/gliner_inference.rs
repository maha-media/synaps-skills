//! End-to-end GLiNER inference test.
//!
//! Gated by `#[ignore]` because it needs a 200 MB ONNX model and a
//! tokenizer.json on disk. Run with:
//!
//! ```bash
//! cargo test --release -j 8 -- --ignored
//! ```
//!
//! The test searches the following locations for the model directory
//! (containing `onnx/model.onnx` and `tokenizer.json`):
//!
//! 1. `$AXEL_GLINER_MODEL_DIR` (env var override)
//! 2. `$HOME/.cache/velocirag/models/gliner-small-v2.1`
//! 3. `/tmp/gliner-probe/models--onnx-community--gliner_small-v2.1/snapshots/*`
//!    (the location used by the parent agent's Python probe)
//!
//! If none exists, the test is skipped (with a clear message) so CI
//! doesn't fail in offline environments.

use std::path::PathBuf;

// The crate has no lib target (binary only), so we can't `use
// memory_manager::gliner::...`. Instead, include gliner.rs as a
// standalone module — it has no inter-module deps inside this crate.
#[path = "../src/gliner.rs"]
mod gliner;

use gliner::GlinerSession;

fn locate_model_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AXEL_GLINER_MODEL_DIR") {
        let pb = PathBuf::from(p);
        if pb.join("onnx/model.onnx").is_file() && pb.join("tokenizer.json").is_file() {
            return Some(pb);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let pb = PathBuf::from(home).join(".cache/velocirag/models/gliner-small-v2.1");
        if pb.join("onnx/model.onnx").is_file() && pb.join("tokenizer.json").is_file() {
            return Some(pb);
        }
    }
    let probe_root =
        PathBuf::from("/tmp/gliner-probe/models--onnx-community--gliner_small-v2.1/snapshots");
    if let Ok(rd) = std::fs::read_dir(&probe_root) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.join("onnx/model.onnx").is_file() && p.join("tokenizer.json").is_file() {
                return Some(p);
            }
        }
    }
    None
}

#[test]
#[ignore = "requires GLiNER ONNX model on disk; run with --ignored"]
fn extract_finds_alice_openai_cargo_rust() {
    let model_dir = match locate_model_dir() {
        Some(p) => p,
        None => {
            eprintln!(
                "axel: gliner test: no model dir found; set AXEL_GLINER_MODEL_DIR or \
                 download onnx-community/gliner_small-v2.1 — skipping"
            );
            return;
        }
    };
    eprintln!("axel: gliner test: using model_dir={}", model_dir.display());

    let session = GlinerSession::load(&model_dir).expect("load gliner session");

    let text = "Alice works at OpenAI and uses cargo to build Rust crates.";
    let labels = ["person", "organization", "tool", "language"];
    let label_refs: Vec<&str> = labels.iter().copied().collect();

    let spans = session
        .extract(text, &label_refs)
        .expect("extract should succeed");

    eprintln!("axel: gliner test: got {} spans", spans.len());
    for s in &spans {
        eprintln!(
            "  [{:>5.3}] {:<14} {:>2}..{:<2} {:?}",
            s.score, s.label, s.start, s.end, s.text
        );
    }

    assert!(!spans.is_empty(), "expected at least one span");

    // Check each expected (label, substring) pair is present.
    let expectations: &[(&str, &str)] = &[
        ("person", "Alice"),
        ("organization", "OpenAI"),
        ("tool", "cargo"),
        ("language", "Rust"),
    ];
    for (label, needle) in expectations {
        let found = spans
            .iter()
            .any(|s| s.label == *label && s.text.contains(needle));
        assert!(
            found,
            "expected a {label:?} span containing {needle:?} — got: {spans:#?}"
        );
    }

    // Score sanity: golden Python scores for these are all > 0.85; allow
    // ±0.05 tolerance per the brief, so require > 0.80.
    for (label, needle) in expectations {
        let s = spans
            .iter()
            .find(|s| s.label == *label && s.text.contains(needle))
            .expect("located above");
        assert!(
            s.score > 0.80,
            "{label}/{needle} score too low: {} (expected > 0.80)",
            s.score
        );
    }

    // Char offsets must round-trip the literal substring.
    for s in &spans {
        assert_eq!(
            &text[s.start..s.end],
            s.text,
            "span text must equal text[start..end]"
        );
    }
}
