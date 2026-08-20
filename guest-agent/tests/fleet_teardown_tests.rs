//! W3.7-G fence extension — fleet teardown (security review 9, finding 1 🟡).
//!
//! FINDING: neither `POST /guest/v1/sessions/{id}/close` nor `/cancel`
//! (src/api/sessions.rs::{close, cancel}) touches `state.fleet`, and the stdout
//! relay's read-Err arm (`relay_agent_end_usage`, src/synaps/launcher.rs —
//! `Err(e) => { warn; break }`) breaks WITHOUT notifying the fleet bindings. A
//! binding and its 30s heartbeat loop can therefore outlive its session when
//! EOF is never observed: bounded, but eternal signed heartbeat POSTs per dead
//! session until VM teardown.
//!
//! This fence demands (implementation is NOT here):
//!
//!   T1/T2 — close AND cancel on a bound session clear the binding and abort
//!   its heartbeat loop. RULING (per review guidance, pinned here): the guest
//!   emits `result {ok:false, error:{code:"session_closed"}}` EXACTLY ONCE on
//!   close/cancel of a bound session, then goes silent. The host lease reaper
//!   would fail the job anyway, but an honest guest reports what it knows;
//!   exactly-once keeps the result verb idempotent-safe on the host side.
//!   Close/cancel of an UNBOUND session emits nothing (teardown is not a turn
//!   outcome for sessions that never carried a fleet task).
//!
//!   T3 — the relay's read-Err arm behaves like EOF for fleet purposes:
//!   `result {ok:false, error:{code:"session_exited"}}` + clear. SEAM HONESTY
//!   NOTE: unlike F4/F6 (which had to fence through the
//!   `FleetBindings::{on_agent_end, on_session_eof}` seam because FakeProcess
//!   has no stdout), the Err arm IS honestly drivable — tokio's
//!   `Lines::next_line` returns `Err(InvalidData)` when a real child writes
//!   invalid UTF-8, so this row drives `relay_agent_end_usage` itself with a
//!   real `sh -c` child (mirroring tests/fleet_relay_wiring_tests.rs). No new
//!   seam (`on_session_error`) is demanded: read-Err ≡ EOF, same code
//!   `session_exited`, same clear.
//!
//!   T4 — after ANY teardown-clear, a rebind of the SAME session id works
//!   fresh: new ack under the new handle, fresh Acked phase (the new set_task
//!   turn's own agent_end ignored), result under the new handle only.
//!
//! Test idioms mirror tests/fleet_callback_tests.rs exactly (test_support::
//! test_env, FakePriaClient recorder, FakeLauncher, tower ServiceExt oneshot).
//! The heartbeat-stop rows swap a tiny-interval `FleetBindings` onto the
//! (Clone, pub-field) `AppState` before `build_router` — router-driven close
//! against the real loop, no virtual-time idiom exists in the crate.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;

use pria_guest_agent::api::build_router;
use pria_guest_agent::fleet::{FleetBindings, FleetDirective};
use pria_guest_agent::os::{FakeUserManager, UserRecord};
use pria_guest_agent::pria_client::fake::FakePriaClient;
use pria_guest_agent::pria_client::PriaCallbackClient;
use pria_guest_agent::synaps::launcher::{relay_agent_end_usage, FakeLauncher, UsageIdentity};
use pria_guest_agent::test_support::{test_env, TestEnv};

// ── helpers (mirroring tests/fleet_callback_tests.rs) ────────────────────────

fn post(uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn active_user_os() -> Arc<FakeUserManager> {
    Arc::new(FakeUserManager::default().with_user(UserRecord {
        username: "pria_u_104251".into(),
        uid: 104251,
        gid: 104251,
        active: true,
    }))
}

fn start_body(env: &TestEnv) -> serde_json::Value {
    let ws = env.efs_root.join("instances/inst_456/workspace");
    let sd = env.efs_root.join("sessions/sess_abc");
    json!({
        "account_id": "acct_123", "instance_id": "inst_456", "user_id": "user_789",
        "session_id": "sess_abc", "vm_id": "vm_456",
        "linux_username": "pria_u_104251", "uid": 104251, "gid": 104251,
        "workspace_dir": ws.to_string_lossy(), "session_dir": sd.to_string_lossy(),
        "roles": ["agent_operator"], "transport": {"kind": "pria-agent-websocket"},
        "request_id": "req_1"
    })
}

/// Start `sess_abc` through the router and return (router, launcher, pria, env).
async fn started() -> (axum::Router, Arc<FakeLauncher>, Arc<FakePriaClient>, TestEnv) {
    let pria = Arc::new(FakePriaClient::default());
    let launcher = Arc::new(FakeLauncher::default());
    let env = test_env(pria.clone(), active_user_os(), launcher.clone());
    let router = build_router(env.state.clone());
    start_session(&router, &env).await;
    (router, launcher, pria, env)
}

async fn start_session(router: &axum::Router, env: &TestEnv) {
    let resp = router
        .clone()
        .oneshot(post("/guest/v1/sessions/start", start_body(env)))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "session start must succeed");
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
    assert_eq!(resp.status(), StatusCode::OK);
}

