//! Integration test: the running daemon's control socket accepts a hot policy
//! push and reports stats (B8), without restart.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

struct Reaper(Child);
impl Drop for Reaper {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn unique_tmp(name: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("fsmon-it-{}-{}-{}", std::process::id(), nanos, name))
}

fn wait_for_socket(path: &std::path::Path) -> Option<UnixStream> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(s) = UnixStream::connect(path) {
            return Some(s);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

fn request(sock: &std::path::Path, line: &str) -> String {
    let mut stream = UnixStream::connect(sock).expect("connect control socket");
    stream.write_all(line.as_bytes()).unwrap();
    stream.write_all(b"\n").unwrap();
    stream.flush().unwrap();
    let mut reader = BufReader::new(stream);
    let mut resp = String::new();
    reader.read_line(&mut resp).unwrap();
    resp.trim().to_string()
}

#[test]
fn control_socket_accepts_policy_push_and_stats() {
    let dir = unique_tmp("ctl");
    std::fs::create_dir_all(&dir).unwrap();
    let control = dir.join("control.sock");
    let spool = dir.join("audit.jsonl");
    let bin = env!("CARGO_BIN_EXE_synaps_fsmon");

    let child = Command::new(bin)
        .args([
            "run",
            "--mount",
            dir.to_str().unwrap(),
            "--spool",
            spool.to_str().unwrap(),
            "--control",
            control.to_str().unwrap(),
        ])
        .spawn()
        .expect("spawn synaps_fsmon");
    let _reaper = Reaper(child);

    // Socket comes up even though fanotify init fails without CAP_SYS_ADMIN
    // (the daemon enters degraded posture but keeps serving control).
    let _ = wait_for_socket(&control).expect("control socket up");

    // ping
    let pong = request(&control, r#"{"type":"ping"}"#);
    assert!(pong.contains("\"type\":\"ok\""), "ping resp: {pong}");

    // hot policy push with one principal
    let push = request(
        &control,
        r#"{"type":"policy_apply","policy":{"default_decision":"deny","principals":[{"uid":12001,"instance_roots":["/srv/x"]}]}}"#,
    );
    assert!(push.contains("\"type\":\"ok\""), "push resp: {push}");

    // stats reflects the engine is alive
    let stats = request(&control, r#"{"type":"stats"}"#);
    assert!(stats.contains("cache_len"), "stats resp: {stats}");

    // bad request -> structured error, daemon stays up
    let err = request(&control, "not-json");
    assert!(err.contains("\"type\":\"error\""), "err resp: {err}");

    let _ = std::fs::remove_dir_all(&dir);
}
