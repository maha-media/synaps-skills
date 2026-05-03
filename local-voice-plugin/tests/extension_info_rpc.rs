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

#[test]
fn info_get_reports_build_capabilities_and_models() {
    let exe = env!("CARGO_BIN_EXE_synaps-voice-plugin");
    let mut child = Command::new(exe)
        .arg("--extension-rpc")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn plugin rpc");

    let mut stdin = child.stdin.take().expect("plugin stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("plugin stdout"));

    write_frame(
        &mut stdin,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"extension_protocol_version":1}}),
    );
    let init = next_frame(&mut stdout);
    assert_eq!(init["result"]["protocol_version"], 1);

    write_frame(
        &mut stdin,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"info.get","params":null}),
    );
    let info = next_frame(&mut stdout);
    let result = &info["result"];
    assert!(result["build"]["backend"].as_str().is_some());
    assert!(result["build"]["features"].as_array().unwrap().len() >= 1);
    assert_eq!(result["capabilities"][0]["kind"], "voice");
    assert_eq!(result["capabilities"][0]["modes"], serde_json::json!(["stt"]));
    assert_eq!(result["models"][0]["id"], "ggml-tiny.en.bin");

    write_frame(
        &mut stdin,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"shutdown","params":null}),
    );
    let _ = next_frame(&mut stdout);
    drop(stdin);
    let status = child.wait().expect("wait for plugin rpc");
    assert!(status.success(), "plugin exited with {status}");
}
