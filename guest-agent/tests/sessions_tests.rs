//! GA-B6 session start/control handler tests (spec §6.4/§6.5, §13.5).

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;

use pria_guest_agent::api::build_router;
use pria_guest_agent::os::{FakeUserManager, OsUserManager, UserRecord};
use pria_guest_agent::pria_client::fake::FakePriaClient;
use pria_guest_agent::synaps::launcher::FakeLauncher;
use pria_guest_agent::test_support::{test_env, TestEnv};

fn post(uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// The uid these tests run as.
///
/// `/sessions/start` chowns the per-UID Synaps socket dir and then VERIFIES it
/// retained that owner. Only root may chown to an arbitrary uid, so a fictional
/// fixture uid made the entire handler — readiness handshake included —
/// unreachable without root. Using the caller's own uid keeps the invariant
/// under test while letting the suite run unprivileged (and it still passes as
/// root, where the chown is unrestricted).
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
        "account_id": "acct_123",
        "instance_id": "inst_456",
        "user_id": "user_789",
        "session_id": "sess_abc",
        "vm_id": "vm_456",
        "linux_username": test_username(),
        "uid": test_uid(),
        "gid": test_uid(),
        "policy_profile_id": "policy_default",
        "policy_version": 17,
        "policy_hash": "sha256:abc",
        "workspace_dir": ws.to_string_lossy(),
        "session_dir": sd.to_string_lossy(),
        "roles": ["agent_operator"],
        "transport": {"kind": "pria-agent-websocket"},
        "request_id": "req_1"
    })
}

#[tokio::test]
async fn start_writes_context_launches_nonroot_and_audits() {
    let pria = Arc::new(FakePriaClient::default());
    let launcher = Arc::new(FakeLauncher::default());
    let env = env_with(launcher.clone(), pria.clone());
    let body = start_body(&env);
    let state = env.state.clone();

    let resp = build_router(state.clone())
        .oneshot(post("/guest/v1/sessions/start", body))
        .await
        .unwrap();
    let st = resp.status();
    let v: serde_json::Value =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(st, StatusCode::OK, "body: {v}");
    // `/sessions/start` no longer returns while readiness is unproven: the
    // guest waits for Synaps' own RPC `ready` frame and reports it as a receipt.
    assert_eq!(v["status"], "ready");
    assert_eq!(v["ready"], true);
    assert_eq!(v["ready_model"], "claude-sonnet-4-6");
    assert_eq!(v["ready_protocol_version"], 1);
    assert!(!v["ready_at"].as_str().unwrap().is_empty());
    assert_eq!(v["session_id"], "sess_abc");
    assert!(v["pid"].as_u64().unwrap() > 0);

    let context_path = v["context_path"].as_str().unwrap();
    let raw = std::fs::read_to_string(context_path).unwrap();
    let ctx: serde_json::Value = serde_json::from_str(&raw).unwrap();
    for f in [
        "account_id",
        "instance_id",
        "user_id",
        "linux_username",
        "linux_uid",
        "vm_id",
        "session_id",
        "roles",
        "issued_at",
        "expires_at",
    ] {
        assert!(ctx.get(f).is_some(), "missing context field {f}");
    }

    let launches = launcher.launches.lock().unwrap();
    assert_eq!(launches[0].uid, test_uid());
    assert_eq!(launches[0].gid, test_uid());
    assert_ne!(launches[0].uid, 0);
    // Privilege drop carries the user's resolved group list (here just the
    // primary gid) so the child runs setgroups → it never inherits root's
    // supplementary groups (spec §16.3).
    assert!(
        launches[0].groups.contains(&test_uid()),
        "launch must carry the user's primary gid for setgroups"
    );
    assert!(
        !launches[0].groups.contains(&0),
        "launch group list must never contain root's gid 0"
    );

    assert!(pria
        .audits
        .lock()
        .unwrap()
        .iter()
        .any(|a| a["kind"] == "session.started"));
    assert_eq!(state.runtime.active_sessions(), 1);
}

#[tokio::test]
async fn start_passes_instance_group_to_setgroups() {
    // A user who has joined an instance group must have that gid in the launch
    // group list — this is the link that makes per-instance dir access work
    // (the child runs with the `inst_<id>` group via setgroups).
    let pria = Arc::new(FakePriaClient::default());
    let launcher = Arc::new(FakeLauncher::default());
    let os = Arc::new(FakeUserManager::default().with_user(UserRecord {
        username: test_username(),
        uid: test_uid(),
        gid: test_uid(),
        active: true,
    }));
    os.ensure_group_membership(&test_username(), 60001, "inst_x")
        .await
        .unwrap();
    let env = test_env(pria.clone(), os.clone(), launcher.clone());
    let body = start_body(&env);

    let resp = build_router(env.state.clone())
        .oneshot(post("/guest/v1/sessions/start", body))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let launches = launcher.launches.lock().unwrap();
    assert!(
        launches[0].groups.contains(&test_uid()) && launches[0].groups.contains(&60001),
        "launch groups must include the primary gid AND the joined instance gid, got {:?}",
        launches[0].groups
    );
}

