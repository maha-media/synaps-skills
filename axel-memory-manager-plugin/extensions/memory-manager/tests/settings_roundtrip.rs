//! Integration test: live reload of plugin settings via the file-watcher.
//!
//! Spawns the compiled `memory-manager` binary in a sandboxed
//! `$SYNAPS_BASE_DIR` (a tempfile::tempdir()), confirms the default
//! `min_consolidate_len` (40) gates short messages out of `remember`, then
//! writes a new value to the on-disk config file, waits for the watcher to
//! pick it up, and asserts a previously-too-short message now lands in the
//! SQLite brain.
//!
//! The watcher debounce window is 150ms; we wait 800ms after the file write
//! to give the OS event + debounce + parse + lock-acquire chain plenty of
//! slack on a loaded CI box.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};
use tempfile::TempDir;

const WATCH_SETTLE_MS: u64 = 800;

fn frame(value: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(value).expect("serialize frame");
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(&body);
    out
}

fn read_frame(reader: &mut impl BufRead) -> Value {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).expect("read header line");
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, val)) = trimmed.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                content_length = val.trim().parse().ok();
            }
        }
    }
    let len = content_length.expect("missing Content-Length header");
    let mut body = vec![0u8; len];
    std::io::Read::read_exact(reader, &mut body).expect("read body");
    serde_json::from_slice(&body).expect("parse JSON response")
}

/// Read frames until we see one that is a JSON-RPC response (no `method`).
/// The plugin emits `config.subscribe` as an outbound request after
/// `initialize` — we skip those when waiting for our own replies.
fn read_response(reader: &mut impl BufRead) -> Value {
    loop {
        let frame = read_frame(reader);
        if frame.get("method").is_some() {
            continue;
        }
        return frame;
    }
}

fn bin_path() -> String {
    env!("CARGO_BIN_EXE_memory-manager").to_string()
}

#[test]
fn min_consolidate_len_live_reload_lets_short_message_through() {
    let synaps_base = TempDir::new().expect("synaps base dir");
    let tmp_brain = TempDir::new().expect("brain dir");
    let brain_path = tmp_brain.path().join("test.r8");

    // The plugin reads / watches:
    //   $SYNAPS_BASE_DIR/plugins/axel-memory-manager/config
    let config_dir = synaps_base
        .path()
        .join("plugins")
        .join("axel-memory-manager");
    std::fs::create_dir_all(&config_dir).expect("create config dir");
    let config_path = config_dir.join("config");

    // Seed the config file BEFORE spawn so the plugin loads
    // min_consolidate_len = 100 at startup. This is well above axel's own
    // 50-char minimum on `remember(...)`, so a 60-char message is gated by
    // *our* threshold, not axel's. After the live-reload step we drop the
    // threshold to 50 — the same 60-char message must then land.
    std::fs::write(&config_path, "min_consolidate_len = \"100\"\n").unwrap();

    let mut child = Command::new(bin_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .env("AXEL_BRAIN", &brain_path)
        .env("SYNAPS_BASE_DIR", synaps_base.path())
        .spawn()
        .expect("spawn memory-manager");

    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(stdout);

    // Initialize.
    stdin
        .write_all(&frame(&json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {}
        })))
        .unwrap();
    stdin.flush().unwrap();
    let init = read_response(&mut reader);
    assert_eq!(init["result"]["name"], "memory-manager", "init resp: {init}");

    // A 60-character message: above axel's 50-char floor on `remember`,
    // below our 100 startup threshold.
    let mid = "this message is exactly sixty characters long for the test!!";
    assert_eq!(mid.len(), 60, "test fixture must be 60 chars");

    // Step 1: send under threshold=100 — must NOT be persisted.
    stdin
        .write_all(&frame(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "hook.handle",
            "params": {
                "kind": "on_message_complete",
                "message": mid,
                "data": null
            }
        })))
        .unwrap();
    stdin.flush().unwrap();
    let resp = read_response(&mut reader);
    assert_eq!(resp["result"]["action"], "continue", "{resp}");

    // Step 2: live-reload threshold to 50 via tmp+rename (atomic write —
    // matches the host's write_plugin_config_to pattern).
    let tmp_cfg = config_path.with_extension("tmp");
    std::fs::write(&tmp_cfg, "min_consolidate_len = \"50\"\n").unwrap();
    std::fs::rename(&tmp_cfg, &config_path).unwrap();

    // Wait for the notify event + 150ms debounce + lock acquire.
    std::thread::sleep(Duration::from_millis(WATCH_SETTLE_MS));

    // Step 3: re-send the SAME 60-char message. With threshold=50, both
    // gates (ours and axel's) admit it — exactly one row should land.
    stdin
        .write_all(&frame(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "hook.handle",
            "params": {
                "kind": "on_message_complete",
                "message": mid,
                "data": null
            }
        })))
        .unwrap();
    stdin.flush().unwrap();
    let resp = read_response(&mut reader);
    assert_eq!(resp["result"]["action"], "continue", "{resp}");

    // Graceful shutdown so SQLite WAL flushes.
    stdin
        .write_all(&frame(&json!({
            "jsonrpc": "2.0",
            "id": 99,
            "method": "shutdown",
            "params": {}
        })))
        .unwrap();
    stdin.flush().unwrap();
    child.wait().expect("wait shutdown");

    // Assert exactly one memory row exists — the second send, after the
    // live-reload lowered the threshold from 100 to 50.
    let db = rusqlite::Connection::open(&brain_path).expect("open brain");
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
        .expect("count memories");
    assert_eq!(
        count, 1,
        "expected exactly 1 memory row after live-reload (the second send); got {count}"
    );

    let stored: String = db
        .query_row("SELECT content FROM memories LIMIT 1", [], |row| row.get(0))
        .expect("read memory content");
    assert_eq!(stored, mid, "stored memory should be the 60-char message");
}
