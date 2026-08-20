//! W3.7-G — fleet callback protocol, guest half of F6 (born-RED fence).
//!
//! The Pria host dispatches fleet tasks by sending wire text into a session via
//! `POST /guest/v1/sessions/{id}/send` (`SendRequest.input`, the choke point in
//! `src/api/sessions.rs::send`, before `proc.send`). W3.7-P set_task text:
//!
//!   line1: `set_task <slug>@<version>`
//!   line2: `digest sha256:<hex>`
//!   line3 (fleet dispatches only): `fleet <handleId> <generation>`
//!            handleId ∈ ^fj-[a-z0-9][a-z0-9-]*$, generation a positive integer
//!
//! This fence demands (implementation is NOT here):
//!   * DETECTION at the send choke point: a valid fleet line in a set_task
//!     message binds {handle_id, generation} to the session and IMMEDIATELY
//!     emits an `ack` fleet callback; forwarding is NEVER blocked (byte-identical
//!     passthrough either way).
//!   * OUTBOUND VERB: `PriaCallbackClient::fleet_callback(session_id, handle_id,
//!     generation, kind, payload)` → signed POST to
//!     `/internal/agentic-vm/fleet-callback` via `post_signed`
//!     (src/pria_client/mod.rs:95-120), mirroring `session_event`
//!     (mod.rs:191-196). `FakePriaClient` records into `fleet_callbacks`
//!     (recorder Vec mirroring `session_events`, mod.rs:246) — each recorded
//!     entry is a JSON object {session_id, handle_id, generation, kind, payload}.
//!   * STATE MACHINE / RESULT: Acked (set_task turn's own agent_end IGNORED) →
//!     next send marks Running → agent_end while Running emits `result {ok:true}`
//!     and clears. Stdout EOF while bound emits
//!     `result {ok:false, error:{code:"session_exited"}}` and clears.
//!   * HEARTBEAT: per-binding tokio loop (mirroring `spawn_heartbeat_loop`,
//!     src/supervisor/mod.rs:74-87) emits `heartbeat` callbacks every
//!     `fleet.heartbeat_interval_seconds` (config default 30, idiom of
//!     src/config.rs:18-20 / HeartbeatConfig) until the binding clears.
//!
//! SEAM HONESTY NOTE (reported, not improvised around): the stdout relay
//! (`relay_agent_end_usage`, src/synaps/launcher.rs:223-262) is NOT drivable
//! through router tests — `FakeProcess::take_stdout()` returns `None`, so the
//! start handler never spawns the relay under `FakeLauncher`. The fence
//! therefore pins the state-machine seam the relay MUST call:
//! `pria_guest_agent::fleet::FleetBindings::{on_agent_end, on_session_eof}`,
//! exposed on `AppState` as `state.fleet`. The relay→FleetBindings wiring itself
//! is left to a real-child test at implementation time (see report).

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;

use pria_guest_agent::api::build_router;
use pria_guest_agent::config::Config;
use pria_guest_agent::fleet::{parse_fleet_directive, FleetBindings, FleetDirective};
use pria_guest_agent::os::{FakeUserManager, UserRecord};
use pria_guest_agent::pria_client::fake::FakePriaClient;
use pria_guest_agent::pria_client::PriaCallbackClient;
use pria_guest_agent::synaps::launcher::FakeLauncher;
use pria_guest_agent::test_support::{test_env, TestEnv};

// ── helpers (mirroring tests/sessions_tests.rs idioms exactly) ───────────────

fn post(uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// The uid these tests run as (mirrors tests/sessions_tests.rs): the start
/// handler chowns the per-UID Synaps socket dir and VERIFIES it retained that
/// owner, so a fictional fixture uid is unreachable without root.
fn test_uid() -> u32 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata("/proc/self")
        .map(|m| m.uid())
        .expect("read /proc/self for caller uid")
}

fn test_username() -> String {
    format!("pria_u_{}", test_uid())
}

