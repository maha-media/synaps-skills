//! End-to-end integration test for the heuristic enrichment path.
//!
//! Spawns the compiled `memory-manager` binary with `enrichment_trigger =
//! on_complete` and `gliner_enabled = off` (the heuristic-only path — no
//! ML model download required, which keeps this test runnable in offline
//! sandboxes), drives it with an `on_message_complete` whose content
//! triggers multiple heuristic signals (Rust code fence, file paths,
//! hashtag, importance keyword), then opens the resulting SQLite brain
//! file and asserts the persisted row reflects the enrichment.
//!
//! This exercises Track A's `remember_full` path end-to-end without
//! requiring the GLiNER model.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::{json, Value};
use tempfile::TempDir;

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
    let len = content_length.expect("missing Content-Length");
    let mut body = vec![0u8; len];
    std::io::Read::read_exact(reader, &mut body).expect("read body");
    serde_json::from_slice(&body).expect("parse body")
}

fn read_response(reader: &mut impl BufRead) -> Value {
    loop {
        let f = read_frame(reader);
        if f.get("method").is_some() {
            continue;
        }
        return f;
    }
}

fn bin_path() -> String {
    env!("CARGO_BIN_EXE_memory-manager").to_string()
}

#[test]
fn on_message_complete_enriches_via_remember_full() {
    let tmp = TempDir::new().expect("temp dir");
    let brain_path = tmp.path().join("test.r8");

    // Synaps writes a per-plugin `config` file as plain `key = value` lines.
    // Mirror that on disk so the plugin loads the test's settings instead of
    // the user's real $HOME config. `AXEL_SETTINGS_PATH` points the plugin
    // straight at the test file (see settings::config_path).
    let cfg_path = tmp.path().join("config");
    std::fs::write(
        &cfg_path,
        "min_consolidate_len = 40\n\
         enrichment_trigger = on_complete\n\
         gliner_enabled = off\n",
    )
    .expect("write config");

    let mut child = Command::new(bin_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .env("AXEL_BRAIN", &brain_path)
        .env("AXEL_SETTINGS_PATH", &cfg_path)
        .spawn()
        .expect("spawn");

    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(stdout);

    // initialize
    stdin
        .write_all(&frame(&json!({
            "jsonrpc": "2.0", "id": 0,
            "method": "initialize", "params": {}
        })))
        .unwrap();
    stdin.flush().unwrap();
    let init = read_response(&mut reader);
    assert_eq!(init["result"]["name"], "memory-manager");

    // on_message_complete with rust code fence + file path + hashtag.
    let msg = "Today I learned that Rust's Arc<Mutex<T>> can deadlock when held \
               across an await point. See src/main.rs for the fix. \
               ```rust\nlet x = a.lock();\n``` \
               #rustlang Important to remember!";

    stdin
        .write_all(&frame(&json!({
            "jsonrpc": "2.0", "id": 1,
            "method": "hook.handle",
            "params": {
                "kind": "on_message_complete",
                "message": msg,
                "data": null
            }
        })))
        .unwrap();
    stdin.flush().unwrap();
    let resp = read_response(&mut reader);
    assert_eq!(resp["result"]["action"], "continue");

    // Shutdown so the WAL flushes.
    stdin
        .write_all(&frame(&json!({
            "jsonrpc": "2.0", "id": 99,
            "method": "shutdown", "params": {}
        })))
        .unwrap();
    stdin.flush().unwrap();
    child.wait().expect("wait child");

    // Now open the SQLite directly and inspect.
    let db = rusqlite::Connection::open(&brain_path).expect("open .r8");
    let (category, tags_json, title, importance): (String, String, String, f64) = db
        .query_row(
            "SELECT category, tags, title, importance FROM memories LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("SELECT memories row");

    eprintln!("test: row category={category} tags={tags_json} title={title} importance={importance}");

    // Heuristic effects we expect to see persisted via remember_full:
    // - tags is a JSON array string containing at least "rust" (from code
    //   fence) and "rs" (from src/main.rs path) and "rustlang" (hashtag).
    assert!(tags_json.contains("\"rust\""), "tags missing 'rust': {tags_json}");
    assert!(tags_json.contains("\"rs\""),   "tags missing 'rs': {tags_json}");
    assert!(tags_json.contains("\"rustlang\""), "tags missing 'rustlang': {tags_json}");

    // - importance bumped from default 0.5 by "important"/"remember" keyword.
    assert!(importance > 0.5, "importance not bumped: {importance}");

    // - category should be a known taxonomy value (lowercase per serde tag).
    assert!(
        matches!(category.as_str(), "events" | "preferences" | "entities" | "cases" | "patterns"),
        "unknown category: {category}"
    );

    // - title is the first line, capped at 80 chars.
    assert!(!title.is_empty(), "title is empty");
    assert!(title.chars().count() <= 80, "title too long: {title}");
}
