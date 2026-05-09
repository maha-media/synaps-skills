//! Integration tests for the Phase 2 background consolidation timer.
//!
//! These tests spawn the compiled `memory-manager` binary in a sandboxed
//! `$SYNAPS_BASE_DIR` (mirroring `tests/settings_roundtrip.rs`) and use the
//! `AXEL_ALLOW_ANY_INTERVAL=1` test-only env var to opt the integer-allowlist
//! gate out so we can use 1-second tick intervals.
//!
//! Assertions are stderr-based: every timer firing logs
//! `axel: bg consolidate:` to stderr. We capture the child's stderr into a
//! shared buffer via a reader thread and grep that buffer.
//!
//! Why stderr-based rather than DB-row-based: the timer's `consolidate` may
//! run on an empty brain and report 0 reindexed rows, which would also be a
//! valid no-op result. The stderr log line is a more reliable signal that
//! the timer fired (it appears whether the consolidation succeeded with
//! rows=0 or failed). Brief §2.5 explicitly authorises this approach.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tempfile::TempDir;

const BG_LOG_NEEDLE: &str = "axel: bg consolidate:";
const BG_END_NEEDLE: &str = "axel: bg consolidate: end";
const BG_FAILED_NEEDLE: &str = "axel: bg consolidate: failed";

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

/// Returns (child, stdin, stdout-reader, stderr-buffer-handle).
/// Spawns a stderr-pump thread that drains stderr into the buffer.
fn spawn_with_stderr_capture(
    base_dir: &std::path::Path,
    brain_path: &std::path::Path,
    extra_env: &[(&str, &str)],
) -> (Child, ChildStdin, BufReader<std::process::ChildStdout>, Arc<Mutex<String>>) {
    let mut cmd = Command::new(bin_path());
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("AXEL_BRAIN", brain_path)
        .env("SYNAPS_BASE_DIR", base_dir)
        .env("AXEL_ALLOW_ANY_INTERVAL", "1");
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("spawn memory-manager");
    let stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");

    let buf = Arc::new(Mutex::new(String::new()));
    let buf2 = buf.clone();
    std::thread::spawn(move || {
        let mut r = stderr;
        let mut chunk = [0u8; 1024];
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let s = String::from_utf8_lossy(&chunk[..n]).to_string();
                    // Mirror to test stderr for diagnostics.
                    eprint!("{s}");
                    let mut g = buf2.lock().unwrap();
                    g.push_str(&s);
                }
            }
        }
    });

    (child, stdin, BufReader::new(stdout), buf)
}

fn stderr_contains(buf: &Arc<Mutex<String>>, needle: &str) -> bool {
    buf.lock().unwrap().contains(needle)
}

fn config_dir(base: &std::path::Path) -> std::path::PathBuf {
    base.join("plugins").join("axel-memory-manager")
}

/// Atomic-write the config file (tmp + rename) — matches the host's
/// `write_plugin_config_to` pattern and what the file-watcher observes.
fn write_config(path: &std::path::Path, body: &str) {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body).unwrap();
    std::fs::rename(&tmp, path).unwrap();
}

fn send(stdin: &mut ChildStdin, value: &Value) {
    stdin.write_all(&frame(value)).unwrap();
    stdin.flush().unwrap();
}

fn initialize(stdin: &mut ChildStdin, reader: &mut BufReader<std::process::ChildStdout>) {
    send(
        stdin,
        &json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}}),
    );
    let init = read_response(reader);
    assert_eq!(init["result"]["name"], "memory-manager", "init: {init}");
}

fn send_complete(stdin: &mut ChildStdin, reader: &mut BufReader<std::process::ChildStdout>, id: u64, msg: &str) {
    send(
        stdin,
        &json!({
            "jsonrpc": "2.0", "id": id,
            "method": "hook.handle",
            "params": {"kind": "on_message_complete", "message": msg, "data": null}
        }),
    );
    let _ = read_response(reader);
}

