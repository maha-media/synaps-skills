//! Integration tests for Phase 2/3 `command.invoke` and task notifications.

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
        .env_remove("SYNAPS_VOICE_REAL_TASKS")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn plugin rpc");
    let stdin = child.stdin.take().expect("plugin stdin");
    let stdout = BufReader::new(child.stdout.take().expect("plugin stdout"));
    (child, stdin, stdout)
}

fn drain_until_response(
    stdout: &mut BufReader<std::process::ChildStdout>,
    response_id: i64,
) -> (Vec<Value>, Value) {
    let mut notifs = Vec::new();
    loop {
        let frame = next_frame(stdout);
        if frame.get("id").and_then(Value::as_i64) == Some(response_id) {
            return (notifs, frame);
        }
        // Notifications have a method but no id.
        notifs.push(frame);
    }
}

#[test]
fn initialize_advertises_command_capabilities() {
    let (mut child, mut stdin, mut stdout) = spawn();
    write_frame(
        &mut stdin,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"extension_protocol_version":1}}),
    );
    let init = next_frame(&mut stdout);
    assert_eq!(init["result"]["protocol_version"], 1);
    let caps = &init["result"]["capabilities"];
    assert_eq!(caps["tools"], serde_json::json!([]));
    assert_eq!(caps["commands"], serde_json::json!(["voice"]));
    assert_eq!(caps["tasks"], serde_json::json!(true));

    write_frame(&mut stdin, serde_json::json!({"jsonrpc":"2.0","id":2,"method":"shutdown","params":null}));
    let _ = next_frame(&mut stdout);
    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success());
}

#[test]
fn voice_help_streams_then_responds() {
    let (mut child, mut stdin, mut stdout) = spawn();
    write_frame(
        &mut stdin,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
    );
    let _init = next_frame(&mut stdout);

    write_frame(
        &mut stdin,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"command.invoke",
            "params": {"command": "voice", "args": ["help"], "request_id": "req-help"}
        }),
    );

    let (notifs, response) = drain_until_response(&mut stdout, 2);
    assert!(!notifs.is_empty(), "expected at least one notification");
    for n in &notifs {
        assert_eq!(n["method"], "command.output");
        assert_eq!(n["params"]["request_id"], "req-help");
    }
    assert_eq!(notifs.last().unwrap()["params"]["event"]["kind"], "done");
    assert_eq!(response["result"], serde_json::json!({"ok": true}));

    write_frame(&mut stdin, serde_json::json!({"jsonrpc":"2.0","id":3,"method":"shutdown","params":null}));
    let _ = next_frame(&mut stdout);
    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success());
}

#[test]
fn voice_models_streams_table() {
    let (mut child, mut stdin, mut stdout) = spawn();
    write_frame(&mut stdin, serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}));
    let _ = next_frame(&mut stdout);

    write_frame(
        &mut stdin,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"command.invoke",
            "params": {"command": "voice", "args": ["models"], "request_id": 42}
        }),
    );
    let (notifs, response) = drain_until_response(&mut stdout, 2);
    let kinds: Vec<&str> = notifs.iter()
        .map(|v| v["params"]["event"]["kind"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(kinds, vec!["table", "done"]);
    assert_eq!(response["result"]["ok"], true);
    assert!(response["result"]["models"].is_array());

    write_frame(&mut stdin, serde_json::json!({"jsonrpc":"2.0","id":3,"method":"shutdown","params":null}));
    let _ = next_frame(&mut stdout);
    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success());
}

#[test]
fn voice_download_emits_task_notifications() {
    let (mut child, mut stdin, mut stdout) = spawn();
    write_frame(&mut stdin, serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}));
    let _ = next_frame(&mut stdout);

    write_frame(
        &mut stdin,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"command.invoke",
            "params": {
                "command": "voice",
                "args": ["download", "ggml-tiny.en.bin"],
                "request_id": "dl-1"
            }
        }),
    );
    let (notifs, response) = drain_until_response(&mut stdout, 2);
    let methods: Vec<&str> = notifs.iter().map(|v| v["method"].as_str().unwrap_or("")).collect();
    assert_eq!(methods.first().copied(), Some("task.start"));
    assert!(methods.iter().any(|m| *m == "task.update"), "{methods:?}");
    assert!(methods.iter().any(|m| *m == "task.log"), "{methods:?}");
    assert!(methods.iter().any(|m| *m == "task.done"), "{methods:?}");
    // command.output stream should also reach `done`.
    assert_eq!(methods.last().copied(), Some("command.output"));
    let last = notifs.last().unwrap();
    assert_eq!(last["params"]["event"]["kind"], "done");
    // All notifications carry the same request_id.
    for n in &notifs {
        assert_eq!(n["params"]["request_id"], serde_json::json!("dl-1"));
    }
    assert_eq!(response["result"]["ok"], true);
    assert_eq!(response["result"]["mock"], true);

    write_frame(&mut stdin, serde_json::json!({"jsonrpc":"2.0","id":3,"method":"shutdown","params":null}));
    let _ = next_frame(&mut stdout);
    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success());
}

#[test]
fn voice_rebuild_unknown_backend_replies_error() {
    let (mut child, mut stdin, mut stdout) = spawn();
    write_frame(&mut stdin, serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}));
    let _ = next_frame(&mut stdout);

    write_frame(
        &mut stdin,
        serde_json::json!({
            "jsonrpc":"2.0","id":2,"method":"command.invoke",
            "params": {"command":"voice","args":["rebuild","wat"],"request_id":"rb-1"}
        }),
    );
    let (_notifs, response) = drain_until_response(&mut stdout, 2);
    assert_eq!(response["result"]["ok"], false);

    write_frame(&mut stdin, serde_json::json!({"jsonrpc":"2.0","id":3,"method":"shutdown","params":null}));
    let _ = next_frame(&mut stdout);
    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success());
}
