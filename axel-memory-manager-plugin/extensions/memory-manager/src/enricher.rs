//! Metadata enrichment for chat-turn memory ingestion.
//!
//! Two layers:
//!
//! 1. **Heuristic** (always available, no ML): regex/keyword rules that
//!    extract `category`, `tags`, `importance`, `title`, and (optionally)
//!    `abstract_text` from raw text. Cheap (~µs per turn).
//!
//! 2. **GLiNER** (optional, lazily loaded): augments the heuristic output
//!    with zero-shot named-entity tags + topic + related-topics. Falls
//!    through silently if the model isn't available — the heuristic output
//!    is still returned.
//!
//! Returns an `axel::MemoryPatch`; the caller composes it onto a
//! `Memory::new(...)` and writes via `AxelBrain::remember_full`. This
//! function NEVER panics and NEVER returns Err — degraded enrichment is
//! always preferable to refusing the memory.
//!
//! Logging convention: stderr only (stdout is the JSON-RPC channel).

use axel::MemoryPatch;
use axel_memkoshi::memory::MemoryCategory;

use crate::gliner::GlinerSession;

/// GLiNER zero-shot label set tuned for software engineering chat turns.
const GLINER_LABELS: &[&str] = &[
    "person", "project", "file", "concept", "tool", "command", "error", "feature",
];

/// Enrich raw chat-turn text into a [`MemoryPatch`].
///
/// `gliner = None` falls back to heuristic-only enrichment (still returns a
/// useful patch — tags, category, importance, title).
pub fn enrich(text: &str, gliner: Option<&GlinerSession>) -> MemoryPatch {
    let mut patch = heuristic_enrich(text);

    // Augment with GLiNER spans if the session is loaded. Errors are swallowed
    // — heuristic-only output is still returned.
    if let Some(g) = gliner {
        match g.extract(text, GLINER_LABELS) {
            Ok(spans) if !spans.is_empty() => apply_gliner_spans(&mut patch, &spans),
            Ok(_) => {}
            Err(e) => eprintln!("axel: gliner: extract failed: {e} — heuristic-only enrichment"),
        }
    }

    patch
}

/// Run only the heuristic layer. Public for testing convenience.
pub fn heuristic_enrich(text: &str) -> MemoryPatch {
    let category = classify_category(text);
    let tags = extract_tags(text);
    let importance = score_importance(text);
    let title = title_from_text(text);
    let abstract_text = maybe_abstract(text);

    MemoryPatch {
        category: Some(category),
        topic: None,
        title: Some(title),
        abstract_text: if abstract_text.is_empty() { None } else { Some(abstract_text) },
        content: None,
        confidence: None,
        importance: Some(importance),
        tags: if tags.is_empty() { None } else { Some(tags) },
        related_topics: None,
        source_sessions: None,
        trust_level: None,
        expires_at: None,
    }
}

fn apply_gliner_spans(patch: &mut MemoryPatch, spans: &[crate::gliner::Span]) {
    // Tags: union with heuristic.
    let mut tags = patch.tags.take().unwrap_or_default();
    for s in spans.iter().filter(|s| s.score > 0.5) {
        let t = s.text.to_lowercase();
        if !tags.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
            tags.push(t);
        }
    }
    if !tags.is_empty() {
        patch.tags = Some(tags);
    }

    // Topic = highest-scoring span; otherwise use category as topic label.
    if let Some(top) = spans
        .iter()
        .max_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal))
    {
        patch.topic = Some(top.text.clone());
        // Related = other spans with score > 0.4 excluding the topic.
        let related: Vec<String> = spans
            .iter()
            .filter(|s| s.score > 0.4 && !std::ptr::eq(*s, top))
            .map(|s| s.text.clone())
            .collect();
        if !related.is_empty() {
            patch.related_topics = Some(related);
        }
    }
}

// ── Classification ──────────────────────────────────────────────────────────

fn classify_category(text: &str) -> MemoryCategory {
    let lower = text.to_lowercase();
    // Preferences markers.
    if PREF_PATTERNS.iter().any(|p| lower.contains(p)) {
        return MemoryCategory::Preferences;
    }
    // Cases markers.
    if CASE_PATTERNS.iter().any(|p| lower.contains(p)) {
        return MemoryCategory::Cases;
    }
    // Entities markers.
    if has_entity_pattern(text) {
        return MemoryCategory::Entities;
    }
    MemoryCategory::Events
}

const PREF_PATTERNS: &[&str] = &[
    "i prefer",
    "let's always",
    "lets always",
    "from now on",
    "my style is",
    "always use",
    "never use",
];

const CASE_PATTERNS: &[&str] = &[
    "the case where",
    "scenario:",
    "scenario where",
    "when x happens",
    "when this happens",
    "in the case of",
];