/// POST close/cancel; teardown must never fail the control call itself.
async fn control(router: &axum::Router, verb: &str) {
    let resp = router
        .clone()
        .oneshot(post(
            &format!("/guest/v1/sessions/sess_abc/{verb}"),
            json!({ "reason": "test-teardown" }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "{verb} must succeed");
}

const DIGEST_HEX: &str = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

fn fleet_task(handle: &str, generation: &str) -> String {
    format!("set_task demo-task@1.2.0\ndigest sha256:{DIGEST_HEX}\nfleet {handle} {generation}")
}

fn fleet_cbs(pria: &FakePriaClient) -> Vec<Value> {
    pria.fleet_callbacks.lock().unwrap().clone()
}

/// Assert the recorded callback is the pinned teardown result:
/// `result {ok:false, error:{code:"session_closed"}}` under the bound identity.
fn assert_session_closed(cb: &Value, handle: &str, generation: u64) {
    assert_eq!(cb["kind"], "result", "teardown emits a result: {cb:?}");
    assert_eq!(cb["session_id"], "sess_abc");
    assert_eq!(cb["handle_id"], handle);
    assert_eq!(cb["generation"], generation);
    assert_eq!(cb["payload"]["ok"], false);
    assert_eq!(
        cb["payload"]["error"]["code"], "session_closed",
        "T1 ruling: close/cancel of a bound session reports session_closed"
    );
}

// ── T1: close ────────────────────────────────────────────────────────────────

/// Fences the missing `state.fleet` teardown in src/api/sessions.rs::close
/// (review 9 finding 1): close on a bound session emits exactly one
/// `result {ok:false, error.code=="session_closed"}`, clears the binding, and
/// goes silent — no callback of ANY kind afterwards (later agent_end/EOF from
/// the dying relay must find nothing bound).
#[tokio::test]
async fn t1_close_on_bound_session_emits_session_closed_once_and_clears() {
    let (router, _launcher, pria, env) = started().await;
    send(&router, &fleet_task("fj-doomed", "3")).await;
    assert_eq!(fleet_cbs(&pria).len(), 1, "ack only before close");

    control(&router, "close").await;

    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs.len(), 2, "exactly one teardown result after close: {cbs:?}");
    assert_session_closed(&cbs[1], "fj-doomed", 3);
    assert!(
        env.state.fleet.binding("sess_abc").is_none(),
        "close must clear the binding"
    );

    // Then silent: the torn-down session's relay will still observe its own
    // agent_end and/or EOF as the process dies — none of it may emit.
    env.state.fleet.on_agent_end("sess_abc").await;
    env.state.fleet.on_session_eof("sess_abc").await;
    assert_eq!(
        fleet_cbs(&pria).len(),
        2,
        "no further callbacks of any kind after close"
    );
}

/// Close on an UNBOUND session mints no result — teardown is not a turn
/// outcome for sessions that never carried a fleet task.
#[tokio::test]
async fn t1_close_on_unbound_session_emits_nothing() {
    let (router, _launcher, pria, _env) = started().await;
    send(&router, "just a prompt, no fleet task").await;
    control(&router, "close").await;
    assert!(
        fleet_cbs(&pria).is_empty(),
        "unbound close must emit no fleet callbacks"
    );
}

/// Close must ABORT the binding's heartbeat loop — the finding's eternal-POST
/// leak. Router-driven against a real 10ms loop: swap a tiny-interval
/// `FleetBindings` onto the cloned `AppState` before building the router (the
/// crate has no virtual-time idiom; same approach as F7's real-interval row).
#[tokio::test]
async fn t1_close_stops_the_heartbeat_loop() {
    let pria = Arc::new(FakePriaClient::default());
    let launcher = Arc::new(FakeLauncher::default());
    let env = test_env(pria.clone(), active_user_os(), launcher);
    let mut state = env.state.clone();
    state.fleet = Arc::new(FleetBindings::new(
        pria.clone() as Arc<dyn PriaCallbackClient>,
        Duration::from_millis(10),
    ));
    let router = build_router(state.clone());
    start_session(&router, &env).await;

    send(&router, &fleet_task("fj-doomed", "3")).await;
    tokio::time::sleep(Duration::from_millis(120)).await;
    let beats = fleet_cbs(&pria)
        .iter()
        .filter(|c| c["kind"] == "heartbeat")
        .count();
    assert!(beats >= 2, "loop live before close (got {beats} beats)");

    control(&router, "close").await;
    // Let any in-flight tick drain, snapshot, then prove the count is flat.
    tokio::time::sleep(Duration::from_millis(30)).await;
    let settled = fleet_cbs(&pria).len();
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(
        fleet_cbs(&pria).len(),
        settled,
        "close must abort the heartbeat loop — no signed POSTs may outlive the session"
    );
}

// ── T2: cancel — same contract as the T1 ruling ──────────────────────────────

/// Fences the missing `state.fleet` teardown in src/api/sessions.rs::cancel:
/// cancel on a bound session emits exactly one session_closed result, clears,
/// and a SECOND cancel emits nothing (exactly-once under repeated teardown —
/// cancel leaves the session in the store, so the route stays reachable).
#[tokio::test]
async fn t2_cancel_on_bound_session_emits_session_closed_once_and_clears() {
    let (router, _launcher, pria, env) = started().await;
    send(&router, &fleet_task("fj-doomed", "9")).await;

    control(&router, "cancel").await;

    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs.len(), 2, "exactly one teardown result after cancel: {cbs:?}");
    assert_session_closed(&cbs[1], "fj-doomed", 9);
    assert!(
        env.state.fleet.binding("sess_abc").is_none(),
        "cancel must clear the binding"
    );

    // Exactly once: a repeat cancel (route still live) and stray relay events
    // must all be silent.
    control(&router, "cancel").await;
    env.state.fleet.on_agent_end("sess_abc").await;
    env.state.fleet.on_session_eof("sess_abc").await;
    assert_eq!(
        fleet_cbs(&pria).len(),
        2,
        "no further callbacks of any kind after cancel"
    );
}

