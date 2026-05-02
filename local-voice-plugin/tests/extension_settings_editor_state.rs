//! Stateful settings editor + commit-aware behavior for the local-voice plugin.
//!
//! `settings.editor.open` opens a session and returns the initial render
//! (cursor=0). `settings.editor.key` mutates the cursor and re-renders.
//! `settings.editor.commit` resolves the currently-selected (or
//! caller-supplied) `data` payload into a structured intent that core can
//! act on without re-parsing strings:
//!   - `model:<id>`     → `{kind:"select",   model_id, config_key, model_path}`
//!   - `download:<id>`  → `{kind:"download", model_id, command, args}`

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

fn next_frame(stdout: &mut BufReader<ChildStdout>) -> Value {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        let n = stdout.read_line(&mut line).expect("read header");
        assert!(n > 0, "plugin stdout ended unexpectedly");
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = Some(value.trim().parse::<usize>().expect("len"));
            }
        }
    }
    let len = content_length.expect("Content-Length");
    let mut body = vec![0; len];
    stdout.read_exact(&mut body).expect("body");
    serde_json::from_slice(&body).expect("json")
}

fn write_frame(stdin: &mut ChildStdin, payload: Value) {
    let body = serde_json::to_vec(&payload).unwrap();
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
    stdin.write_all(&body).unwrap();
    stdin.flush().unwrap();
}

fn spawn() -> (Child, ChildStdin, BufReader<ChildStdout>) {
    let exe = env!("CARGO_BIN_EXE_synaps-voice-plugin");
    let mut child = Command::new(exe)
        .arg("--extension-rpc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn");
    let stdin = child.stdin.take().unwrap();
    let stdout = BufReader::new(child.stdout.take().unwrap());
    (child, stdin, stdout)
}

fn shutdown(mut child: Child, mut stdin: ChildStdin, mut stdout: BufReader<ChildStdout>, last_id: i64) {
    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":last_id,"method":"shutdown","params":null}),
    );
    let _ = next_frame(&mut stdout);
    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success());
}

#[test]
fn key_down_moves_cursor_and_rerenders() {
    let (child, mut stdin, mut stdout) = spawn();
    write_frame(&mut stdin, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}));
    let _ = next_frame(&mut stdout);

    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":2,"method":"settings.editor.open",
               "params":{"category":"voice","field":"model_path"}}),
    );
    let open = next_frame(&mut stdout);
    assert_eq!(open["result"]["render"]["cursor"], 0);

    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":3,"method":"settings.editor.key",
               "params":{"category":"voice","field":"model_path","key":"Down"}}),
    );
    let r1 = next_frame(&mut stdout);
    assert_eq!(r1["result"]["render"]["cursor"], 1);

    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":4,"method":"settings.editor.key",
               "params":{"category":"voice","field":"model_path","key":"Down"}}),
    );
    let r2 = next_frame(&mut stdout);
    assert_eq!(r2["result"]["render"]["cursor"], 2);

    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":5,"method":"settings.editor.key",
               "params":{"category":"voice","field":"model_path","key":"Up"}}),
    );
    let r3 = next_frame(&mut stdout);
    assert_eq!(r3["result"]["render"]["cursor"], 1);

    // Re-render must include the same rows.
    let rows = r3["result"]["render"]["rows"].as_array().unwrap();
    assert!(rows.len() >= 4);

    shutdown(child, stdin, stdout, 99);
}

#[test]
fn key_up_clamps_at_top_and_down_clamps_at_bottom() {
    let (child, mut stdin, mut stdout) = spawn();
    write_frame(&mut stdin, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}));
    let _ = next_frame(&mut stdout);
    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":2,"method":"settings.editor.open",
               "params":{"category":"voice","field":"model_path"}}),
    );
    let _ = next_frame(&mut stdout);

    // Up at top stays at 0.
    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":3,"method":"settings.editor.key",
               "params":{"category":"voice","field":"model_path","key":"Up"}}),
    );
    let r = next_frame(&mut stdout);
    assert_eq!(r["result"]["render"]["cursor"], 0);

    // Down many times — clamps at last row index.
    let mut last_cursor = 0u64;
    for id in 10..30 {
        write_frame(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":id,"method":"settings.editor.key",
                   "params":{"category":"voice","field":"model_path","key":"Down"}}),
        );
        let r = next_frame(&mut stdout);
        last_cursor = r["result"]["render"]["cursor"].as_u64().unwrap();
    }
    let rows_len = r["result"]["render"]["rows"].as_array().unwrap().len() as u64;
    // After many Downs, cursor should be at last index regardless of starting state.
    let _ = rows_len; // not used for an explicit equality (rows_len from earlier render is fine)
    // Re-open to query rows length cleanly.
    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":50,"method":"settings.editor.open",
               "params":{"category":"voice","field":"model_path"}}),
    );
    let opened = next_frame(&mut stdout);
    let n = opened["result"]["render"]["rows"].as_array().unwrap().len() as u64;
    assert_eq!(last_cursor, n - 1, "cursor should clamp to last row");

    shutdown(child, stdin, stdout, 99);
}

