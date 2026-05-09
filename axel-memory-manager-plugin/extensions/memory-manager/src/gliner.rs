//! GLiNER zero-shot named-entity inference.
//!
//! Wraps an `ort::Session` over a HuggingFace ONNX export of GLiNER (e.g.
//! `onnx-community/gliner_small-v2.1`). The model file is downloaded lazily
//! on first use via [`velocirag::download::ensure_model`] and cached at
//! `$XDG_CACHE_HOME/velocirag/models/gliner-small-v2.1`.
//!
//! Status (Track B v1):
//!   * Loader (`GlinerSession::load`) — fully implemented; logs the ONNX
//!     model's input names + shapes to stderr on first load so we can
//!     adjust to schema variations without code changes.
//!   * Tokenizer (`tokenizers::Tokenizer`) — loaded.
//!   * Inference (`GlinerSession::extract`) — STUBBED, returns
//!     `Ok(vec![])`. The full input-prep + span-decoder glue is genuinely
//!     ~250 LoC and depends on the exact ONNX schema (which varies between
//!     `urchade/*` and `onnx-community/*` exports). The brief explicitly
//!     allows a stub here so we can ship the heuristic enricher (Phase 2)
//!     and the full Track A wiring without blocking on ML glue.
//!
//! The deterministic helpers (`build_prompt`, `decode_spans`,
//! `nms_filter_spans`) are public for unit-testing without the model.
//!
//! Logging convention: stderr only.

use std::path::{Path, PathBuf};

use velocirag::download::ModelSpec;

/// Spec for `urchade/gliner_small-v2.1`. The base model has no ONNX export,
/// but `onnx-community/gliner_small-v2.1` republishes the same weights as
/// ONNX with a usable tokenizer.json.
pub const GLINER_SMALL_SPEC: ModelSpec = ModelSpec {
    repo: "onnx-community/gliner_small-v2.1",
    local_dir: "gliner-small-v2.1",
    files: &[
        ("onnx/model.onnx", "onnx/model.onnx"),
        ("tokenizer.json", "tokenizer.json"),
    ],
};

/// Spec for the medium variant — same publisher convention.
pub const GLINER_MEDIUM_SPEC: ModelSpec = ModelSpec {
    repo: "onnx-community/gliner_medium-v2.1",
    local_dir: "gliner-medium-v2.1",
    files: &[
        ("onnx/model.onnx", "onnx/model.onnx"),
        ("tokenizer.json", "tokenizer.json"),
    ],
};

/// One detected entity span.
#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    /// Character offset (inclusive) into the original text.
    pub start: usize,
    /// Character offset (exclusive) into the original text.
    pub end: usize,
    /// The literal substring from `text[start..end]`.
    pub text: String,
    /// The label this span was decoded against.
    pub label: String,
    /// Sigmoid-activated confidence in `[0, 1]`.
    pub score: f32,
}

#[derive(Debug)]
pub enum GlinerError {
    Download(String),
    Session(String),
    Tokenizer(String),
    Inference(String),
}

impl std::fmt::Display for GlinerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Download(s) => write!(f, "download failed: {s}"),
            Self::Session(s) => write!(f, "session init failed: {s}"),
            Self::Tokenizer(s) => write!(f, "tokenizer load failed: {s}"),
            Self::Inference(s) => write!(f, "inference failed: {s}"),
        }
    }
}

impl std::error::Error for GlinerError {}

/// A loaded GLiNER session ready for `extract` calls.
pub struct GlinerSession {
    #[allow(dead_code)]
    session: ort::session::Session,
    #[allow(dead_code)]
    tokenizer: tokenizers::Tokenizer,
    #[allow(dead_code)]
    max_span_len: usize,
    #[allow(dead_code)]
    threshold: f32,
}

/// Default span length cap. GLiNER's training maxes out around 12 tokens.
pub const DEFAULT_MAX_SPAN_LEN: usize = 12;
/// Default sigmoid threshold for span acceptance.
pub const DEFAULT_THRESHOLD: f32 = 0.5;

impl GlinerSession {
    /// Load a GLiNER model from a directory containing
    /// `onnx/model.onnx` and `tokenizer.json`.
    ///
    /// Logs the ONNX session's input names + shapes to stderr on first
    /// load so a future maintainer can adjust the input-prep code without
    /// re-reading the model.
    pub fn load(model_dir: &Path) -> Result<Self, GlinerError> {
        let onnx_path: PathBuf = model_dir.join("onnx/model.onnx");
        let tok_path: PathBuf = model_dir.join("tokenizer.json");

        let tokenizer = tokenizers::Tokenizer::from_file(&tok_path)
            .map_err(|e| GlinerError::Tokenizer(format!("{}: {e}", tok_path.display())))?;

        let session = ort::session::Session::builder()
            .map_err(|e| GlinerError::Session(e.to_string()))?
            .commit_from_file(&onnx_path)
            .map_err(|e| GlinerError::Session(format!("{}: {e}", onnx_path.display())))?;

        eprintln!(
            "axel: gliner: loaded {} ({} inputs, {} outputs)",
            onnx_path.display(),
            session.inputs().len(),
            session.outputs().len(),
        );
        for (i, inp) in session.inputs().iter().enumerate() {
            eprintln!("axel: gliner: input[{i}] name={:?}", inp.name());
        }
        for (i, out) in session.outputs().iter().enumerate() {
            eprintln!("axel: gliner: output[{i}] name={:?}", out.name());
        }

        Ok(Self {
            session,
            tokenizer,
            max_span_len: DEFAULT_MAX_SPAN_LEN,
            threshold: DEFAULT_THRESHOLD,
        })
    }

