//! GA-B6 session start/control handler tests (spec §6.4/§6.5, §13.5).

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;

use pria_guest_agent::api::build_router;
use pria_guest_agent::os::{FakeUserManager, UserRecord};
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

fn active_user_os() -> Arc<FakeUserManager> {
    Arc::new(FakeUserManager::default().with_user(UserRecord {
        username: "pria_u_104251".into(),
        uid: 104251,
        gid: 104251,
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
        "linux_username": "pria_u_104251",
        "uid": 104251,
        "gid": 104251,
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
    assert_eq!(resp.status(), StatusCode::OK);
    let v: serde_json::Value =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(v["status"], "starting");
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
    assert_eq!(launches[0].uid, 104251);
    assert_eq!(launches[0].gid, 104251);
    assert_ne!(launches[0].uid, 0);

    assert!(pria
        .audits
        .lock()
        .unwrap()
        .iter()
        .any(|a| a["kind"] == "session.started"));
    assert_eq!(state.runtime.active_sessions(), 1);
}

#[tokio::test]
async fn start_refused_for_disabled_principal() {
    let os = Arc::new(FakeUserManager::default().with_user(UserRecord {
        username: "pria_u_104251".into(),
        uid: 104251,
        gid: 104251,
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
