//! `synaps_fsmon` — Pria in-VM file-write monitor (sibling daemon).
//!
//! HARD STOP HS-5 (CONFIRMED): SynapsCLI's `provides.sidecar` / `sidecar/spawn.rs`
//! is a purpose-built protocol (the only in-tree example, local-voice-plugin,
//! speaks a voice STT protocol), NOT a generic daemon supervisor. Making
//! SynapsCLI lifecycle this monitor would be a core change. Therefore fsmon ships
//! as an INDEPENDENT sibling daemon, launched by the Pria guest agent / systemd
//! (A11/A13) — exactly the spec-sanctioned "sibling daemon under synaps_system"
//! placement (§4.7). It is not declared as an `extension` or `provides.sidecar`
//! in the plugin manifest.
//!
//! Usage:
//!   synaps_fsmon run    [--mount /] [--spool PATH] [--control SOCK] [--forward SOCK] [--policy FILE]
//!   synaps_fsmon check  [--policy FILE]
//!   synaps_fsmon version

mod audit;
mod control;
mod daemon;
mod fanotify;
mod policy;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::sync::Arc;
use std::thread;

use audit::AuditSpool;
use control::{parse_request, ControlResponse};
use daemon::{Daemon, Forwarder, NullForwarder, SocketForwarder};
use policy::{Policy, PolicyDoc};

const DEFAULT_MOUNT: &str = "/srv";
const DEFAULT_SPOOL: &str = "/srv/synaps/audit-spool/fsmon.jsonl";
const DEFAULT_CONTROL: &str = "/run/synaps/fsmon/control.sock";

struct Args {
    cmd: String,
    mount: String,
    spool: String,
    control: String,
    forward: Option<String>,
    policy: Option<String>,
    uid: u32,
    sim_path: String,
    op: String,
}

fn parse_args() -> Args {
    let mut a = Args {
        cmd: "run".to_string(),
        mount: DEFAULT_MOUNT.to_string(),
        spool: DEFAULT_SPOOL.to_string(),
        control: DEFAULT_CONTROL.to_string(),
        forward: None,
        policy: None,
        uid: 0,
        sim_path: String::new(),
        op: "open_write".to_string(),
    };
    let mut it = std::env::args().skip(1);
    if let Some(first) = it.next() {
        if !first.starts_with("--") {
            a.cmd = first;
        } else {
            apply_flag(&mut a, &first, &mut it);
        }
    }
    while let Some(flag) = it.next() {
        apply_flag(&mut a, &flag, &mut it);
    }
    a
}

fn apply_flag(a: &mut Args, flag: &str, it: &mut impl Iterator<Item = String>) {
    match flag {
        "--mount" => a.mount = it.next().unwrap_or_default(),
        "--spool" => a.spool = it.next().unwrap_or_default(),
        "--control" => a.control = it.next().unwrap_or_default(),
        "--forward" => a.forward = it.next(),
        "--policy" => a.policy = it.next(),
        "--uid" => a.uid = it.next().and_then(|v| v.parse().ok()).unwrap_or(0),
        "--path" => a.sim_path = it.next().unwrap_or_default(),
        "--op" => a.op = it.next().unwrap_or_else(|| "open_write".to_string()),
        _ => {}
    }
}

fn load_policy(path: &Option<String>) -> Result<PolicyDoc, String> {
    match path {
        Some(p) => {
            let body = std::fs::read_to_string(p).map_err(|e| format!("read {p}: {e}"))?;
            serde_json::from_str(&body).map_err(|e| format!("parse {p}: {e}"))
        }
        None => Ok(PolicyDoc::default()),
    }
}

fn make_forwarder(forward: &Option<String>) -> Box<dyn Forwarder> {
    match forward {
        Some(sock) => Box::new(SocketForwarder::new(sock.clone())),
        None => Box::new(NullForwarder),
    }
}