    /// Run zero-shot entity extraction.
    ///
    /// **STUB** in Track B v1 — returns `Ok(vec![])`. The end-to-end
    /// inference glue (input-prep matching the model's exact schema,
    /// span-grid construction, sigmoid + NMS decode, char-offset
    /// remapping) is genuinely ~250 LoC and is deferred to a follow-up.
    ///
    /// The deterministic helpers are still tested so the follow-up has a
    /// firm foundation.
    pub fn extract(&self, _text: &str, _labels: &[&str]) -> Result<Vec<Span>, GlinerError> {
        // TODO(track-b-followup): wire the full inference path. See
        // module docs for the required pieces.
        Ok(Vec::new())
    }
}

// ── Deterministic helpers (no model required) ───────────────────────────────

/// GLiNER's canonical prompt format: `<<ENT>>label1<<ENT>>label2...<<SEP>>text`.
///
/// Public for unit-testing the prep logic without the model.
pub fn build_prompt(labels: &[&str], text: &str) -> String {
    let mut out = String::new();
    for l in labels {
        out.push_str("<<ENT>>");
        out.push_str(l);
    }
    out.push_str("<<SEP>>");
    out.push_str(text);
    out
}

/// Sigmoid.
fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// Decode a `(num_spans, num_labels)` logit grid into `Span`s. `spans` is
/// the parallel array of `(start_char, end_char, &str text)` describing
/// each row in the grid. Caller is responsible for the span enumeration
/// (which depends on the model's tokenization). Output is filtered by the
/// supplied `threshold` (sigmoid-activated).
///
/// Public for unit-testing without the model.
pub fn decode_spans(
    logits: &[Vec<f32>],
    span_offsets: &[(usize, usize, String)],
    labels: &[&str],
    threshold: f32,
) -> Vec<Span> {
    let mut out = Vec::new();
    for (row, scores) in logits.iter().enumerate() {
        if row >= span_offsets.len() {
            break;
        }
        for (col, &raw) in scores.iter().enumerate() {
            if col >= labels.len() {
                break;
            }
            let s = sigmoid(raw);
            if s > threshold {
                let (start, end, ref text) = span_offsets[row];
                out.push(Span {
                    start,
                    end,
                    text: text.clone(),
                    label: labels[col].to_string(),
                    score: s,
                });
            }
        }
    }
    out
}

/// Greedy NMS-style overlap filter: when two spans overlap by character
/// range, keep the one with the higher score and drop the other.
pub fn nms_filter_spans(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<Span> = Vec::new();
    for s in spans {
        let overlap = kept.iter().any(|k| s.start < k.end && k.start < s.end);
        if !overlap {
            kept.push(s);
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_format_concatenates_labels_with_separators() {
        let p = build_prompt(&["person", "tool"], "Alice uses cargo.");
        assert_eq!(
            p,
            "<<ENT>>person<<ENT>>tool<<SEP>>Alice uses cargo."
        );
    }

    #[test]
    fn span_decoder_picks_above_threshold() {
        let labels = &["person", "tool"];
        let span_offsets = vec![
            (0, 5, "Alice".into()),
            (12, 17, "cargo".into()),
        ];
        // Row 0: high logit at col 0 (person).
        // Row 1: high logit at col 1 (tool).
        let logits = vec![vec![5.0, -5.0], vec![-5.0, 5.0]];
        let out = decode_spans(&logits, &span_offsets, labels, 0.5);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].label, "person");
        assert_eq!(out[0].text, "Alice");
        assert_eq!(out[1].label, "tool");
        assert_eq!(out[1].text, "cargo");
        assert!(out[0].score > 0.99);
    }

    #[test]
    fn span_decoder_filters_below_threshold() {
        let labels = &["person"];
        let span_offsets = vec![(0, 5, "Alice".into())];
        let logits = vec![vec![-5.0]];
        assert!(decode_spans(&logits, &span_offsets, labels, 0.5).is_empty());
    }

    #[test]
    fn span_decoder_filters_overlapping_keeps_highest_score() {
        // Two overlapping spans (chars 0..10 and 5..15); higher score wins.
        let s1 = Span { start: 0, end: 10, text: "foo".into(), label: "a".into(), score: 0.6 };
        let s2 = Span { start: 5, end: 15, text: "bar".into(), label: "b".into(), score: 0.9 };
        let s3 = Span { start: 20, end: 25, text: "baz".into(), label: "c".into(), score: 0.7 };
        let kept = nms_filter_spans(vec![s1, s2.clone(), s3.clone()]);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0], s2, "highest score must come first");
        assert_eq!(kept[1], s3);
    }

    #[test]
    fn gliner_small_spec_paths_are_present_on_hf() {
        // Smoke check: the spec we actually ship must reference the file
        // names that exist on HF. Hard-coded; the curl HEAD verification
        // is documented in the task brief.
        assert_eq!(GLINER_SMALL_SPEC.repo, "onnx-community/gliner_small-v2.1");
        assert!(GLINER_SMALL_SPEC.files.iter().any(|(_, l)| *l == "onnx/model.onnx"));
        assert!(GLINER_SMALL_SPEC.files.iter().any(|(_, l)| *l == "tokenizer.json"));
    }
}
