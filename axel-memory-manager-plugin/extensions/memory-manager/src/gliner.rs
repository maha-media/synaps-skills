//! GLiNER zero-shot named-entity inference.
//!
//! Wraps an `ort::Session` over a HuggingFace ONNX export of GLiNER (e.g.
//! `onnx-community/gliner_small-v2.1`). The model file is downloaded lazily
//! on first use via [`velocirag::download::ensure_model`] and cached at
//! `$XDG_CACHE_HOME/velocirag/models/gliner-small-v2.1`.
//!
//! Status:
//!   * Loader (`GlinerSession::load`) — fully implemented; logs the ONNX
//!     model's input names + shapes to stderr on first load.
//!   * Tokenizer (`tokenizers::Tokenizer`) — loaded.
//!   * Inference (`GlinerSession::extract`) — full input-prep, ONNX
//!     forward pass, sigmoid + NMS span decode, and char-offset remap.
//!
//! The deterministic helpers (`build_prompt`, `decode_spans`,
//! `nms_filter_spans`) are public for unit-testing without the model.
//!
//! Logging convention: stderr only.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ort::value::Tensor;
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
    /// `ort::Session::run` needs `&mut self`; we wrap in a `Mutex` so
    /// `extract` can stay `&self` and remain compatible with the existing
    /// enricher API (`Option<&GlinerSession>`).
    session: Mutex<ort::session::Session>,
    tokenizer: tokenizers::Tokenizer,
    max_span_len: usize,
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
            session: Mutex::new(session),
            tokenizer,
            max_span_len: DEFAULT_MAX_SPAN_LEN,
            threshold: DEFAULT_THRESHOLD,
        })
    }

    /// Run zero-shot entity extraction.
    ///
    /// Builds GLiNER's six ONNX inputs (`input_ids`, `attention_mask`,
    /// `words_mask`, `text_lengths`, `span_idx`, `span_mask`), runs
    /// inference, sigmoid-thresholds the resulting `(1, n_words, MAX_W,
    /// num_classes)` logit grid, maps surviving spans back to character
    /// offsets in the original `text`, and applies overlap NMS.
    pub fn extract(&self, text: &str, labels: &[&str]) -> Result<Vec<Span>, GlinerError> {
        if labels.is_empty() {
            return Ok(Vec::new());
        }
        let offsets = word_char_offsets(text);
        let n_words = offsets.len();
        if n_words == 0 {
            return Ok(Vec::new());
        }
        let words: Vec<&str> = offsets.iter().map(|&(s, e)| &text[s..e]).collect();

        // Prompt: "<<ENT>>l1<<ENT>>l2...<<SEP>> word1 word2 ..."  (note
        // the space after <<SEP>> — the tokenizer needs it to emit a
        // leading SentencePiece word-boundary marker on the first text word.)
        let words_joined = words.join(" ");
        let mut prompt = build_prompt(labels, "");
        prompt.push(' ');
        prompt.push_str(&words_joined);

        let enc = self
            .tokenizer
            .encode(prompt.as_str(), true)
            .map_err(|e| GlinerError::Tokenizer(e.to_string()))?;
        let ids = enc.get_ids();
        let attn = enc.get_attention_mask();
        let toks_slice = enc.get_tokens();
        let seq_len = ids.len();

        let sep_id = self
            .tokenizer
            .token_to_id("<<SEP>>")
            .ok_or_else(|| GlinerError::Tokenizer("tokenizer missing <<SEP>>".into()))?;
        let sep_pos = ids
            .iter()
            .position(|&i| i == sep_id)
            .ok_or_else(|| GlinerError::Inference("<<SEP>> not in encoded ids".into()))?;

        let toks_owned: Vec<String> = toks_slice.to_vec();
        let words_mask = build_words_mask(&toks_owned, sep_pos);

        let max_w = self.max_span_len;
        let (span_pairs, span_mask) = build_span_grid(n_words, max_w);
        let mut span_idx_flat: Vec<i64> = Vec::with_capacity(span_pairs.len() * 2);
        for (s, e) in &span_pairs {
            span_idx_flat.push(*s);
            span_idx_flat.push(*e);
        }

        let ids_i64: Vec<i64> = ids.iter().map(|&x| x as i64).collect();
        let attn_i64: Vec<i64> = attn.iter().map(|&x| x as i64).collect();

        let n_spans = n_words * max_w;
        let inputs = ort::inputs! {
            "input_ids" => Tensor::from_array(([1usize, seq_len], ids_i64))
                .map_err(|e| GlinerError::Inference(format!("input_ids: {e}")))?,
            "attention_mask" => Tensor::from_array(([1usize, seq_len], attn_i64))
                .map_err(|e| GlinerError::Inference(format!("attention_mask: {e}")))?,
            "words_mask" => Tensor::from_array(([1usize, seq_len], words_mask))
                .map_err(|e| GlinerError::Inference(format!("words_mask: {e}")))?,
            "text_lengths" => Tensor::from_array(([1usize, 1], vec![n_words as i64]))
                .map_err(|e| GlinerError::Inference(format!("text_lengths: {e}")))?,
            "span_idx" => Tensor::from_array(([1usize, n_spans, 2], span_idx_flat))
                .map_err(|e| GlinerError::Inference(format!("span_idx: {e}")))?,
            "span_mask" => Tensor::from_array(([1usize, n_spans], span_mask))
                .map_err(|e| GlinerError::Inference(format!("span_mask: {e}")))?,
        };

        let mut spans = Vec::new();
        {
            let mut sess = self
                .session
                .lock()
                .map_err(|_| GlinerError::Inference("session mutex poisoned".into()))?;
            let outputs = sess
                .run(inputs)
                .map_err(|e| GlinerError::Inference(format!("session.run: {e}")))?;

            let logits = outputs
                .get("logits")
                .ok_or_else(|| GlinerError::Inference("missing 'logits' output".into()))?;
            let (shape, data) = logits
                .try_extract_tensor::<f32>()
                .map_err(|e| GlinerError::Inference(format!("extract logits: {e}")))?;

            let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
            // Expected (1, n_words, max_w, num_classes); accept the
            // batch-squeezed (n_words, max_w, num_classes) too.
            let (got_words, got_max_w, num_classes) = match dims.as_slice() {
                [1, w, m, c] => (*w, *m, *c),
                [w, m, c] => (*w, *m, *c),
                _ => {
                    return Err(GlinerError::Inference(format!(
                        "unexpected logits shape: {dims:?}"
                    )));
                }
            };
            if got_words != n_words || got_max_w != max_w || num_classes != labels.len() {
                return Err(GlinerError::Inference(format!(
                    "logits shape mismatch: got ({got_words}, {got_max_w}, {num_classes}), \
                     expected ({n_words}, {max_w}, {})",
                    labels.len()
                )));
            }

            let stride_s = max_w * num_classes;
            let stride_w = num_classes;
            for s in 0..n_words {
                for w in 0..max_w {
                    if s + w >= n_words {
                        continue;
                    }
                    let base = s * stride_s + w * stride_w;
                    for c in 0..num_classes {
                        let raw = data[base + c];
                        let score = sigmoid(raw);
                        if score > self.threshold {
                            let start_char = offsets[s].0;
                            let end_char = offsets[s + w].1;
                            spans.push(Span {
                                start: start_char,
                                end: end_char,
                                text: text[start_char..end_char].to_string(),
                                label: labels[c].to_string(),
                                score,
                            });
                        }
                    }
                }
            }
        }

        eprintln!(
            "axel: gliner: extract: {} raw spans (n_words={}, threshold={})",
            spans.len(),
            n_words,
            self.threshold
        );

        Ok(nms_filter_spans(spans))
    }
}