/// Detect "X is a Y", "X works at Y", "X = Y" patterns. Lightweight — we only
/// need to be approximately right to classify.
fn has_entity_pattern(text: &str) -> bool {
    // "X is a Y": at least one capitalised word followed by "is a"/"is the".
    for line in text.lines() {
        let l = line.trim();
        // "Foo is a Bar" / "Foo is the Bar"
        if has_word_isa(l) {
            return true;
        }
        // "Foo works at Bar"
        if l.contains(" works at ") || l.contains(" works for ") {
            return true;
        }
        // "X = Y" (single =, both sides non-empty, no double-equals)
        if let Some(idx) = l.find('=') {
            if !l.contains("==") && idx > 0 && idx + 1 < l.len() {
                let lhs = l[..idx].trim();
                let rhs = l[idx + 1..].trim();
                // skip code-y assignments (let/const/var prefixes are still
                // entities-ish, but we exclude obvious code with semicolons)
                if !lhs.is_empty() && !rhs.is_empty() && !lhs.contains(' ') {
                    return true;
                }
            }
        }
    }
    false
}

fn has_word_isa(s: &str) -> bool {
    // case-insensitive substring search for " is a " / " is the "
    let lower = s.to_lowercase();
    lower.contains(" is a ") || lower.contains(" is the ") || lower.contains(" is an ")
}

// ── Tag extraction ──────────────────────────────────────────────────────────

fn extract_tags(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |t: String| {
        let t = t.trim().trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_' && c != '.').to_string();
        if t.is_empty() || t.len() > 64 {
            return;
        }
        let lower = t.to_lowercase();
        if !out.iter().any(|x| x.eq_ignore_ascii_case(&lower)) {
            out.push(lower);
        }
    };

    // Code fences ```lang
    let mut idx = 0usize;
    while let Some(start) = text[idx..].find("```") {
        let abs = idx + start + 3;
        if abs >= text.len() {
            break;
        }
        // Read until newline / whitespace for the lang label.
        let rest = &text[abs..];
        let end = rest.find(|c: char| c == '\n' || c == '\r' || c == ' ' || c == '`').unwrap_or(rest.len());
        let lang = &rest[..end];
        if !lang.is_empty() && lang.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '+') {
            push(lang.to_string());
        }
        // Skip past the closing fence (if any) so we don't double-match.
        if let Some(next) = rest.find("```") {
            idx = abs + next + 3;
        } else {
            break;
        }
    }

    // Markdown inline `code::path` — first segment before `::`
    for token in text.split('`').skip(1).step_by(2) {
        if let Some((head, _)) = token.split_once("::") {
            let h = head.trim();
            if !h.is_empty() && h.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                push(h.to_string());
            }
        }
    }

    // File paths / extensions.
    for word in text.split(|c: char| c.is_whitespace() || c == ',' || c == '(' || c == ')' || c == '`') {
        let w = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '.' && c != '/' && c != '_' && c != '-');
        if w.is_empty() {
            continue;
        }
        // Specific filenames.
        match w.rsplit('/').next().unwrap_or(w) {
            "Cargo.toml" => push("toml".into()),
            "Cargo.lock" => push("Cargo.lock".into()),
            "plugin.json" => push("plugin.json".into()),
            _ => {}
        }
        // Extensions of interest.
        if let Some(dot) = w.rfind('.') {
            let ext = &w[dot + 1..];
            if matches!(ext, "rs" | "toml" | "md" | "json" | "py" | "ts" | "js" | "go" | "yml" | "yaml") {
                push(ext.to_string());
            }
        }
    }

    // URLs → host.
    for url in extract_urls(text) {
        if let Some(host) = url_host(&url) {
            push(host);
        }
    }

    // Hashtags.
    for word in text.split_whitespace() {
        if let Some(tag) = word.strip_prefix('#') {
            // Trim trailing punctuation.
            let tag = tag.trim_end_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '-');
            if !tag.is_empty() && tag.chars().any(|c| c.is_alphabetic()) {
                push(tag.to_string());
            }
        }
    }

    out
}

fn extract_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for proto in &["http://", "https://"] {
        let mut start = 0;
        while let Some(p) = text[start..].find(proto) {
            let abs = start + p;
            let rest = &text[abs..];
            let end = rest.find(|c: char| c.is_whitespace() || c == ')' || c == ']' || c == '`' || c == '"' || c == '<' || c == '>').unwrap_or(rest.len());
            urls.push(rest[..end].trim_end_matches(|c: char| matches!(c, '.' | ',' | ';' | ':' | '!' | '?')).to_string());
            start = abs + end;
        }
    }
    urls
}

fn url_host(url: &str) -> Option<String> {
    let no_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host = no_scheme.split('/').next().unwrap_or("");
    let host = host.split('@').next_back().unwrap_or(host); // strip userinfo
    let host = host.split(':').next().unwrap_or(host); // strip port
    if host.is_empty() {
        None
    } else {
        Some(host.to_lowercase())
    }
}

// ── Importance / title / abstract ───────────────────────────────────────────

