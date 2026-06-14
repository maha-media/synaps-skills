//! GA-B9 end-to-end alignment (no SynapsCLI core change):
//!  (a) the guest-written session-context file is consumed by the real
//!      `pria-session-context` plugin loader, and
//!  (b) the guest-agent fsmon control wire is byte-compatible with the real
//!      `pria-fsmon-plugin` `control.rs`/`policy.rs` (frozen vectors).
//!
//! (a) is opt-in on `python3` being present and the sibling plugin checked out;
//! it skips cleanly otherwise so default CI stays green.

use std::path::PathBuf;

use pria_guest_agent::fsmon::types::{ControlRequest, PolicyDoc};
use pria_guest_agent::synaps::session_context::{context_paths, now_timestamps, SessionContext};

fn workspace_root() -> PathBuf {
    // guest-agent/ -> synaps-skills/
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn sample_context(session_id: &str) -> SessionContext {
    let (issued, expires, created) = now_timestamps(60);
    SessionContext {
        account_id: "acct_123".into(),
        instance_id: "inst_456".into(),
        user_id: "user_789".into(),
        vm_id: "vm_456".into(),
        replica_id: "replica_0".into(),
        session_id: session_id.into(),
        linux_username: "pria_u_104251".into(),
        linux_uid: 104251,
        linux_gid: 104251,
        roles: vec!["agent_operator".into(), "workspace_editor".into()],
        policy_profile_id: Some("policy_default".into()),
        policy_version: Some(17),
        policy_hash: Some("sha256:abc".into()),
        pria_base_url: "https://pria.example".into(),
        audit_endpoint: "/internal/agentic-vm/audit".into(),
        credential_broker_endpoint: "/internal/agentic-vm/credential-request".into(),
        transport: serde_json::json!({"kind": "pria-agent-websocket"}),
        issued_at: issued,
        expires_at: expires,
        created_at: created,
    }
}

/// (a) The plugin's `sessionctx.load_context` resolves + tags a guest-written
/// context file at the XDG path the writer uses.
#[test]
fn session_context_file_is_readable_by_plugin() {
    let plugin = workspace_root()
        .join("pria-session-context-plugin")
        .join("extensions");
    if !plugin.join("pria").join("sessionctx.py").exists() {
        eprintln!("skipping: pria-session-context-plugin not present");
        return;
    }
    if std::process::Command::new("python3")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("skipping: python3 not available");
        return;
    }

    // Write the context exactly where the writer would (XDG path #1).
    let session_id = format!("sess_{}", uuid::Uuid::new_v4().simple());
    let xdg = std::env::temp_dir().join(format!("ga-xdg-{}", uuid::Uuid::new_v4()));
    let path = context_paths(
        &session_id,
        std::path::Path::new("/run/pria"),
        Some(xdg.to_str().unwrap()),
        None,
    )[0]
    .clone();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let ctx = sample_context(&session_id);
    std::fs::write(&path, serde_json::to_vec_pretty(&ctx).unwrap()).unwrap();

    // Drive the real plugin loader.
    let script = format!(
        r#"
import sys, json
sys.path.insert(0, {plugin:?})
from pria import sessionctx
ctx, p = sessionctx.load_context({sid:?})
assert ctx is not None, "context not resolved"
sc = sessionctx.SessionContext()
sc.load({sid:?})
tags = sc.tags()
assert tags.get("context") == "resolved", tags
for f in ("account_id","instance_id","user_id","vm_id","session_id","linux_uid","roles"):
    assert f in tags, ("missing tag", f, tags)
print("OK", tags["session_id"], tags["account_id"])
"#,
        plugin = plugin.to_str().unwrap(),
        sid = session_id,
    );
    let out = std::process::Command::new("python3")
        .arg("-c")
        .arg(&script)
        .env("XDG_RUNTIME_DIR", &xdg)
        .output()
        .expect("run python");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    std::fs::remove_dir_all(&xdg).ok();
    assert!(
        out.status.success() && stdout.starts_with("OK"),
        "plugin failed to load guest-written context:\nstdout={stdout}\nstderr={stderr}"
    );
}

/// (b) The exact `control.rs` policy_apply vector deserialises into the
/// guest-agent's mirrored type (proves the guest agent can push to the daemon).
#[test]
fn fsmon_control_vector_parses() {
    let line = r#"{"type":"policy_apply","policy":{"default_decision":"deny","rules":[],"principals":[{"uid":12001,"instance_roots":["/srv/x"]}]}}"#;
    let req: ControlRequest = serde_json::from_str(line).unwrap();
    match req {
        ControlRequest::PolicyApply { policy } => {
            assert_eq!(policy.principals.len(), 1);
            assert_eq!(policy.principals[0].uid, 12001);
        }
        _ => panic!("wrong variant"),
    }
}

/// (b) The guest-agent's serialised PolicyApply matches what fsmon's `control.rs`
/// test asserts on the receive side (tag + snake_case fields).
#[test]
fn fsmon_control_serialisation_matches_daemon_expectation() {
    use pria_guest_agent::fsmon::types::{Decision, Principal};
    let req = ControlRequest::PolicyApply {
        policy: PolicyDoc {
            default_decision: Decision::Deny,
            principals: vec![Principal {
                uid: 12001,
                instance_roots: vec!["/srv/x".into()],
                ..Default::default()
            }],
            ..Default::default()
        },
    };
    let s = serde_json::to_string(&req).unwrap();
    assert!(s.contains("\"type\":\"policy_apply\""));
    assert!(s.contains("\"default_decision\":\"deny\""));
    assert!(s.contains("\"uid\":12001"));
}