fn serve_control(daemon: Arc<Daemon>, control_path: String) -> std::io::Result<()> {
    let _ = std::fs::remove_file(&control_path);
    if let Some(parent) = std::path::Path::new(&control_path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = UnixListener::bind(&control_path)?;
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(s) => s,
            Err(_) => continue,
        };
        let daemon = daemon.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stream.try_clone().expect("clone control stream"));
            let mut writer = stream;
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if line.trim().is_empty() {
                    continue;
                }
                let resp = match parse_request(&line) {
                    Ok(req) => daemon.handle_control(req),
                    Err(e) => ControlResponse::Error { message: e },
                };
                let out = serde_json::to_string(&resp).unwrap_or_else(|_| "{}".to_string());
                if writeln!(writer, "{out}").is_err() {
                    break;
                }
            }
        });
    }
    Ok(())
}

fn cmd_run(a: &Args) -> i32 {
    let doc = match load_policy(&a.policy) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("synaps_fsmon: policy error: {e}");
            return 2;
        }
    };
    let daemon = Arc::new(Daemon::new(
        Policy::new(doc),
        AuditSpool::new(&a.spool),
        make_forwarder(&a.forward),
    ));

    // Control socket server (policy hot-push, stats, degraded toggle).
    {
        let daemon = daemon.clone();
        let control = a.control.clone();
        thread::spawn(move || {
            if let Err(e) = serve_control(daemon, control) {
                eprintln!("synaps_fsmon: control socket error: {e}");
            }
        });
    }

    eprintln!(
        "synaps_fsmon: starting fanotify monitor on mount {} (spool {}, control {})",
        a.mount, a.spool, a.control
    );
    match fanotify::run(&daemon, &a.mount) {
        Ok(()) => 0,
        Err(e) => {
            // Fail-closed posture: switch to degraded so high-risk writes deny.
            daemon.handle_control(control::ControlRequest::SetDegraded { degraded: true });
            eprintln!(
                "synaps_fsmon: {e} — entering DEGRADED (fail-closed on high-risk paths). \
                 Control socket remains available for policy push."
            );
            // Keep the process alive so the control socket + degraded posture
            // remain in effect (the guest agent supervises restart/alerting).
            loop {
                thread::sleep(std::time::Duration::from_secs(3600));
            }
        }
    }
}

fn cmd_check(a: &Args) -> i32 {
    match load_policy(&a.policy) {
        Ok(doc) => {
            println!(
                "synaps_fsmon check: OK (default={}, principals={}, rules={}, immutable={})",
                doc.default_decision.as_str(),
                doc.principals.len(),
                doc.rules.len(),
                doc.immutable_prefixes.len(),
            );
            0
        }
        Err(e) => {
            eprintln!("synaps_fsmon check: FAILED: {e}");
            1
        }
    }
}

fn cmd_simulate(a: &Args) -> i32 {
    // Dry-run one decision through the full decide → spool → forward path.
    // Lets the guest agent self-test policy without CAP_SYS_ADMIN / fanotify.
    let doc = match load_policy(&a.policy) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("synaps_fsmon: policy error: {e}");
            return 2;
        }
    };
    let op = match a.op.as_str() {
        "open_write" => policy::Op::OpenWrite,
        "open_read" => policy::Op::OpenRead,
        "access" => policy::Op::Access,
        other => {
            eprintln!("synaps_fsmon: bad --op '{other}' (open_write|open_read|access)");
            return 2;
        }
    };
    let daemon = Daemon::new(
        Policy::new(doc),
        AuditSpool::new(&a.spool),
        make_forwarder(&a.forward),
    );
    let verdict = daemon.decide_and_audit(a.uid, &a.sim_path, op);
    println!(
        "{{\"uid\":{},\"path\":\"{}\",\"op\":\"{}\",\"decision\":\"{}\",\"reason\":\"{}\"}}",
        a.uid,
        a.sim_path,
        op.as_str(),
        verdict.decision.as_str(),
        verdict.reason.as_str()
    );
    match verdict.decision {
        policy::Decision::Allow => 0,
        policy::Decision::Deny => 3,
    }
}

fn main() {
    let a = parse_args();
    let code = match a.cmd.as_str() {
        "run" => cmd_run(&a),
        "check" => cmd_check(&a),
        "simulate" => cmd_simulate(&a),
        "version" | "--version" | "-V" => {
            println!("synaps_fsmon {}", env!("CARGO_PKG_VERSION"));
            0
        }
        other => {
            eprintln!("synaps_fsmon: unknown command '{other}' (run|check|simulate|version)");
            2
        }
    };
    std::process::exit(code);
}