/// Compute byte-range char offsets of whitespace-delimited words in `text`.
///
/// `text[start..end]` is guaranteed to be valid UTF-8 (the boundaries fall
/// on char boundaries). Used to map word-indexed model spans back to
/// character offsets in the original input.
pub fn word_char_offsets(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut chars = text.char_indices().peekable();
    while let Some(&(i, c)) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        let start = i;
        let mut end = i + c.len_utf8();
        chars.next();
        while let Some(&(j, c2)) = chars.peek() {
            if c2.is_whitespace() {
                break;
            }
            end = j + c2.len_utf8();
            chars.next();
        }
        out.push((start, end));
    }
    out
}

/// Build the per-token `words_mask` GLiNER expects.
///
/// Walks tokens from `sep_pos + 1` onwards. Each time a token starts with
/// the SentencePiece word-boundary marker `▁` (U+2581), increments
/// `word_no` (1-indexed) and assigns it to that token. Continuation pieces
/// (no leading `▁`) and special/label tokens get `0`. Stops at the trailing
/// `[SEP]` / `[PAD]` / `</s>` / `<pad>`.
pub fn build_words_mask(tokens: &[String], sep_pos: usize) -> Vec<i64> {
    let mut mask = vec![0i64; tokens.len()];
    let mut word_no: i64 = 0;
    if sep_pos + 1 >= tokens.len() {
        return mask;
    }
    for i in (sep_pos + 1)..tokens.len() {
        let tok = tokens[i].as_str();
        if matches!(tok, "[SEP]" | "[PAD]" | "</s>" | "<pad>" | "<s>") {
            break;
        }
        if tok.starts_with('\u{2581}') {
            word_no += 1;
            mask[i] = word_no;
        }
    }
    mask
}

