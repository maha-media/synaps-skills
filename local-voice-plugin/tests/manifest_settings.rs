//! Phase 4 (Path B) preparation: the plugin manifest must declare a
//! `settings` block describing categories and fields the plugin exposes
//! to Synaps CLI's `/settings` UI. Synaps Phase 4 may consume this either
//! via the manifest directly or via `info.get`; we keep the shapes in
//! sync so either path works.

use std::path::PathBuf;

use serde_json::Value;

fn manifest() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(".synaps-plugin")
        .join("plugin.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).expect("plugin.json is valid JSON")
}

#[test]
fn manifest_declares_settings_block_with_voice_category() {
    let m = manifest();
    let settings = m
        .get("settings")
        .expect("plugin.json must declare a `settings` block (Phase 4)");
    let categories = settings
        .get("categories")
        .and_then(Value::as_array)
        .expect("settings.categories must be an array");
    let voice = categories
        .iter()
        .find(|c| c.get("id") == Some(&Value::from("voice")))
        .expect("must include a `voice` settings category");
    assert_eq!(
        voice.get("label").and_then(Value::as_str),
        Some("Voice"),
        "voice category must have label \"Voice\""
    );
}

#[test]
fn voice_category_fields_match_phase4_shape() {
    let m = manifest();
    let voice = m["settings"]["categories"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "voice")
        .cloned()
        .unwrap();
    let fields = voice["fields"].as_array().expect("fields array");
    let by_key = |k: &str| {
        fields
            .iter()
            .find(|f| f["key"] == k)
            .cloned()
            .unwrap_or_else(|| panic!("missing field {k}"))
    };

    // Custom editor for the model picker (Phase 4 model browser).
    let model = by_key("model_path");
    assert_eq!(model["editor"], "custom");
    assert!(model["label"].as_str().unwrap().to_lowercase().contains("model"));

    // Backend cycler — declarative, no plugin involvement at edit time.
    let backend = by_key("backend");
    assert_eq!(backend["editor"], "cycler");
    let opts: Vec<&str> = backend["options"]
        .as_array()
        .expect("backend.options")
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    for required in ["cpu", "cuda", "metal", "vulkan", "openblas"] {
        assert!(opts.contains(&required), "backend options missing {required}: {opts:?}");
    }

    // Language cycler — declarative.
    let language = by_key("language");
    assert_eq!(language["editor"], "cycler");
    let lang_opts = language["options"].as_array().expect("language.options");
    assert!(
        lang_opts.iter().any(|v| v == "auto") && lang_opts.iter().any(|v| v == "en"),
        "language options should at least include `auto` and `en`: {lang_opts:?}"
    );
}
