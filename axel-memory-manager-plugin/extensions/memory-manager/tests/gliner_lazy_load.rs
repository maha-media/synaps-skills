//! End-to-end lazy-load test against the real GLiNER ONNX model.
//!
//! Gated by `#[ignore]` because it needs the ~165 MB model on disk. Run with:
//!
//! ```bash
//! cargo test --release -j 8 -- --ignored
//! ```
//!
//! Strategy: re-include the relevant `main.rs` helpers (`ensure_gliner`,
//! `gliner_model_dir`, `gliner_model_cached`) as a standalone module via
//! `#[path]` so we don't need a lib target. We then point
//! `$AXEL_GLINER_MODEL_DIR` at a real cached model and assert the lazy
//! load succeeds end-to-end.
//!
//! Model resolution mirrors `tests/gliner_inference.rs`:
//!   1. `$AXEL_GLINER_MODEL_DIR` (set by us if not already)
//!   2. `$HOME/.cache/velocirag/models/gliner-small-v2.1`
//!   3. `/tmp/gliner-probe/models--onnx-community--gliner_small-v2.1/snapshots/*`

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[path = "../src/gliner.rs"]
mod gliner;

use gliner::GlinerSession;

// Local stand-ins for the bits of `settings::Settings` that `ensure_gliner`
// inspects. The real settings module pulls in a notify-based file watcher
// and a timer Sender, which we don't want to drag into this integration
// test. Mirroring just the `gliner_enabled` field keeps the wire-equivalent
// behaviour while keeping the test self-contained.
#[derive(Clone, Copy, PartialEq, Eq)]
enum GlinerEnabled {
    On,
    #[allow(dead_code)]
    Off,
}

struct Settings {
    gliner_enabled: GlinerEnabled,
}

impl Default for Settings {
    fn default() -> Self {
        Self { gliner_enabled: GlinerEnabled::On }
    }
}

// ── Inlined copies of the production helpers from main.rs ────────────────────
//
// `main.rs` is a binary, so we can't `use` from it. Reproducing the three
// functions exactly is cheap and pins their behaviour from the test side.

fn gliner_model_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("AXEL_GLINER_MODEL_DIR") {
        return PathBuf::from(p);
    }
    velocirag::download::models_cache_dir().join(gliner::GLINER_SMALL_SPEC.local_dir)
}

fn gliner_model_cached(dir: &std::path::Path) -> bool {
    dir.join("onnx/model.onnx").is_file() && dir.join("tokenizer.json").is_file()
}

fn ensure_gliner(
    gliner: &Arc<Mutex<Option<GlinerSession>>>,
    attempted: &AtomicBool,
    settings: &Settings,
) {
    if attempted.load(Ordering::Relaxed) {
        return;
    }
    if !matches!(settings.gliner_enabled, GlinerEnabled::On) {
        eprintln!("axel: gliner: disabled by setting (gliner_enabled=off); skipping load");
        attempted.store(true, Ordering::Relaxed);
        return;
    }
    let model_dir = gliner_model_dir();
    if !gliner_model_cached(&model_dir) {
        eprintln!(
            "axel: gliner: model not cached at {} — run `axel download` to enable entity enrichment",
            model_dir.display()
        );
        attempted.store(true, Ordering::Relaxed);
        return;
    }
    eprintln!("axel: gliner: lazy-loading from {}", model_dir.display());
    match GlinerSession::load(&model_dir) {
        Ok(s) => *gliner.lock().expect("gliner lock") = Some(s),
        Err(e) => eprintln!("axel: gliner: load failed: {e}"),
    }
    attempted.store(true, Ordering::Relaxed);
}

fn locate_real_model_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("AXEL_GLINER_MODEL_DIR") {
        let pb = PathBuf::from(p);
        if gliner_model_cached(&pb) {
            return Some(pb);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let pb = PathBuf::from(home).join(".cache/velocirag/models/gliner-small-v2.1");
        if gliner_model_cached(&pb) {
            return Some(pb);
        }
    }
    let probe_root =
        PathBuf::from("/tmp/gliner-probe/models--onnx-community--gliner_small-v2.1/snapshots");
    if let Ok(rd) = std::fs::read_dir(&probe_root) {
        for entry in rd.flatten() {
            let p = entry.path();
            if gliner_model_cached(&p) {
                return Some(p);
            }
        }
    }
    None
}

#[test]
#[ignore = "requires ~165 MB GLiNER model on disk; run with --ignored"]
fn lazy_load_against_real_model() {
    let model_dir = match locate_real_model_dir() {
        Some(p) => p,
        None => {
            eprintln!(
                "skipping: no GLiNER model found (set AXEL_GLINER_MODEL_DIR, or place under \
                 ~/.cache/velocirag/models/gliner-small-v2.1, or /tmp/gliner-probe/...)"
            );
            return;
        }
    };

    // Force the helper to use our located dir, regardless of $HOME.
    std::env::set_var("AXEL_GLINER_MODEL_DIR", &model_dir);

    let s = Settings::default(); // gliner_enabled defaults to On
    let gliner: Arc<Mutex<Option<GlinerSession>>> = Arc::new(Mutex::new(None));
    let attempted = AtomicBool::new(false);

    assert!(gliner.lock().unwrap().is_none(), "starts unloaded");
    ensure_gliner(&gliner, &attempted, &s);

    assert!(
        gliner.lock().unwrap().is_some(),
        "ensure_gliner must populate the session against a real cached model"
    );
    assert!(attempted.load(Ordering::Relaxed), "attempted flag must be set");

    // Idempotency: a second call must be a no-op (already loaded).
    ensure_gliner(&gliner, &attempted, &s);
    assert!(gliner.lock().unwrap().is_some(), "session still present");

    std::env::remove_var("AXEL_GLINER_MODEL_DIR");
}