/// 70-character message — comfortably above axel's 50-char `remember` floor
/// and any sensible `min_consolidate_len` we set in tests.
const MSG: &str = "Background timer integration test payload — must be at least 50 chars.";

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: timer fires consolidation when interval > 0.
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn timer_fires_consolidation_when_interval_set() {
    assert!(MSG.len() >= 50);
    let synaps_base = TempDir::new().unwrap();
    let brain_dir = TempDir::new().unwrap();
    let brain_path = brain_dir.path().join("test.r8");
    let cfg_dir = config_dir(synaps_base.path());
    std::fs::create_dir_all(&cfg_dir).unwrap();
    let cfg_path = cfg_dir.join("config");
    write_config(
        &cfg_path,
        "consolidate_interval_secs = \"1\"\nmin_consolidate_len = \"50\"\n",
    );

    let (mut child, mut stdin, mut reader, stderr_buf) =
        spawn_with_stderr_capture(synaps_base.path(), &brain_path, &[]);
    initialize(&mut stdin, &mut reader);

    // Push a few hooks with content above min_consolidate_len so the timer
    // has work to do (or at least non-empty state to consolidate over).
    send_complete(&mut stdin, &mut reader, 1, MSG);
    send_complete(&mut stdin, &mut reader, 2, MSG);

    // Wait for ~2 ticks at the 1s interval.
    std::thread::sleep(Duration::from_millis(2500));

    // Graceful shutdown so the watchdog never trips.
    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "id": 99, "method": "shutdown", "params": {}}),
    );
    drop(stdin);
    let _ = child.wait();

    let buf = stderr_buf.lock().unwrap().clone();
    assert!(
        buf.contains(BG_END_NEEDLE) || buf.contains(BG_FAILED_NEEDLE),
        "expected '{BG_LOG_NEEDLE}' in captured stderr; got:\n{buf}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: interval=0 disables the timer; a later live-reload re-arms it.
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn interval_zero_disables_then_reload_arms_timer() {
    let synaps_base = TempDir::new().unwrap();
    let brain_dir = TempDir::new().unwrap();
    let brain_path = brain_dir.path().join("test.r8");
    let cfg_dir = config_dir(synaps_base.path());
    std::fs::create_dir_all(&cfg_dir).unwrap();
    let cfg_path = cfg_dir.join("config");
    // Default: no config file → interval 0.

    let (mut child, mut stdin, mut reader, stderr_buf) =
        spawn_with_stderr_capture(synaps_base.path(), &brain_path, &[]);
    initialize(&mut stdin, &mut reader);
    send_complete(&mut stdin, &mut reader, 1, MSG);

    // 2 s with the timer disabled — must NOT see a 'bg consolidate: end'
    // (the 'timer started interval_secs=0' line is fine; we look for `: end`).
    std::thread::sleep(Duration::from_millis(2000));
    {
        let buf = stderr_buf.lock().unwrap().clone();
        assert!(
            !buf.contains(BG_END_NEEDLE) && !buf.contains(BG_FAILED_NEEDLE),
            "timer should be disabled at interval=0 but found firing in stderr:\n{buf}"
        );
    }

    // Re-arm via file-watcher → TimerCmd::Rearm path.
    write_config(&cfg_path, "consolidate_interval_secs = \"1\"\n");
    std::thread::sleep(Duration::from_millis(2500));
    {
        let buf = stderr_buf.lock().unwrap().clone();
        assert!(
            buf.contains(BG_END_NEEDLE) || buf.contains(BG_FAILED_NEEDLE),
            "expected timer to fire after live-reload to interval=1, got:\n{buf}"
        );
    }

    drop(stdin);
    let _ = child.wait();
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: re-arm without restart — start at 60s, patch to 1s, fires within ~2s.
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn rearm_without_restart_fires_within_two_seconds() {
    let synaps_base = TempDir::new().unwrap();
    let brain_dir = TempDir::new().unwrap();
    let brain_path = brain_dir.path().join("test.r8");
    let cfg_dir = config_dir(synaps_base.path());
    std::fs::create_dir_all(&cfg_dir).unwrap();
    let cfg_path = cfg_dir.join("config");
    write_config(&cfg_path, "consolidate_interval_secs = \"60\"\n");

    let (mut child, mut stdin, mut reader, stderr_buf) =
        spawn_with_stderr_capture(synaps_base.path(), &brain_path, &[]);
    initialize(&mut stdin, &mut reader);
    send_complete(&mut stdin, &mut reader, 1, MSG);

    // Sanity: at 60s no fire yet within first 500ms.
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        !stderr_contains(&stderr_buf, BG_END_NEEDLE)
            && !stderr_contains(&stderr_buf, BG_FAILED_NEEDLE),
        "timer should not have fired yet at interval=60s"
    );

    // Patch live to 1s. The watcher emits Rearm(1).
    let patched_at = Instant::now();
    write_config(&cfg_path, "consolidate_interval_secs = \"1\"\n");

    // Poll stderr for up to 3s for the firing log line.
    let deadline = patched_at + Duration::from_millis(3000);
    let mut fired = false;
    while Instant::now() < deadline {
        if stderr_contains(&stderr_buf, BG_END_NEEDLE)
            || stderr_contains(&stderr_buf, BG_FAILED_NEEDLE)
        {
            fired = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let elapsed = patched_at.elapsed();
    drop(stdin);
    let _ = child.wait();
    assert!(
        fired,
        "timer should fire within 3s of live-reload to interval=1s; \
         elapsed={elapsed:?}; stderr:\n{}",
        stderr_buf.lock().unwrap()
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: stdin EOF triggers clean shutdown within 3 seconds.
// ─────────────────────────────────────────────────────────────────────────────
#[test]
fn stdin_eof_terminates_within_three_seconds() {
    let synaps_base = TempDir::new().unwrap();
    let brain_dir = TempDir::new().unwrap();
    let brain_path = brain_dir.path().join("test.r8");

    let (mut child, mut stdin, mut reader, _stderr_buf) =
        spawn_with_stderr_capture(synaps_base.path(), &brain_path, &[]);
    initialize(&mut stdin, &mut reader);

    // Close stdin → main loop's read_frame returns Ok(None) → exit path runs.
    drop(stdin);

    // Poll for exit with a 3-second cap.
    let started = Instant::now();
    let deadline = started + Duration::from_secs(3);
    let mut exit_status = None;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_status = Some(status);
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => panic!("try_wait error: {e}"),
        }
    }
    if exit_status.is_none() {
        let _ = child.kill();
        panic!(
            "process did not exit within 3 seconds of stdin EOF (elapsed={:?})",
            started.elapsed()
        );
    }
    let status = exit_status.unwrap();
    assert!(
        status.success(),
        "process exited with non-zero status: {status:?}"
    );
}
