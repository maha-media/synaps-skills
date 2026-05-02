//! Phase 4 preparation: Synaps CLI must be able to discover the plugin's
//! settings categories and the "custom" model-browser rows via JSON-RPC.
//!
//! This is additive — `info.get` keeps its existing shape and gains a
//! `settings` array, plus three new methods are advertised:
//!   - `settings.editor.open`
//!   - `settings.editor.key`
//!   - `settings.editor.commit`
//!
//! When the plugin's `settings.editor.open` is called for the model
//! picker, the plugin replies with a `render` payload describing
//! selectable rows in the model browser.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::Value;

fn next_frame(stdout: &mut BufReader<std::process::ChildStdout>) -> Value {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        let n = stdout.read_line(&mut line).expect("read frame header");
        assert!(n > 0, "plugin stdout ended unexpectedly");
        if line == "\r\n" || line == "\n" {
            break;
        }
        let (name, value) = line.split_once(':').expect("header has colon");
        if name.eq_ignore_ascii_case("content-length") {
            content_length = Some(value.trim().parse::<usize>().expect("valid length"));
        }
    }
    let len = content_length.expect("Content-Length header");
    let mut body = vec![0; len];
    std::io::Read::read_exact(stdout, &mut body).expect("read frame body");
    serde_json::from_slice(&body).expect("valid JSON frame")
}

fn write_frame(stdin: &mut std::process::ChildStdin, payload: Value) {
    let body = serde_json::to_vec(&payload).unwrap();
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
    stdin.write_all(&body).unwrap();
    stdin.flush().unwrap();
}

fn spawn() -> (
    std::process::Child,
    std::process::ChildStdin,
    BufReader<std::process::ChildStdout>,
) {
    let exe = env!("CARGO_BIN_EXE_synaps-voice-plugin");
    let mut child = Command::new(exe)
        .arg("--extension-rpc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn plugin rpc");
    let stdin = child.stdin.take().expect("plugin stdin");
    let stdout = BufReader::new(child.stdout.take().expect("plugin stdout"));
    (child, stdin, stdout)
}

#[test]
fn info_get_advertises_phase4_settings_metadata() {
    let (mut child, mut stdin, mut stdout) = spawn();
    write_frame(
        &mut stdin,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
    );
    let init = next_frame(&mut stdout);
    let caps = &init["result"]["capabilities"];
    // Phase 4 capability flag — additive.
    assert_eq!(caps["settings"], serde_json::json!(true), "capabilities.settings must be true");

    write_frame(
        &mut stdin,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"info.get","params":null}),
    );
    let info = next_frame(&mut stdout);
    let result = &info["result"];

    // Existing shape preserved.
    assert!(result["build"]["backend"].as_str().is_some());
    assert_eq!(result["capabilities"][0]["kind"], "voice");

    // Phase 4: settings categories present and well-formed.
    let categories = result["settings"]["categories"]
        .as_array()
        .expect("info.get must include settings.categories");
    let voice = categories
        .iter()
        .find(|c| c["id"] == "voice")
        .expect("voice category present");
    let fields = voice["fields"].as_array().expect("fields");
    let keys: Vec<&str> = fields.iter().map(|f| f["key"].as_str().unwrap()).collect();
    for required in ["model_path", "backend", "language"] {
        assert!(keys.contains(&required), "missing field {required}: {keys:?}");
    }

    write_frame(&mut stdin, serde_json::json!({"jsonrpc":"2.0","id":99,"method":"shutdown","params":null}));
    let _ = next_frame(&mut stdout);
    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success());
}

#[test]
fn settings_editor_open_returns_model_browser_rows() {
    let (mut child, mut stdin, mut stdout) = spawn();
    write_frame(&mut stdin, serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}));
    let _ = next_frame(&mut stdout);

    write_frame(
        &mut stdin,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"settings.editor.open",
            "params": {"category":"voice","field":"model_path"}
        }),
    );
    let resp = next_frame(&mut stdout);
    let result = &resp["result"];
    assert_eq!(result["category"], "voice");
    assert_eq!(result["field"], "model_path");
    let rows = result["render"]["rows"].as_array().expect("render.rows");
    assert!(rows.len() >= 4, "expected at least 4 model rows, got {}", rows.len());
    let first = &rows[0];
    assert!(first["label"].as_str().unwrap().to_lowercase().contains("tiny"));
    assert!(first["data"].as_str().is_some(), "row must carry `data` payload");
    assert!(result["render"]["footer"].as_str().is_some());

    write_frame(&mut stdin, serde_json::json!({"jsonrpc":"2.0","id":99,"method":"shutdown","params":null}));
    let _ = next_frame(&mut stdout);
    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success());
}