fn active_user_os() -> Arc<FakeUserManager> {
    Arc::new(FakeUserManager::default().with_user(UserRecord {
        username: test_username(),
        uid: test_uid(),
        gid: test_uid(),
        active: true,
    }))
}

fn env_with(launcher: Arc<FakeLauncher>, pria: Arc<FakePriaClient>) -> TestEnv {
    test_env(pria, active_user_os(), launcher)
}

fn start_body(env: &TestEnv) -> serde_json::Value {
    let ws = env.efs_root.join("instances/inst_456/workspace");
    let sd = env.efs_root.join("sessions/sess_abc");
    json!({
        "account_id": "acct_123", "instance_id": "inst_456", "user_id": "user_789",
        "session_id": "sess_abc", "vm_id": "vm_456",
        "linux_username": test_username(), "uid": test_uid(), "gid": test_uid(),
        "workspace_dir": ws.to_string_lossy(), "session_dir": sd.to_string_lossy(),
        "roles": ["agent_operator"], "transport": {"kind": "pria-agent-websocket"},
        "request_id": "req_1"
    })
}

/// Start `sess_abc` through the router and return (router, launcher, pria).
async fn started(
) -> (axum::Router, Arc<FakeLauncher>, Arc<FakePriaClient>, TestEnv) {
    let pria = Arc::new(FakePriaClient::default());
    let launcher = Arc::new(FakeLauncher::default());
    let env = env_with(launcher.clone(), pria.clone());
    let router = build_router(env.state.clone());
    let resp = router
        .clone()
        .oneshot(post("/guest/v1/sessions/start", start_body(&env)))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "session start must succeed");
    (router, launcher, pria, env)
}

async fn send(router: &axum::Router, input: &str) {
    let resp = router
        .clone()
        .oneshot(post(
            "/guest/v1/sessions/sess_abc/send",
            json!({ "input": input }),
        ))
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "fleet parsing must never block forwarding"
    );
}

const DIGEST_HEX: &str = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

/// W3.7-P three-line fleet dispatch wire text.
fn fleet_task(handle: &str, generation: &str) -> String {
    format!("set_task demo-task@1.2.0\ndigest sha256:{DIGEST_HEX}\nfleet {handle} {generation}")
}

/// Two-line non-fleet set_task wire text.
fn plain_task() -> String {
    format!("set_task demo-task@1.2.0\ndigest sha256:{DIGEST_HEX}")
}

/// Snapshot of the sanctioned recorder Vec (mirrors `session_events` idiom).
fn fleet_cbs(pria: &FakePriaClient) -> Vec<Value> {
    pria.fleet_callbacks.lock().unwrap().clone()
}

/// The full input text the FakeProcess received for launch `idx` — passthrough
/// must be byte-identical (fleet detection observes, never rewrites).
fn sent_inputs(launcher: &FakeLauncher, idx: usize) -> Vec<String> {
    launcher.launched.lock().unwrap()[idx]
        .sent
        .lock()
        .unwrap()
        .clone()
}

// ── F1: ack ──────────────────────────────────────────────────────────────────

/// Fences the send-handler detection seam (src/api/sessions.rs::send, before
/// `proc.send`): a valid three-line fleet set_task emits exactly one `ack`
/// fleet callback bound to {session, handle, generation}, and the process still
/// receives the FULL wire text unchanged.
#[tokio::test]
async fn f1_set_task_with_fleet_line_emits_single_ack_and_forwards_unchanged() {
    let (router, launcher, pria, _env) = started().await;
    let input = fleet_task("fj-alpha", "7");
    send(&router, &input).await;

    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs.len(), 1, "exactly one fleet callback (the ack): {cbs:?}");
    assert_eq!(cbs[0]["kind"], "ack");
    assert_eq!(cbs[0]["session_id"], "sess_abc");
    assert_eq!(cbs[0]["handle_id"], "fj-alpha");
    assert_eq!(cbs[0]["generation"], 7);

    // Byte-identical passthrough: detection must never rewrite or swallow the
    // wire text (the fleet line is part of the task the agent itself parses).
    assert_eq!(sent_inputs(&launcher, 0), vec![input]);
}

