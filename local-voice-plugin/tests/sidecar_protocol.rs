use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

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

    // Host contract (SynapsCLI/src/sidecar/manager.rs): the host waits for the
    // sidecar's `hello` frame BEFORE sending `init`. The sidecar must therefore
    // announce itself unprompted on startup.
    let hello = next_event(&mut stdout);
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["protocol_version"], 2);
    assert_eq!(hello["extension"], "local-voice");

    // Only after Hello does the host send Init.
    writeln!(stdin, r#"{{"type":"init","config":{{"protocol_version":2}}}}"#).unwrap();
    let ready = next_event(&mut stdout);
    assert_eq!(ready["type"], "status");
    assert_eq!(ready["state"], "ready");

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

/// Regression test for the host-deadlock bug: the host (SynapsCLI) waits up to
/// 10 s for `hello` BEFORE sending any input. If the sidecar only emits `hello`
/// after receiving `init`, both sides deadlock and the host gives up with
/// "sidecar did not send Hello within 10s". This test asserts that the sidecar
/// emits `hello` unprompted within a small budget, with no stdin written.
#[test]
fn emits_hello_unprompted_on_startup() {
    let exe = env!("CARGO_BIN_EXE_synaps-voice-plugin");
    let mut child = Command::new(exe)
        .arg("--mock-transcript")
        .arg("unused")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn sidecar");

    // Deliberately do NOT write to stdin. The sidecar must speak first.
    let stdout = child.stdout.take().expect("sidecar stdout");

    // Read the first line in a worker thread so the test can enforce a
    // wall-clock budget instead of hanging when the sidecar deadlocks.
    let (tx, rx) = mpsc::channel::<std::io::Result<String>>();
    let started = Instant::now();
    let reader = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let res = reader.read_line(&mut line).map(|_| line);
        let _ = tx.send(res);
    });

    let line = match rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(line)) => line,
        Ok(Err(err)) => {
            let _ = child.kill();
            let _ = reader.join();
            panic!("sidecar stdout read failed: {err}");
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // Kill the child so the reader thread unblocks and joins.
            let _ = child.kill();
            let _ = reader.join();
            panic!(
                "sidecar did not emit hello within 2s (host gives up at 10s) — \
                 handshake deadlock: sidecar is waiting for init before emitting hello"
            );
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = child.kill();
            let _ = reader.join();
            panic!("reader thread disconnected before sending a result");
        }
    };
    let elapsed = started.elapsed();
    let _ = reader.join();

    let frame: Value =
        serde_json::from_str(line.trim()).expect("hello must be valid JSON");
    assert_eq!(frame["type"], "hello", "first frame must be hello, got {line}");
    assert_eq!(frame["protocol_version"], 2);
    assert_eq!(frame["extension"], "local-voice");
    assert!(
        elapsed < Duration::from_secs(2),
        "sidecar took {elapsed:?} to emit hello (host gives up at 10s)"
    );

    // Tear down cleanly.
    let mut stdin = child.stdin.take().expect("stdin still owned");
    writeln!(stdin, r#"{{"type":"shutdown"}}"#).ok();
    drop(stdin);
    let _ = child.wait();
}
