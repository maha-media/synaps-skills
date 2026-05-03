//! Phase 4 (Path B) — declarative plugin settings metadata + stateful
//! custom editor for the model browser.
//!
//! The Phase 4 contract lets plugins register their own Settings
//! categories and fields with Synaps CLI. This module is the single
//! source of truth for the plugin-side metadata; the same shape is
//! mirrored in `.synaps-plugin/plugin.json` so Synaps can discover the
//! settings either statically (from the manifest) or dynamically (from
//! `info.get` over JSON-RPC).
//!
//! The "custom" model-picker editor renders a row list. The plugin
//! tracks per-(category, field) state across a session so that
//! `settings.editor.key` can move the cursor and re-render, and
//! `settings.editor.commit` can resolve the currently-highlighted row
//! into a structured intent without core having to re-parse strings.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::commands::{known_backends, known_models};

/// Backend cycler options exposed in `/settings → Voice → STT backend`.
pub fn backend_options() -> Vec<&'static str> {
    let mut out = vec!["auto"];
    out.extend(known_backends());
    out
}

/// Language cycler options exposed in `/settings → Voice → Voice language`.
pub fn language_options() -> Vec<&'static str> {
    vec!["auto", "en", "es", "fr", "de", "it", "pt", "nl", "ja", "zh", "ko", "ru"]
}

/// Top-level settings categories declared by the plugin.
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

/// Config key associated with the model-picker custom editor.
pub const MODEL_PATH_CONFIG_KEY: &str = "local-voice.model_path";

/// Per-(category, field) editor state tracked across the session.
#[derive(Debug, Clone, Copy)]
struct EditorState {
    cursor: usize,
}

fn state_map() -> &'static Mutex<HashMap<(String, String), EditorState>> {
    static MAP: OnceLock<Mutex<HashMap<(String, String), EditorState>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key(category: &str, field: &str) -> (String, String) {
    (category.to_string(), field.to_string())
}

/// Build the rows for the model browser. Pure function — no state.
fn model_browser_row_data() -> Vec<Value> {
    let models = known_models();
    models
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
        .collect()
}

/// Render the model browser at a given cursor position.
fn render_model_browser(cursor: usize) -> Value {
    let rows = model_browser_row_data();
    let max = rows.len().saturating_sub(1);
    let cursor = cursor.min(max);
    json!({
        "rows": rows,
        "cursor": cursor,
        "footer": "↑/↓ navigate · Enter select or download · Esc cancel",
    })
}

/// Initial render shape (kept for back-compat with earlier callers/tests).
pub fn model_browser_rows() -> Value {
    render_model_browser(0)
}

/// Open (or reset) the editor for `(category, field)`. Returns the
/// initial render or `None` if the field is not custom-rendered.
pub fn open_editor(category: &str, field: &str) -> Option<Value> {
    match (category, field) {
        ("voice", "model_path") => {
            state_map()
                .lock()
                .unwrap()
                .insert(key(category, field), EditorState { cursor: 0 });
            Some(render_model_browser(0))
        }
        _ => None,
    }
}

/// Number of selectable rows for a given custom editor.
fn row_count(category: &str, field: &str) -> Option<usize> {
    match (category, field) {
        ("voice", "model_path") => Some(known_models().len()),
        _ => None,
    }
}

/// Apply a key event to the tracked cursor and return the new render.
/// Recognised keys (case-insensitive): `Down`, `Up`, `Home`, `End`,
/// `PageDown`, `PageUp`. Unknown keys leave the cursor unchanged.
pub fn key_editor(category: &str, field: &str, key_name: &str) -> Option<Value> {
    let n = row_count(category, field)?;
    if n == 0 {
        return Some(render_model_browser(0));
    }
    let max = n - 1;
    let mut map = state_map().lock().unwrap();
    let entry = map
        .entry(key(category, field))
        .or_insert(EditorState { cursor: 0 });
    let cur = entry.cursor.min(max);
    let next = match key_name {
        "Down" | "down" | "ArrowDown" | "j" => (cur + 1).min(max),
        "Up" | "up" | "ArrowUp" | "k" => cur.saturating_sub(1),
        "Home" | "home" => 0,
        "End" | "end" => max,
        "PageDown" | "pagedown" => (cur + 5).min(max),
        "PageUp" | "pageup" => cur.saturating_sub(5),
        _ => cur,
    };
    entry.cursor = next;
    Some(render_model_browser(next))
}

/// Resolve a model id to a config-ready model_path. Currently the same
/// as the id (e.g. `ggml-tiny.en.bin`); core may rewrite to an absolute
/// path when persisting. Returns `None` for unknown ids.
fn resolve_model_path(model_id: &str) -> Option<String> {
    let known = known_models();
    if known.iter().any(|m| m["id"] == Value::String(model_id.to_string())) {
        Some(model_id.to_string())
    } else {
        None
    }
}