// ── F2: no-fleet passthrough ─────────────────────────────────────────────────

/// Two-line set_task (no fleet line) and ordinary prompts: zero fleet
/// callbacks, no binding, inputs forwarded unchanged.
#[tokio::test]
async fn f2_no_fleet_line_means_zero_callbacks_and_unchanged_passthrough() {
    let (router, launcher, pria, env) = started().await;
    let two_line = plain_task();
    let prompt = "please summarise the workspace README";
    send(&router, &two_line).await;
    send(&router, prompt).await;

    assert!(
        fleet_cbs(&pria).is_empty(),
        "non-fleet inputs must emit no fleet callbacks"
    );
    assert!(
        env.state.fleet.binding("sess_abc").is_none(),
        "non-fleet inputs must not bind"
    );
    assert_eq!(
        sent_inputs(&launcher, 0),
        vec![two_line, prompt.to_string()]
    );
}

// ── F3: invalid shapes ───────────────────────────────────────────────────────

/// Pure-parser table for the wire grammar: first line must start with
/// `set_task `, fleet line must match `fleet <^fj-[a-z0-9][a-z0-9-]*$> <positive int>`.
#[test]
fn f3_parse_fleet_directive_accepts_valid_and_rejects_invalid_shapes() {
    // Valid.
    let d = parse_fleet_directive(&fleet_task("fj-alpha-2", "12"))
        .expect("valid three-line fleet set_task must parse");
    assert_eq!(d.handle_id, "fj-alpha-2");
    assert_eq!(d.generation, 12);

    // Invalid handle charset / shape.
    for handle in ["FJ-UPPER", "fj_underscore", "nofj", "fj-", "fj-UPPER", "fj-a!b"] {
        assert!(
            parse_fleet_directive(&fleet_task(handle, "1")).is_none(),
            "handle {handle:?} must be rejected (^fj-[a-z0-9][a-z0-9-]*$)"
        );
    }

    // Invalid generation: zero, negative, non-numeric.
    for generation in ["0", "-1", "abc", ""] {
        assert!(
            parse_fleet_directive(&fleet_task("fj-alpha", generation)).is_none(),
            "generation {generation:?} must be rejected (positive integer)"
        );
    }

    // Fleet line outside a set_task message: first line is not `set_task `.
    assert!(
        parse_fleet_directive(&format!("hello agent\nfleet fj-alpha 1")).is_none(),
        "fleet line only binds inside a set_task message"
    );
    assert!(
        parse_fleet_directive("fleet fj-alpha 1").is_none(),
        "a bare fleet line is not a set_task message"
    );

    // Absent fleet line.
    assert!(parse_fleet_directive(&plain_task()).is_none());
}

/// Over the wire: invalid fleet shapes still forward byte-identical with zero
/// callbacks and zero bindings (fail-open passthrough, fail-closed binding).
#[tokio::test]
async fn f3_invalid_fleet_shapes_over_the_wire_forward_unchanged_no_callbacks() {
    let (router, launcher, pria, env) = started().await;
    let bad = vec![
        fleet_task("FJ-UPPER", "1"),
        fleet_task("fj-alpha", "0"),
        fleet_task("fj-alpha", "-1"),
        fleet_task("fj-alpha", "seven"),
        format!("hello agent\nfleet fj-alpha 1"),
    ];
    for input in &bad {
        send(&router, input).await;
    }
    assert!(fleet_cbs(&pria).is_empty(), "invalid shapes emit nothing");
    assert!(env.state.fleet.binding("sess_abc").is_none());
    assert_eq!(sent_inputs(&launcher, 0), bad);
}

// ── F4: result state machine ─────────────────────────────────────────────────