#[test]
fn open_resets_cursor() {
    let (child, mut stdin, mut stdout) = spawn();
    write_frame(&mut stdin, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}));
    let _ = next_frame(&mut stdout);
    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":2,"method":"settings.editor.open",
               "params":{"category":"voice","field":"model_path"}}),
    );
    let _ = next_frame(&mut stdout);
    for id in 3..6 {
        write_frame(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":id,"method":"settings.editor.key",
                   "params":{"category":"voice","field":"model_path","key":"Down"}}),
        );
        let _ = next_frame(&mut stdout);
    }
    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":7,"method":"settings.editor.open",
               "params":{"category":"voice","field":"model_path"}}),
    );
    let reopen = next_frame(&mut stdout);
    assert_eq!(reopen["result"]["render"]["cursor"], 0);

    shutdown(child, stdin, stdout, 99);
}

#[test]
fn commit_uses_tracked_cursor_when_value_omitted() {
    let (child, mut stdin, mut stdout) = spawn();
    write_frame(&mut stdin, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}));
    let _ = next_frame(&mut stdout);
    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":2,"method":"settings.editor.open",
               "params":{"category":"voice","field":"model_path"}}),
    );
    let open = next_frame(&mut stdout);
    let rows = open["result"]["render"]["rows"].as_array().unwrap().clone();
    // Move cursor to row 2.
    for id in 3..5 {
        write_frame(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":id,"method":"settings.editor.key",
                   "params":{"category":"voice","field":"model_path","key":"Down"}}),
        );
        let _ = next_frame(&mut stdout);
    }
    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":6,"method":"settings.editor.commit",
               "params":{"category":"voice","field":"model_path"}}),
    );
    let commit = next_frame(&mut stdout);
    let result = &commit["result"];
    assert_eq!(result["ok"], true);
    let expected_data = rows[2]["data"].as_str().unwrap();
    assert_eq!(result["value"], json!(expected_data));
    let intent = &result["intent"];
    let kind = intent["kind"].as_str().unwrap();
    assert!(kind == "download" || kind == "select");
    assert!(intent["model_id"].as_str().is_some());

    shutdown(child, stdin, stdout, 99);
}

#[test]
fn commit_select_returns_config_ready_model_path() {
    let (child, mut stdin, mut stdout) = spawn();
    write_frame(&mut stdin, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}));
    let _ = next_frame(&mut stdout);
    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":2,"method":"settings.editor.open",
               "params":{"category":"voice","field":"model_path"}}),
    );
    let _ = next_frame(&mut stdout);

    // Force a select intent regardless of installed flag by passing a value.
    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":3,"method":"settings.editor.commit",
               "params":{"category":"voice","field":"model_path","value":"model:ggml-base.en.bin"}}),
    );
    let commit = next_frame(&mut stdout);
    let intent = &commit["result"]["intent"];
    assert_eq!(intent["kind"], "select");
    assert_eq!(intent["model_id"], "ggml-base.en.bin");
    assert_eq!(intent["config_key"], "local-voice.model_path");
    assert!(intent["model_path"].as_str().unwrap().ends_with("ggml-base.en.bin"));

    shutdown(child, stdin, stdout, 99);
}

#[test]
fn commit_download_exposes_voice_command_args() {
    let (child, mut stdin, mut stdout) = spawn();
    write_frame(&mut stdin, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}));
    let _ = next_frame(&mut stdout);
    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":2,"method":"settings.editor.open",
               "params":{"category":"voice","field":"model_path"}}),
    );
    let _ = next_frame(&mut stdout);

    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":3,"method":"settings.editor.commit",
               "params":{"category":"voice","field":"model_path","value":"download:ggml-small.en.bin"}}),
    );
    let commit = next_frame(&mut stdout);
    let intent = &commit["result"]["intent"];
    assert_eq!(intent["kind"], "download");
    assert_eq!(intent["model_id"], "ggml-small.en.bin");
    assert_eq!(intent["command"], "voice");
    assert_eq!(intent["args"], json!(["download", "ggml-small.en.bin"]));

    shutdown(child, stdin, stdout, 99);
}

#[test]
fn commit_unknown_model_id_is_error() {
    let (child, mut stdin, mut stdout) = spawn();
    write_frame(&mut stdin, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}));
    let _ = next_frame(&mut stdout);
    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":2,"method":"settings.editor.open",
               "params":{"category":"voice","field":"model_path"}}),
    );
    let _ = next_frame(&mut stdout);

    write_frame(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":3,"method":"settings.editor.commit",
               "params":{"category":"voice","field":"model_path","value":"model:not-a-model"}}),
    );
    let commit = next_frame(&mut stdout);
    assert_eq!(commit["result"]["ok"], false);
    assert!(commit["result"]["error"].as_str().is_some());

    shutdown(child, stdin, stdout, 99);
}