/// Commit the current selection (or a caller-supplied `value`) into a
/// structured intent. Returns `(ok, payload)` where `payload` is the
/// JSON body to embed under the JSON-RPC `result`.
pub fn commit_editor(category: &str, field: &str, value: Option<&Value>) -> Value {
    // 1. Determine the data string to interpret.
    let data: Option<String> = match value {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Null) | None => {
            // Use cursor to look up the row's `data` field.
            let cursor = state_map()
                .lock()
                .unwrap()
                .get(&key(category, field))
                .map(|s| s.cursor)
                .unwrap_or(0);
            if (category, field) == ("voice", "model_path") {
                let rows = model_browser_row_data();
                rows.get(cursor)
                    .and_then(|r| r["data"].as_str().map(str::to_owned))
            } else {
                None
            }
        }
        Some(other) => Some(other.to_string()),
    };

    let Some(data) = data else {
        return json!({
            "ok": false,
            "error": "no value provided and no editor session open",
        });
    };

    // 2. Resolve into a structured intent.
    if let Some(rest) = data.strip_prefix("download:") {
        let model_id = rest.to_string();
        if resolve_model_path(&model_id).is_none() {
            return json!({
                "ok": false,
                "value": data,
                "error": format!("unknown model id: {model_id}"),
            });
        }
        return json!({
            "ok": true,
            "value": data,
            "intent": {
                "kind": "download",
                "model_id": model_id,
                "command": "voice",
                "args": ["download", model_id],
            },
        });
    }
    if let Some(rest) = data.strip_prefix("model:") {
        let model_id = rest.to_string();
        let Some(model_path) = resolve_model_path(&model_id) else {
            return json!({
                "ok": false,
                "value": data,
                "error": format!("unknown model id: {model_id}"),
            });
        };
        return json!({
            "ok": true,
            "value": data,
            "intent": {
                "kind": "select",
                "model_id": model_id,
                "config_key": MODEL_PATH_CONFIG_KEY,
                "model_path": model_path,
            },
        });
    }
    // Raw string commit — let core decide.
    json!({
        "ok": true,
        "value": data,
        "intent": {"kind": "raw"},
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Unit tests share the global editor-state map; serialize them.
    fn test_lock() -> &'static Mutex<()> {
        static L: OnceLock<Mutex<()>> = OnceLock::new();
        L.get_or_init(|| Mutex::new(()))
    }

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
        assert_eq!(model["config_key"], MODEL_PATH_CONFIG_KEY);
    }

    #[test]
    fn model_browser_rows_match_known_models() {
        let payload = model_browser_rows();
        let rows = payload["rows"].as_array().unwrap();
        assert_eq!(rows.len(), known_models().len());
        assert_eq!(payload["cursor"], 0);
        for r in rows {
            let data = r["data"].as_str().unwrap();
            assert!(data.starts_with("download:") || data.starts_with("model:"));
        }
    }

    #[test]
    fn open_editor_returns_rows_for_voice_model_path() {
        let v = open_editor("voice", "model_path").expect("custom render");
        assert!(v["rows"].as_array().unwrap().len() >= 4);
        assert_eq!(v["cursor"], 0);
    }

    #[test]
    fn open_editor_returns_none_for_declarative_fields() {
        assert!(open_editor("voice", "backend").is_none());
        assert!(open_editor("voice", "language").is_none());
        assert!(open_editor("voice", "no_such_field").is_none());
        assert!(open_editor("other", "model_path").is_none());
    }

    #[test]
    fn key_down_moves_cursor_and_rerenders_unit() {
        let _g = test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let _ = open_editor("voice", "model_path");
        let r1 = key_editor("voice", "model_path", "Down").unwrap();
        assert_eq!(r1["cursor"], 1);
        let r2 = key_editor("voice", "model_path", "Down").unwrap();
        assert_eq!(r2["cursor"], 2);
        let r3 = key_editor("voice", "model_path", "Up").unwrap();
        assert_eq!(r3["cursor"], 1);
    }

    #[test]
    fn key_clamps_at_bounds_unit() {
        let _g = test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let _ = open_editor("voice", "model_path");
        // Up at top stays at 0.
        let r = key_editor("voice", "model_path", "Up").unwrap();
        assert_eq!(r["cursor"], 0);
        // Down many times clamps to last index.
        let n = known_models().len();
        let mut last = 0u64;
        for _ in 0..(n + 10) {
            last = key_editor("voice", "model_path", "Down").unwrap()["cursor"]
                .as_u64()
                .unwrap();
        }
        assert_eq!(last as usize, n - 1);
    }

    #[test]
    fn commit_select_resolves_model_path_unit() {
        let _g = test_lock().lock().unwrap_or_else(|p| p.into_inner());
        let _ = open_editor("voice", "model_path");
        let v = json!("model:ggml-base.en.bin");
        let out = commit_editor("voice", "model_path", Some(&v));
        assert_eq!(out["ok"], true);
        assert_eq!(out["intent"]["kind"], "select");
        assert_eq!(out["intent"]["model_id"], "ggml-base.en.bin");
        assert_eq!(out["intent"]["config_key"], MODEL_PATH_CONFIG_KEY);
        assert_eq!(out["intent"]["model_path"], "ggml-base.en.bin");
    }

    #[test]
    fn commit_download_exposes_command_args_unit() {
        let v = json!("download:ggml-tiny.en.bin");
        let out = commit_editor("voice", "model_path", Some(&v));
        assert_eq!(out["ok"], true);
        assert_eq!(out["intent"]["kind"], "download");
        assert_eq!(out["intent"]["command"], "voice");
        assert_eq!(out["intent"]["args"], json!(["download", "ggml-tiny.en.bin"]));
    }

    #[test]
    fn commit_unknown_model_returns_error_unit() {
        let v = json!("model:nope");
        let out = commit_editor("voice", "model_path", Some(&v));
        assert_eq!(out["ok"], false);
        assert!(out["error"].as_str().unwrap().contains("nope"));
    }
}
