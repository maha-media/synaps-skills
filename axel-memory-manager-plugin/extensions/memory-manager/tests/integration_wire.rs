//! Integration tests that drive the compiled `memory-manager` binary over its
//! JSON-RPC stdio wire protocol.
//!
//! Tests use a temp-dir brain so they never touch the real `~/.config/axel/axel.r8`.
//!
//! Sub-test (b) — `before_message_returns_inject` — exercises `contextual_recall`,
//! which loads the ONNX embedding model on first call (~86 MB).  Because the
//! models are cached in `~/.cache/velocirag/` after the first run, this is fast
//! on a development machine but would add ~1 min on a fresh CI runner with no
//! cache.  The test is therefore marked `#[ignore]` so that `cargo test` skips
//! it by default and CI can opt-in with `cargo test -- --ignored`.
//! Sub-test (a) (`on_message_complete_writes_memory`) does NOT need embeddings
//! and is the hard requirement for Phase 1.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::{json, Value};
use tempfile::TempDir;

// ── wire helpers ──────────────────────────────────────────────────────────────

/// Encode a JSON value as a Content-Length-framed LSP message (matches
/// `write_frame` in src/main.rs).
fn frame(value: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(value).expect("serialize frame");
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(&body);
    out
}

/// Consume one Content-Length-framed JSON-RPC response (mirrors `read_frame` in
/// src/main.rs).
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

/// Read frames until we see a JSON-RPC *response* (one with `result` or
/// `error`, not `method`). Plugin-emitted requests like the post-initialize
/// `config.subscribe` are skipped.
fn read_response(reader: &mut impl BufRead) -> Value {
    loop {
        let frame = read_frame(reader);
        if frame.get("method").is_some() {
            // Plugin-originated request (e.g. config.subscribe). Ignore.
            continue;
        }
        return frame;
    }
}

// ── binary path ───────────────────────────────────────────────────────────────

fn bin_path() -> String {
    // CARGO_BIN_EXE_memory-manager is set by cargo when running integration tests.
    env!("CARGO_BIN_EXE_memory-manager").to_string()
}

// ── helpers ───────────────────────────────────────────────────────────────────

/// Spawn the binary, send `initialize`, drain its response, and return the
/// process handles plus the reader.
fn spawn_and_init(
    brain_path: &std::path::Path,
) -> (
    std::process::ChildStdin,
    BufReader<std::process::ChildStdout>,
    std::process::Child,
) {
    let mut child = Command::new(bin_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .env("AXEL_BRAIN", brain_path)
        .spawn()
        .expect("spawn memory-manager binary");

    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(stdout);

    stdin
        .write_all(&frame(&json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {}
        })))
        .expect("write initialize");
    stdin.flush().expect("flush");

    let resp = read_response(&mut reader);
    assert_eq!(resp["result"]["name"], "memory-manager", "bad initialize response: {resp}");

    (stdin, reader, child)
}

// ── sub-test (a): on_message_complete writes a memory row ────────────────────

/// Verify that a long-enough `on_message_complete` message (≥ 80 chars) is
/// persisted to the SQLite brain.  This does NOT require the ONNX embedding
/// model and must always pass.
#[test]
fn on_message_complete_writes_memory() {
    let tmp = TempDir::new().expect("temp dir");
    let brain_path = tmp.path().join("test.r8");

    let (mut stdin, mut reader, mut child) = spawn_and_init(&brain_path);

    // Send on_message_complete with a message ≥ min_consolidate_len (80 chars).
    let msg = "Rust's ownership system ensures memory safety without a garbage \
               collector by enforcing borrow rules at compile time.";
    assert!(msg.len() >= 80, "message must be ≥ 80 chars for this test to be meaningful");

    stdin
        .write_all(&frame(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "hook.handle",
            "params": {
                "kind": "on_message_complete",
                "message": msg,
                "data": null
            }
        })))
        .expect("write hook frame");
    stdin.flush().expect("flush");

    let resp = read_response(&mut reader);
    assert_eq!(resp["result"]["action"], "continue", "unexpected hook result: {resp}");

    // Graceful shutdown so the brain flushes WAL to the main .r8 file.
    stdin
        .write_all(&frame(&json!({
            "jsonrpc": "2.0",
            "id": 99,
            "method": "shutdown",
            "params": {}
        })))
        .expect("write shutdown");
    stdin.flush().expect("flush");
    child.wait().expect("wait for shutdown");

    // Open the SQLite file and assert at least one memory row was written.
    let db = rusqlite::Connection::open(&brain_path)
        .expect("open brain SQLite");
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))
        .expect("SELECT COUNT(*) FROM memories");
    assert!(count > 0, "expected at least 1 memory row; got {count}");
}

// ── sub-test (b): before_message returns inject after seeding a memory ────────
//
// IGNORED by default because `contextual_recall` loads the ONNX embedding model
// (~86 MB) on first use.  On a developer machine with a warm `~/.cache/velocirag/`
// cache this is fast (~0.5 s).  On a fresh CI runner it may take several minutes
// to download.  Run manually with:
//
//   cargo test --test integration_wire -- --ignored --nocapture \
//       --manifest-path axel-memory-manager-plugin/extensions/memory-manager/Cargo.toml
//
// If the env var AXEL_BRAIN_SKIP_EMBED_TEST=1 is set, the test is still ignored
// (the #[ignore] attribute already handles that).

#[test]
#[ignore = "requires ONNX embedding model; run manually with --ignored after prewarm"]
fn before_message_returns_inject() {
    let tmp = TempDir::new().expect("temp dir");
    let brain_path = tmp.path().join("test.r8");

    // Step 1: plant a memory via on_message_complete.
    let (mut stdin, mut reader, mut child) = spawn_and_init(&brain_path);

    let msg = "Rust's ownership system ensures memory safety without a garbage \
               collector by enforcing borrow rules at compile time.";

    stdin
        .write_all(&frame(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "hook.handle",
            "params": {
                "kind": "on_message_complete",
                "message": msg,
                "data": null
            }
        })))
        .expect("write on_message_complete");
    stdin.flush().expect("flush");
    let _ = read_response(&mut reader); // discard continue

    // Step 2: send before_message and expect inject.
    stdin
        .write_all(&frame(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "hook.handle",
            "params": {
                "kind": "before_message",
                "message": "Tell me about Rust's ownership model"
            }
        })))
        .expect("write before_message");
    stdin.flush().expect("flush");
    let resp = read_response(&mut reader);

    // Shutdown cleanly.
    stdin
        .write_all(&frame(&json!({
            "jsonrpc": "2.0",
            "id": 99,
            "method": "shutdown",
            "params": {}
        })))
        .expect("write shutdown");
    stdin.flush().ok();
    child.wait().ok();

    let action = resp["result"]["action"]
        .as_str()
        .unwrap_or("missing");
    assert_eq!(action, "inject",
        "expected action:inject but got {action}; full response: {resp}");

    let content = resp["result"]["content"].as_str().unwrap_or("");
    assert!(!content.is_empty(), "inject content must be non-empty; response: {resp}");
}
