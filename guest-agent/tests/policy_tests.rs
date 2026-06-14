//! GA-B7 policy/apply handler tests (spec §6.6, §13.5 fail-closed).

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;

use pria_guest_agent::api::build_router;
use pria_guest_agent::fsmon::client::FakeFsmonControl;
use pria_guest_agent::os::FakeUserManager;
use pria_guest_agent::pria_client::fake::FakePriaClient;
use pria_guest_agent::synaps::launcher::FakeLauncher;
use pria_guest_agent::test_support::test_env;

fn post(uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn valid_policy() -> serde_json::Value {
    json!({
        "account_id": "acct_123",
        "policy_profile_id": "policy_default",
        "policy_version": 17,
        "policy_hash": "sha256:abc123",
        "compiled_from": "yaml",
        "mode": "block",
        "rules": {
            "filesystem": {"default": "allow", "deny": ["/etc/**", "/home/*/.ssh/**"], "observe": []},
            "tools": {"credential_required": ["slack", "github", "aws"]}
        }
    })
}

async fn body_json(resp: axum::response::Response) -> serde_json::Value {
    serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn applies_valid_policy_to_fsmon_and_reports_hash() {
    let pria = Arc::new(FakePriaClient::default());
    let fsmon = Arc::new(FakeFsmonControl::healthy());
    let mut env = test_env(
        pria.clone(),
        Arc::new(FakeUserManager::default()),
        Arc::new(FakeLauncher::default()),
    );
    env.state.fsmon = fsmon.clone();
    let state = env.state.clone();

    let resp = build_router(state.clone())
        .oneshot(post("/guest/v1/policy/apply", valid_policy()))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["applied"], true);
    assert_eq!(v["policy_hash"], "sha256:abc123");
    assert_eq!(v["fsmon_applied"], true);
    assert_eq!(v["synaps_plugin_policy_applied"], true);

    // fsmon received the compiled policy.
    assert_eq!(fsmon.applied.lock().unwrap().len(), 1);
    // policy summary recorded for health.
    assert_eq!(
        state.runtime.policy().policy_hash.as_deref(),
        Some("sha256:abc123")
    );
    // policy.applied audit emitted.
    assert!(pria
        .audits
        .lock()
        .unwrap()
        .iter()
        .any(|a| a["kind"] == "policy.applied"));
}

#[tokio::test]
async fn invalid_policy_is_rejected_fail_closed() {
    let pria = Arc::new(FakePriaClient::default());
    let fsmon = Arc::new(FakeFsmonControl::healthy());
    let mut env = test_env(
        pria.clone(),
        Arc::new(FakeUserManager::default()),
        Arc::new(FakeLauncher::default()),
    );
    env.state.fsmon = fsmon.clone();

    let mut bad = valid_policy();
    bad["policy_hash"] = json!("not-a-digest");
    let resp = build_router(env.state)
        .oneshot(post("/guest/v1/policy/apply", bad))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    // Nothing was applied to fsmon (no fail-open).
    assert_eq!(fsmon.applied.lock().unwrap().len(), 0);
    assert!(pria
        .audits
        .lock()
        .unwrap()
        .iter()
        .any(|a| a["kind"] == "policy.rejected"));
}

#[tokio::test]
async fn fsmon_down_reports_unavailable_warning_but_still_applies_plugin() {
    let fsmon = Arc::new(FakeFsmonControl::unavailable());
    let mut env = test_env(
        Arc::new(FakePriaClient::default()),
        Arc::new(FakeUserManager::default()),
        Arc::new(FakeLauncher::default()),
    );
    env.state.fsmon = fsmon.clone();

    let resp = build_router(env.state)
        .oneshot(post("/guest/v1/policy/apply", valid_policy()))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["fsmon_applied"], false);
    let warnings = v["warnings"].as_array().unwrap();
    assert!(warnings
        .iter()
        .any(|w| w.as_str().unwrap().contains("fsmon_unavailable")));
}

#[tokio::test]
async fn wrong_account_is_forbidden() {
    let env = test_env(
        Arc::new(FakePriaClient::default()),
        Arc::new(FakeUserManager::default()),
        Arc::new(FakeLauncher::default()),
    );
    let mut body = valid_policy();
    body["account_id"] = json!("acct_OTHER");
    let resp = build_router(env.state)
        .oneshot(post("/guest/v1/policy/apply", body))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}
