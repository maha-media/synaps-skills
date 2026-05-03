use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::Value;

fn next_event(stdout: &mut BufReader<std::process::ChildStdout>) -> Value {
    let mut line = String::new();
    stdout.read_line(&mut line).expect("read sidecar stdout");
    assert!(!line.trim().is_empty(), "sidecar stdout ended unexpectedly");
    serde_json::from_str(line.trim()).expect("sidecar emitted valid JSON")
}

#[test]
fn mock_sidecar_protocol_smoke() {
    let exe = env!("CARGO_BIN_EXE_synaps-voice-plugin");
    let mut child = Command::new(exe)
        .arg("--mock-transcript")
        .arg("hello from smoke")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn sidecar");

    let mut stdin = child.stdin.take().expect("sidecar stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("sidecar stdout"));

    writeln!(stdin, r#"{{"type":"init","config":{{"protocol_version":2}}}}"#).unwrap();
    let hello = next_event(&mut stdout);
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["protocol_version"], 2);
    assert_eq!(hello["extension"], "local-voice");
    assert_eq!(next_event(&mut stdout)["type"], "status");

    writeln!(stdin, r#"{{"type":"trigger","name":"press"}}"#).unwrap();
    let active = next_event(&mut stdout);
    assert_eq!(active["type"], "status");
    assert_eq!(active["state"], "listening");

    writeln!(stdin, r#"{{"type":"trigger","name":"release"}}"#).unwrap();
    let stopped = next_event(&mut stdout);
    assert_eq!(stopped["type"], "status");
    assert_eq!(stopped["state"], "stopped");
    let processing = next_event(&mut stdout);
    assert_eq!(processing["type"], "status");
    assert_eq!(processing["state"], "processing");
    let insert_text = next_event(&mut stdout);
    assert_eq!(insert_text["type"], "insert_text");
    assert_eq!(insert_text["mode"], "final");
    assert_eq!(insert_text["text"], "hello from smoke");

    writeln!(stdin, r#"{{"type":"shutdown"}}"#).unwrap();
    drop(stdin);
    let status = child.wait().expect("wait for sidecar");
    assert!(status.success(), "sidecar exited with {status}");
}