/// Cancel must abort the heartbeat loop too (same leak as T1's loop row).
#[tokio::test]
async fn t2_cancel_stops_the_heartbeat_loop() {
    let pria = Arc::new(FakePriaClient::default());
    let launcher = Arc::new(FakeLauncher::default());
    let env = test_env(pria.clone(), active_user_os(), launcher);
    let mut state = env.state.clone();
    state.fleet = Arc::new(FleetBindings::new(
        pria.clone() as Arc<dyn PriaCallbackClient>,
        Duration::from_millis(10),
    ));
    let router = build_router(state.clone());
    start_session(&router, &env).await;

    send(&router, &fleet_task("fj-doomed", "9")).await;
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert!(
        fleet_cbs(&pria).iter().any(|c| c["kind"] == "heartbeat"),
        "loop live before cancel"
    );

    control(&router, "cancel").await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    let settled = fleet_cbs(&pria).len();
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(
        fleet_cbs(&pria).len(),
        settled,
        "cancel must abort the heartbeat loop"
    );
}

// ── T3: relay read-Err arm ≡ EOF ─────────────────────────────────────────────

/// Fences the relay's `Err(_)` arm (relay_agent_end_usage,
/// src/synaps/launcher.rs — currently `warn + break` WITHOUT notifying fleet):
/// a read error while bound must behave exactly like EOF —
/// `result {ok:false, error.code=="session_exited"}` + clear. Driven HONESTLY:
/// a real `sh -c` child writes invalid UTF-8, which tokio's
/// `Lines::next_line` surfaces as `Err(InvalidData)` (verified against this
/// toolchain), so this exercises the Err arm itself, not a seam stand-in. The
/// relay breaks on the FIRST Err, so the child's later EOF is never observed —
/// precisely the finding's "EOF never observed" leak path.
#[tokio::test]
async fn t3_relay_read_err_while_bound_emits_session_exited_and_clears() {
    let pria = Arc::new(FakePriaClient::default());
    let fleet = Arc::new(FleetBindings::new(
        pria.clone() as Arc<dyn PriaCallbackClient>,
        Duration::from_secs(30),
    ));
    fleet
        .bind(
            "sess_err",
            FleetDirective {
                handle_id: "fj-err".into(),
                generation: 6,
            },
        )
        .await;
    fleet.mark_running("sess_err");

    // Invalid UTF-8 on the first line → next_line Err(InvalidData) → Err arm.
    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg("printf '\\377\\376\\n'")
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn test child");
    let stdout = child.stdout.take().expect("child stdout");
    let identity = UsageIdentity {
        account_id: "acct_1".into(),
        instance_id: "inst_2".into(),
        user_id: "user_3".into(),
        vm_id: "vm_4".into(),
        replica_id: "r0".into(),
        session_id: "sess_err".into(),
        ephemeral_task_id: None,
    };
    relay_agent_end_usage(stdout, identity, pria.clone(), fleet.clone()).await;

    let cbs = fleet_cbs(&pria);
    assert_eq!(
        cbs.len(),
        2,
        "ack + session_exited result on read-Err (Err arm must not break silently): {cbs:?}"
    );
    assert_eq!(cbs[1]["kind"], "result");
    assert_eq!(cbs[1]["handle_id"], "fj-err");
    assert_eq!(cbs[1]["generation"], 6);
    assert_eq!(cbs[1]["payload"]["ok"], false);
    assert_eq!(cbs[1]["payload"]["error"]["code"], "session_exited");
    assert!(
        fleet.binding("sess_err").is_none(),
        "read-Err must clear the binding like EOF does"
    );
}