#[tokio::test]
async fn start_refused_for_disabled_principal() {
    let os = Arc::new(FakeUserManager::default().with_user(UserRecord {
        username: test_username(),
        uid: test_uid(),
        gid: test_uid(),
        active: false,
    }));
    let env = test_env(
        Arc::new(FakePriaClient::default()),
        os,
        Arc::new(FakeLauncher::default()),
    );
    let body = start_body(&env);
    let resp = build_router(env.state)
        .oneshot(post("/guest/v1/sessions/start", body))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn start_refused_as_root() {
    let env = env_with(
        Arc::new(FakeLauncher::default()),
        Arc::new(FakePriaClient::default()),
    );
    let mut body = start_body(&env);
    body["uid"] = json!(0);
    body["gid"] = json!(0);
    let resp = build_router(env.state)
        .oneshot(post("/guest/v1/sessions/start", body))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn start_rejects_path_traversal_in_dirs() {
    let env = env_with(
        Arc::new(FakeLauncher::default()),
        Arc::new(FakePriaClient::default()),
    );
    let mut body = start_body(&env);
    body["session_dir"] = json!(env
        .efs_root
        .join("sessions/../../../../etc/evil")
        .to_string_lossy());
    let resp = build_router(env.state)
        .oneshot(post("/guest/v1/sessions/start", body))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn start_rejects_workspace_outside_efs_root() {
    let env = env_with(
        Arc::new(FakeLauncher::default()),
        Arc::new(FakePriaClient::default()),
    );
    let mut body = start_body(&env);
    body["workspace_dir"] = json!("/tmp/outside/workspace");
    let resp = build_router(env.state)
        .oneshot(post("/guest/v1/sessions/start", body))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn duplicate_session_conflicts() {
    let env = env_with(
        Arc::new(FakeLauncher::default()),
        Arc::new(FakePriaClient::default()),
    );
    let body = start_body(&env);
    let router = build_router(env.state);
    assert_eq!(
        router
            .clone()
            .oneshot(post("/guest/v1/sessions/start", body.clone()))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        router
            .oneshot(post("/guest/v1/sessions/start", body))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn send_status_and_close_lifecycle() {
    let env = env_with(
        Arc::new(FakeLauncher::default()),
        Arc::new(FakePriaClient::default()),
    );
    let body = start_body(&env);
    let state = env.state.clone();
    let router = build_router(state.clone());
    router
        .clone()
        .oneshot(post("/guest/v1/sessions/start", body))
        .await
        .unwrap();

    let send = router
        .clone()
        .oneshot(post(
            "/guest/v1/sessions/sess_abc/send",
            json!({"input": "hello"}),
        ))
        .await
        .unwrap();
    assert_eq!(send.status(), StatusCode::OK);

    let st = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/guest/v1/sessions/sess_abc/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(st.status(), StatusCode::OK);

    let close = router
        .clone()
        .oneshot(post(
            "/guest/v1/sessions/sess_abc/close",
            json!({"reason": "user_closed", "grace_period_ms": 100}),
        ))
        .await
        .unwrap();
    assert_eq!(close.status(), StatusCode::OK);
    assert_eq!(state.runtime.active_sessions(), 0);

    let st2 = router
        .oneshot(
            Request::builder()
                .uri("/guest/v1/sessions/sess_abc/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(st2.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn send_to_unknown_session_is_not_found() {
    let env = env_with(
        Arc::new(FakeLauncher::default()),
        Arc::new(FakePriaClient::default()),
    );
    let resp = build_router(env.state)
        .oneshot(post("/guest/v1/sessions/ghost/send", json!({"input": "x"})))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// ── RPC readiness handshake (the gate `/sessions/start` fails closed on) ─────
//
// A live PID never proved Synaps could accept a prompt: fast presets raced the
// async readiness callback and the workflow gate correctly refused to deliver.
// These drive the handshake's four failure shapes through the real handler.

/// Start with a scripted child stdout and return (status, body).
async fn start_with_stdout(launcher: FakeLauncher) -> (StatusCode, serde_json::Value) {
    let pria = Arc::new(FakePriaClient::default());
    let env = env_with(Arc::new(launcher), pria);
    let body = start_body(&env);
    let resp = build_router(env.state.clone())
        .oneshot(post("/guest/v1/sessions/start", body))
        .await
        .unwrap();
    let status = resp.status();
    let v: serde_json::Value =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    (status, v)
}

#[tokio::test]
async fn start_fails_closed_when_synaps_never_emits_ready() {
    // Child is alive and holding stdout open, but silent. The old handler
    // returned 200 "starting" here — a live PID it could not prompt.
    let (status, v) = start_with_stdout(FakeLauncher::silent()).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "body: {v}");
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("ready frame"),
        "expected a readiness failure, got: {v}"
    );
}

#[tokio::test]
async fn start_fails_closed_when_stdout_closes_before_ready() {
    // EOF with nothing said — the child died on its way up.
    let (status, v) = start_with_stdout(FakeLauncher::with_stdout("")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "body: {v}");
}

#[tokio::test]
async fn start_fails_closed_on_a_malformed_ready_frame() {
    // Right frame type, missing the fields that make it meaningful. A
    // half-formed ready is not readiness.
    let (status, v) = start_with_stdout(FakeLauncher::with_stdout("{\"type\":\"ready\"}\n")).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "body: {v}");
}

#[tokio::test]
async fn start_does_not_accept_a_later_frame_as_proof_of_readiness() {
    // Synaps' contract puts `ready` first. Anything else first means we cannot
    // trust the stream, even if a valid ready follows.
    let script = format!(
        "{}\n{}\n",
        r#"{"type":"agent_end","usage":{}}"#,
        r#"{"type":"ready","model":"claude-sonnet-4-6","protocol_version":1}"#
    );
    let (status, v) = start_with_stdout(FakeLauncher::with_stdout(script)).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "body: {v}");
}

#[tokio::test]
async fn start_refuses_when_the_child_has_no_output_channel() {
    // No stdout at all: readiness is unobservable, so the session must not be
    // reported as started.
    let (status, v) = start_with_stdout(FakeLauncher::no_stdout()).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "body: {v}");
    assert!(
        v["error"]["message"]
            .as_str()
            .unwrap()
            .contains("stdout unavailable"),
        "got: {v}"
    );
}