fn score_importance(text: &str) -> f64 {
    let lower = text.to_lowercase();
    let mut s: f64 = 0.5;
    if lower.contains("important")
        || lower.contains("critical")
        || lower.contains("remember")
        || lower.contains("todo")
    {
        s += 0.1;
    }
    // One-liner question: short, ends with '?'.
    let trimmed = text.trim();
    if trimmed.len() < 80 && trimmed.ends_with('?') && !trimmed.contains('\n') {
        s -= 0.1;
    }
    s.clamp(0.1, 0.9)
}

fn title_from_text(text: &str) -> String {
    let first = text.lines().next().unwrap_or("").trim();
    if first.chars().count() <= 80 {
        return first.to_string();
    }
    first.chars().take(80).collect()
}

fn maybe_abstract(text: &str) -> String {
    let para_count = text.split("\n\n").filter(|p| !p.trim().is_empty()).count();
    if para_count <= 3 {
        return String::new();
    }
    let first_para = text.split("\n\n").find(|p| !p.trim().is_empty()).unwrap_or("");
    let first_sentence = first_para
        .split(['.', '!', '?'])
        .next()
        .unwrap_or(first_para)
        .trim();
    let cap: String = first_sentence.chars().take(200).collect();
    cap
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrich_extracts_rust_code_fence_tag() {
        let p = heuristic_enrich("Look at this:\n```rust\nlet x = 1;\n```\n");
        let tags = p.tags.expect("tags");
        assert!(tags.iter().any(|t| t == "rust"), "got {tags:?}");
    }

    #[test]
    fn enrich_extracts_file_path_tag() {
        let p = heuristic_enrich("Edit src/main.rs and Cargo.toml please.");
        let tags = p.tags.expect("tags");
        assert!(tags.iter().any(|t| t == "rs"), "expected 'rs' tag, got {tags:?}");
        assert!(tags.iter().any(|t| t == "toml"), "expected 'toml' tag, got {tags:?}");
    }

    #[test]
    fn enrich_extracts_url_host_tag() {
        let p = heuristic_enrich("See https://github.com/maha-media/axel for details.");
        let tags = p.tags.expect("tags");
        assert!(tags.iter().any(|t| t == "github.com"), "got {tags:?}");
    }

    #[test]
    fn enrich_extracts_hashtag() {
        let p = heuristic_enrich("Tagged this #rustlang for later.");
        let tags = p.tags.expect("tags");
        assert!(tags.iter().any(|t| t == "rustlang"), "got {tags:?}");
    }

    #[test]
    fn enrich_classifies_preferences_keyword() {
        let p = heuristic_enrich("I prefer tabs over spaces.");
        assert_eq!(p.category, Some(MemoryCategory::Preferences));
    }

    #[test]
    fn enrich_classifies_entities_pattern() {
        let p = heuristic_enrich("Alice works at Acme Corp.");
        assert_eq!(p.category, Some(MemoryCategory::Entities));
    }

    #[test]
    fn enrich_classifies_default_events() {
        let p = heuristic_enrich("We deployed the build to staging at 14:00.");
        assert_eq!(p.category, Some(MemoryCategory::Events));
    }

    #[test]
    fn enrich_clamps_importance_to_range() {
        // One-liner question — minus 0.1; baseline 0.5 → 0.4. Within [0.1,0.9].
        let p = heuristic_enrich("What is Rust?");
        let imp = p.importance.expect("importance");
        assert!((0.1..=0.9).contains(&imp), "out of range: {imp}");

        // Important + critical + remember + todo. Only one bump applied.
        let p2 = heuristic_enrich("This is critical: remember the TODO marker. Important!");
        let imp2 = p2.importance.expect("importance");
        assert!((0.1..=0.9).contains(&imp2), "out of range: {imp2}");
        assert!(imp2 > 0.5);
    }

    #[test]
    fn enrich_with_gliner_none_returns_heuristic_only() {
        let p = enrich("Edit src/main.rs", None);
        let tags = p.tags.expect("tags");
        assert!(tags.iter().any(|t| t == "rs"));
        assert!(p.topic.is_none(), "topic must be unset without gliner");
        assert!(p.related_topics.is_none());
    }

    #[test]
    fn enrich_title_truncates_at_80_chars() {
        let long_line = "x".repeat(200);
        let p = heuristic_enrich(&long_line);
        let title = p.title.expect("title");
        assert_eq!(title.chars().count(), 80, "got len {}", title.chars().count());
    }

    #[test]
    fn url_host_extracts_basic() {
        assert_eq!(url_host("https://github.com/foo/bar"), Some("github.com".into()));
        assert_eq!(url_host("http://huggingface.co:8080/x"), Some("huggingface.co".into()));
    }

    #[test]
    fn maybe_abstract_short_text_is_empty() {
        assert!(maybe_abstract("one para only").is_empty());
        assert!(maybe_abstract("a\n\nb\n\nc").is_empty());
    }

    #[test]
    fn maybe_abstract_long_text_takes_first_sentence() {
        let txt = "First sentence here. More.\n\nSecond para.\n\nThird.\n\nFourth para too.";
        let a = maybe_abstract(txt);
        assert!(a.starts_with("First sentence here"));
        assert!(a.len() <= 200);
    }
}