// ── T4: rebind after teardown-clear ──────────────────────────────────────────

/// After a cancel teardown-clear, a NEW fleet set_task on the SAME session id
/// binds fresh: ack under the new handle, fresh Acked phase (its own agent_end
/// ignored), result under the new handle only — no state bleed from the
/// torn-down binding.
#[tokio::test]
async fn t4_rebind_same_session_after_cancel_teardown_works_fresh() {
    let (router, _launcher, pria, env) = started().await;
    send(&router, &fleet_task("fj-doomed", "3")).await;
    control(&router, "cancel").await;
    assert!(env.state.fleet.binding("sess_abc").is_none(), "torn down");

    send(&router, &fleet_task("fj-fresh", "4")).await;
    let cbs = fleet_cbs(&pria);
    let last = cbs.last().expect("rebind acks");
    assert_eq!(last["kind"], "ack", "fresh ack after teardown: {cbs:?}");
    assert_eq!(last["handle_id"], "fj-fresh");
    assert_eq!(last["generation"], 4);

    // Fresh Acked phase: no Running leftover from the old binding.
    env.state.fleet.on_agent_end("sess_abc").await;
    assert_eq!(
        fleet_cbs(&pria).last().unwrap()["kind"],
        "ack",
        "the fresh binding's set_task agent_end is ignored (Acked, not stale Running)"
    );
    send(&router, "begin").await;
    env.state.fleet.on_agent_end("sess_abc").await;
    let cbs = fleet_cbs(&pria);
    let last = cbs.last().unwrap();
    assert_eq!(last["kind"], "result");
    assert_eq!(last["handle_id"], "fj-fresh");
    assert_eq!(last["payload"]["ok"], true);
    assert!(
        cbs.iter()
            .all(|c| c["handle_id"] != "fj-doomed" || c["kind"] != "heartbeat"),
        "the torn-down handle never heartbeats again: {cbs:?}"
    );
}

/// After a close teardown-clear (which also removes the session from the
/// store), RE-STARTING the same session id and dispatching a fleet task works
/// fresh — a new ack under the new handle on the new process.
#[tokio::test]
async fn t4_rebind_same_session_after_close_via_restart_works_fresh() {
    let (router, launcher, pria, env) = started().await;
    send(&router, &fleet_task("fj-doomed", "3")).await;
    control(&router, "close").await;

    // Same session id, fresh start (close removed it from the store).
    start_session(&router, &env).await;
    send(&router, &fleet_task("fj-fresh", "1")).await;

    let cbs = fleet_cbs(&pria);
    let last = cbs.last().expect("rebind acks");
    assert_eq!(last["kind"], "ack");
    assert_eq!(last["handle_id"], "fj-fresh");
    assert_eq!(last["generation"], 1);
    assert!(
        env.state.fleet.binding("sess_abc").is_some(),
        "rebound after restart"
    );
    // The fleet text reached the NEW process (launch index 1) unchanged.
    let sent = launcher.launched.lock().unwrap()[1]
        .sent
        .lock()
        .unwrap()
        .clone();
    assert_eq!(sent, vec![fleet_task("fj-fresh", "1")]);
}