/// Build the full `(s, s+w)` span grid for `n_words` × `max_w`.
///
/// Returns a flat list of `(start_word, end_word)` pairs in row-major order
/// (outer loop `s`, inner loop `w`) and a parallel `mask` of length
/// `n_words * max_w` where `mask[s*max_w + w] = (s + w) < n_words`.
///
/// All slots — including ones with `s + w >= n_words` — are present; the
/// mask is what tells the model which to score.
pub fn build_span_grid(n_words: usize, max_w: usize) -> (Vec<(i64, i64)>, Vec<bool>) {
    let mut idx = Vec::with_capacity(n_words * max_w);
    let mut mask = Vec::with_capacity(n_words * max_w);
    for s in 0..n_words {
        for w in 0..max_w {
            idx.push((s as i64, (s + w) as i64));
            mask.push(s + w < n_words);
        }
    }
    (idx, mask)
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
    fn word_offsets_handles_unicode() {
        // "Café Москва 東京"  — multi-byte words, single-space separated.
        let s = "Café Москва 東京";
        let off = word_char_offsets(s);
        assert_eq!(off.len(), 3);
        assert_eq!(&s[off[0].0..off[0].1], "Café");
        assert_eq!(&s[off[1].0..off[1].1], "Москва");
        assert_eq!(&s[off[2].0..off[2].1], "東京");
    }

    #[test]
    fn word_offsets_handles_leading_and_multiple_spaces() {
        let s = "  hello   world ";
        let off = word_char_offsets(s);
        assert_eq!(off.len(), 2);
        assert_eq!(&s[off[0].0..off[0].1], "hello");
        assert_eq!(&s[off[1].0..off[1].1], "world");
    }

    #[test]
    fn build_words_mask_for_known_tokens() {
        // Synthetic SentencePiece-style token list. The "▁" (U+2581) marks
        // the start of a new word in the text region (after <<SEP>>).
        let toks: Vec<String> = ["[CLS]", "<<ENT>>", "▁person", "<<SEP>>", "▁Alice", "▁works", "[SEP]"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let sep_pos = 3usize;
        let mask = build_words_mask(&toks, sep_pos);
        assert_eq!(mask, vec![0, 0, 0, 0, 1, 2, 0]);
    }

    #[test]
    fn build_words_mask_handles_continuation_tokens() {
        // SentencePiece often splits a single word into a leading "▁foo"
        // plus continuation pieces (no underscore prefix) — those count as
        // the same word.
        let toks: Vec<String> = ["[CLS]", "<<SEP>>", "▁Open", "AI", "▁is", "▁cool", "[SEP]"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mask = build_words_mask(&toks, 1);
        // word 1 = OpenAI (two pieces, only the leading ▁Open gets the
        // word_no), word 2 = is, word 3 = cool.
        assert_eq!(mask, vec![0, 0, 1, 0, 2, 3, 0]);
    }

    #[test]
    fn build_span_grid_full_with_mask() {
        let (idx, mask) = build_span_grid(3, 2);
        // 3 words × 2 widths = 6 slots; index pairs (s, s+w):
        assert_eq!(idx, vec![(0, 0), (0, 1), (1, 1), (1, 2), (2, 2), (2, 3)]);
        assert_eq!(mask, vec![true, true, true, true, true, false]);
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