/// Acked → (set_task turn's OWN agent_end ignored) → next send marks Running →
/// agent_end emits exactly one `result {ok:true}` and clears; a third agent_end
/// after clear emits nothing.
///
/// Driven through `FleetBindings::on_agent_end` — the seam the stdout relay
/// (relay_agent_end_usage) must call per agent_end frame; the relay itself is
/// not drivable here because FakeProcess has no stdout (see module doc).
#[tokio::test]
async fn f4_result_ok_after_running_turn_and_binding_clears() {
    let (router, _launcher, pria, env) = started().await;
    send(&router, &fleet_task("fj-alpha", "7")).await;
    assert_eq!(fleet_cbs(&pria).len(), 1, "ack only");

    // The set_task turn's own agent_end must be IGNORED (state: Acked).
    env.state.fleet.on_agent_end("sess_abc").await;
    assert_eq!(
        fleet_cbs(&pria).len(),
        1,
        "set_task turn's own agent_end must not emit a result"
    );

    // The NEXT send while Acked marks Running (the brief); no callback.
    send(&router, "begin").await;
    assert_eq!(fleet_cbs(&pria).len(), 1, "the brief send emits nothing");

    // agent_end while Running → exactly one result {ok:true}, binding cleared.
    env.state.fleet.on_agent_end("sess_abc").await;
    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs.len(), 2, "exactly one result after the running turn");
    assert_eq!(cbs[1]["kind"], "result");
    assert_eq!(cbs[1]["handle_id"], "fj-alpha");
    assert_eq!(cbs[1]["generation"], 7);
    assert_eq!(cbs[1]["payload"]["ok"], true);
    assert!(env.state.fleet.binding("sess_abc").is_none(), "cleared");

    // After clear, later turns emit nothing.
    env.state.fleet.on_agent_end("sess_abc").await;
    assert_eq!(fleet_cbs(&pria).len(), 2, "post-clear agent_end is silent");
}

// ── F5: rebind ───────────────────────────────────────────────────────────────

/// A new set_task+fleet on the same session REPLACES the binding: ack under the
/// new handle, and no later event ever emits under the old handle.
#[tokio::test]
async fn f5_rebind_replaces_binding_and_old_handle_never_emits_again() {
    let (router, _launcher, pria, env) = started().await;
    send(&router, &fleet_task("fj-old", "1")).await;
    send(&router, &fleet_task("fj-new", "2")).await;

    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs.len(), 2, "one ack per set_task");
    assert_eq!(cbs[1]["kind"], "ack");
    assert_eq!(cbs[1]["handle_id"], "fj-new");
    assert_eq!(cbs[1]["generation"], 2);

    let b = env.state.fleet.binding("sess_abc").expect("bound");
    assert_eq!(b.handle_id, "fj-new");
    assert_eq!(b.generation, 2);

    // Drive the new binding to result: its set_task agent_end is ignored, then
    // brief + agent_end emits the result — under fj-new, never fj-old.
    env.state.fleet.on_agent_end("sess_abc").await;
    send(&router, "begin").await;
    env.state.fleet.on_agent_end("sess_abc").await;

    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs.last().unwrap()["kind"], "result");
    assert_eq!(cbs.last().unwrap()["handle_id"], "fj-new");
    assert!(
        cbs.iter()
            .all(|c| c["handle_id"] != "fj-old" || c["kind"] == "ack"),
        "the old handle may only ever have its ack: {cbs:?}"
    );
}

// ── F6: EOF failure ──────────────────────────────────────────────────────────

