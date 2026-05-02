//! Phase 4 (Path B) — declarative plugin settings metadata.
//!
//! The Phase 4 contract lets plugins register their own Settings
//! categories and fields with Synaps CLI. This module is the single
//! source of truth for the plugin-side metadata; the same shape is
//! mirrored in `.synaps-plugin/plugin.json` so Synaps can discover the
//! settings either statically (from the manifest) or dynamically (from
//! `info.get` over JSON-RPC).
//!
//! The "custom" model-picker editor renders a row list — this module
//! also exposes the model browser data so the same source feeds both
//! the `settings.editor.open` RPC and any future tooling.

use serde_json::{json, Value};

use crate::commands::{known_backends, known_models};

/// Backend cycler options exposed in `/settings → Voice → STT backend`.
///
/// `auto` is included as the default UX value (let core/plugin pick the
/// best installed accelerator) followed by every backend the plugin
/// knows how to compile against.
pub fn backend_options() -> Vec<&'static str> {
    let mut out = vec!["auto"];
    out.extend(known_backends());
    out
}

/// Language cycler options exposed in `/settings → Voice → Voice language`.
///
/// `auto` lets whisper pick automatically; the rest are the most-common
/// whisper-supported BCP-47 prefixes. Kept short on purpose — the full
/// 99-language list belongs behind a future `picker` editor.
pub fn language_options() -> Vec<&'static str> {
    vec!["auto", "en", "es", "fr", "de", "it", "pt", "nl", "ja", "zh", "ko", "ru"]
}

/// Top-level settings categories declared by the plugin.
///
/// Shape matches the Phase 4 manifest schema (translated from TOML to
/// JSON) so it can be embedded verbatim under `info.get → settings`.
pub fn categories() -> Value {
    json!([
        {
            "id": "voice",
            "label": "Voice",
            "description": "Local Whisper speech-to-text settings.",
            "fields": [
                {
                    "key": "model_path",
                    "label": "STT model",
                    "editor": "custom",
                    "description": "Whisper model used for local dictation. Opens the plugin's model browser.",
                    "config_key": "local-voice.model_path"
                },
                {
                    "key": "backend",
                    "label": "STT backend",
                    "editor": "cycler",
                    "options": backend_options(),
                    "default": "auto",
                    "description": "Compute backend the sidecar was compiled against. Changing this requires `voice rebuild`.",
                    "config_key": "local-voice.backend"
                },
                {
                    "key": "language",
                    "label": "Voice language",
                    "editor": "cycler",
                    "options": language_options(),
                    "default": "auto",
                    "description": "Spoken language hint passed to whisper.",
                    "config_key": "local-voice.language"
                }
            ]
        }
    ])
}

/// Convenience wrapper: full `settings` payload for `info.get`.
pub fn settings_payload() -> Value {
    json!({ "categories": categories() })
}

/// Rows shown when the user opens the custom model-picker editor.
///
/// `data` is the value Synaps sends back via `settings.editor.commit`
/// after the user hits Enter. `download:<id>` rows trigger a model
/// download via the same `voice download` task pipeline implemented in
/// Phase 3.
pub fn model_browser_rows() -> Value {
    let models = known_models();
    let rows: Vec<Value> = models
        .iter()
        .map(|m| {
            let id = m["id"].as_str().unwrap_or("");
            let display = m["display_name"].as_str().unwrap_or(id);
            let size = m["size_mb"].as_i64().unwrap_or(0);
            let installed = m["installed"].as_bool().unwrap_or(false);
            json!({
                "label": format!("{display} ({size} MB)"),
                "marker": if installed { "✓" } else { " " },
                "selectable": true,
                "data": if installed {
                    format!("model:{id}")
                } else {
                    format!("download:{id}")
                },
            })
        })
        .collect();
    json!({
        "rows": rows,
        "cursor": 0,
        "footer": "↑/↓ navigate · Enter select or download · Esc cancel",
    })
}

/// Render payload returned by `settings.editor.open` for a given field.
///
/// Returns `None` when the requested field is not custom-rendered by
/// the plugin (caller should fall back to the declarative editor).
pub fn open_editor(category: &str, field: &str) -> Option<Value> {
    match (category, field) {
        ("voice", "model_path") => Some(model_browser_rows()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_options_include_auto_and_all_known() {
        let opts = backend_options();
        assert_eq!(opts[0], "auto");
        for b in ["cpu", "cuda", "metal", "vulkan", "openblas"] {
            assert!(opts.contains(&b), "missing backend {b}: {opts:?}");
        }
    }

    #[test]
    fn language_options_starts_with_auto_and_includes_english() {
        let opts = language_options();
        assert_eq!(opts.first().copied(), Some("auto"));
        assert!(opts.contains(&"en"));
    }

    #[test]
    fn categories_have_voice_with_three_fields() {
        let cats = categories();
        let arr = cats.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        let voice = &arr[0];
        assert_eq!(voice["id"], "voice");
        assert_eq!(voice["label"], "Voice");
        let fields = voice["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 3);
        let keys: Vec<&str> = fields.iter().map(|f| f["key"].as_str().unwrap()).collect();
        assert_eq!(keys, vec!["model_path", "backend", "language"]);
    }

    #[test]
    fn model_path_is_custom_editor() {
        let cats = categories();
        let model = cats[0]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["key"] == "model_path")
            .cloned()
            .unwrap();
        assert_eq!(model["editor"], "custom");
        assert_eq!(model["config_key"], "local-voice.model_path");
    }

    #[test]
    fn model_browser_rows_match_known_models() {
        let payload = model_browser_rows();
        let rows = payload["rows"].as_array().unwrap();
        assert_eq!(rows.len(), known_models().len());
        // Default cursor on first row.
        assert_eq!(payload["cursor"], 0);
        // Every row carries a `data` payload Synaps can echo back via commit.
        for r in rows {
            let data = r["data"].as_str().unwrap();
            assert!(data.starts_with("download:") || data.starts_with("model:"));
        }
    }

    #[test]
    fn open_editor_returns_rows_for_voice_model_path() {
        let v = open_editor("voice", "model_path").expect("custom render");
        assert!(v["rows"].as_array().unwrap().len() >= 4);
    }

    #[test]
    fn open_editor_returns_none_for_declarative_fields() {
        assert!(open_editor("voice", "backend").is_none());
        assert!(open_editor("voice", "language").is_none());
        assert!(open_editor("voice", "no_such_field").is_none());
        assert!(open_editor("other", "model_path").is_none());
    }
}
