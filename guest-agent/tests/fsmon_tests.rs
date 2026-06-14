//! GA-B8 fsmon status/reload + audit-forward relay tests (spec §6.7/§7.2).

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;

use pria_guest_agent::api::build_router;
use pria_guest_agent::fsmon::client::FakeFsmonControl;
use pria_guest_agent::fsmon::relay::handle_line;
use pria_guest_agent::os::FakeUserManager;
use pria_guest_agent::pria_client::fake::FakePriaClient;
use pria_guest_agent::synaps::launcher::FakeLauncher;
use pria_guest_agent::test_support::test_env;

fn apply_body() -> serde_json::Value {
    json!({
        "account_id": "acct_123",
        "policy_profile_id": "policy_default",
        "policy_version": 17,
        "policy_hash": "sha256:abc123",
        "mode": "block",
        "rules": {"filesystem": {"default": "allow", "deny": ["/etc/**"], "observe": []}}
    })
}

#[tokio::test]
async fn status_reports_healthy_and_decision_counts() {
    let fsmon = Arc::new(FakeFsmonControl::healthy());
    let mut env = test_env(
        Arc::new(FakePriaClient::default()),
        Arc::new(FakeUserManager::default()),
        Arc::new(FakeLauncher::default()),
    );
    env.state.fsmon = fsmon.clone();
    let state = env.state.clone();
    // simulate some relayed decisions
    state.runtime.record_decision("deny");
    state.runtime.record_decision("allow");
    state.runtime.record_decision("allow");

    let resp = build_router(state)
        .oneshot(
            Request::builder()
                .uri("/guest/v1/fsmon/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v: serde_json::Value =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(v["status"], "healthy");
    assert_eq!(v["decisions"]["denied"], 1);
    assert_eq!(v["decisions"]["allowed"], 2);
}

#[tokio::test]
async fn status_reports_unavailable_when_fsmon_down() {
    let fsmon = Arc::new(FakeFsmonControl::unavailable());
    let mut env = test_env(
        Arc::new(FakePriaClient::default()),
        Arc::new(FakeUserManager::default()),
        Arc::new(FakeLauncher::default()),
    );
    env.state.fsmon = fsmon.clone();
    let resp = build_router(env.state)
        .oneshot(
            Request::builder()
                .uri("/guest/v1/fsmon/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let v: serde_json::Value =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(v["status"], "unavailable");
    assert!(v["last_error"].is_string());
}

#[tokio::test]
async fn reload_repushes_last_policy() {
    let fsmon = Arc::new(FakeFsmonControl::healthy());
    let mut env = test_env(
        Arc::new(FakePriaClient::default()),
        Arc::new(FakeUserManager::default()),
        Arc::new(FakeLauncher::default()),
    );
    env.state.fsmon = fsmon.clone();
    let router = build_router(env.state.clone());

    // apply once
    router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/guest/v1/policy/apply")
                .header("content-type", "application/json")
                .body(Body::from(apply_body().to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(fsmon.applied.lock().unwrap().len(), 1);

    // reload -> re-pushes
    let resp = router
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/guest/v1/fsmon/reload")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v: serde_json::Value =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(v["reloaded"], true);
    assert_eq!(v["fsmon_applied"], true);
    assert_eq!(fsmon.applied.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn relay_forwards_fsmon_decisions_with_session_context() {
    let pria = Arc::new(FakePriaClient::default());
    let env = test_env(
        pria.clone(),
        Arc::new(FakeUserManager::default()),
        Arc::new(FakeLauncher::default()),
    );
    let state = env.state.clone();
    let envelope = json!({
        "source": "synaps-sidecar",
        "events": [
            {"kind": "file.write.denied", "decision": "deny", "linux_uid": 12001, "path": "/srv/x"}
        ]
    });
    handle_line(&state, &envelope.to_string()).await;
    let audits = pria.audits.lock().unwrap();
    assert_eq!(audits.len(), 1);
    assert_eq!(audits[0]["kind"], "file.write.denied");
    assert_eq!(audits[0]["vm_id"], "vm_456");
    assert_eq!(state.runtime.fsmon_decisions().denied, 1);
}
