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

    writeln!(stdin, r#"{{"type":"init","config":{{"mode":"dictation","language":null,"protocol_version":1}}}}"#).unwrap();
    assert_eq!(next_event(&mut stdout)["type"], "hello");
    assert_eq!(next_event(&mut stdout)["type"], "status");

    writeln!(stdin, r#"{{"type":"voice_control_pressed"}}"#).unwrap();
    assert_eq!(next_event(&mut stdout)["type"], "listening_started");

    writeln!(stdin, r#"{{"type":"voice_control_released"}}"#).unwrap();
    assert_eq!(next_event(&mut stdout)["type"], "listening_stopped");
    assert_eq!(next_event(&mut stdout)["type"], "transcribing_started");
    let final_transcript = next_event(&mut stdout);
    assert_eq!(final_transcript["type"], "final_transcript");
    assert_eq!(final_transcript["text"], "hello from smoke");

    writeln!(stdin, r#"{{"type":"shutdown"}}"#).unwrap();
    drop(stdin);
    let status = child.wait().expect("wait for sidecar");
    assert!(status.success(), "sidecar exited with {status}");
}