/// Stdout EOF (process death) while a binding exists emits exactly one
/// `result {ok:false, error.code=="session_exited"}` and clears. Driven through
/// `FleetBindings::on_session_eof` — the seam the relay's `Ok(None)` EOF arm
/// (src/synaps/launcher.rs:255) must call.
#[tokio::test]
async fn f6_eof_while_bound_emits_session_exited_failure_and_clears() {
    let (router, _launcher, pria, env) = started().await;
    send(&router, &fleet_task("fj-alpha", "7")).await;

    env.state.fleet.on_session_eof("sess_abc").await;
    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs.len(), 2, "ack + failure result");
    assert_eq!(cbs[1]["kind"], "result");
    assert_eq!(cbs[1]["handle_id"], "fj-alpha");
    assert_eq!(cbs[1]["generation"], 7);
    assert_eq!(cbs[1]["payload"]["ok"], false);
    assert_eq!(cbs[1]["payload"]["error"]["code"], "session_exited");
    assert!(env.state.fleet.binding("sess_abc").is_none(), "cleared");

    // EOF after clear (or on an unbound session) is silent.
    env.state.fleet.on_session_eof("sess_abc").await;
    env.state.fleet.on_agent_end("sess_abc").await;
    assert_eq!(fleet_cbs(&pria).len(), 2);
}

// ── F7: heartbeat ────────────────────────────────────────────────────────────

/// New config key `fleet.heartbeat_interval_seconds`, following the existing
/// heartbeat idiom (src/config.rs:18-20 / HeartbeatConfig): default 30,
/// overridable in YAML.
#[test]
fn f7_fleet_heartbeat_interval_config_defaults_to_30_and_parses_override() {
    let minimal = r#"
mode: local-virsh
account_id: acct_1
vm_id: vm_1
replica_id: r0
pria:
  base_url: http://x
  hmac_key_id: k
  hmac_secret_file: /tmp/s
paths:
  efs_root: /efs
  run_root: /run/pria
  policy_dir: /efs/policy
  audit_spool_dir: /efs/spool
synaps:
  binary: /bin/true
fsmon:
  socket: /run/fsmon.sock
"#;
    let cfg = Config::from_yaml(minimal).unwrap();
    assert_eq!(cfg.fleet.heartbeat_interval_seconds, 30, "default 30s");

    let cfg = Config::from_yaml(&format!("{minimal}fleet:\n  heartbeat_interval_seconds: 1\n"))
        .unwrap();
    assert_eq!(cfg.fleet.heartbeat_interval_seconds, 1);
}

/// An acked binding emits `heartbeat` callbacks on the configured cadence
/// (per-binding tokio loop mirroring spawn_heartbeat_loop,
/// src/supervisor/mod.rs:74-87); clearing the binding stops the loop.
///
/// The crate has NO virtual-time idiom (supervisor tests only exercise
/// build_heartbeat, never the loop), so this row constructs FleetBindings
/// directly with a tiny real interval — pinning
/// `FleetBindings::new(pria, heartbeat_interval)` and the `bind` seam the send
/// handler must use (bind = record binding + emit ack + start the loop).
#[tokio::test]
async fn f7_acked_binding_emits_heartbeats_until_cleared() {
    let pria = Arc::new(FakePriaClient::default());
    let fleet = FleetBindings::new(
        pria.clone() as Arc<dyn PriaCallbackClient>,
        Duration::from_millis(10),
    );
    fleet
        .bind(
            "sess_hb",
            FleetDirective {
                handle_id: "fj-hb".into(),
                generation: 3,
            },
        )
        .await;

    tokio::time::sleep(Duration::from_millis(120)).await;
    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs[0]["kind"], "ack", "bind acks immediately");
    let beats = cbs.iter().filter(|c| c["kind"] == "heartbeat").count();
    assert!(beats >= 2, "expected >=2 heartbeats at 10ms cadence, got {beats}");
    for c in cbs.iter().filter(|c| c["kind"] == "heartbeat") {
        assert_eq!(c["session_id"], "sess_hb");
        assert_eq!(c["handle_id"], "fj-hb");
        assert_eq!(c["generation"], 3);
    }

    // Clearing the binding (EOF path) aborts the loop: the count stops growing.
    fleet.on_session_eof("sess_hb").await;
    let settled = fleet_cbs(&pria).len();
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(
        fleet_cbs(&pria).len(),
        settled,
        "no heartbeats after the binding clears"
    );
}
