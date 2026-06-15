//! GA-B5 principal reconcile/disable handler tests (spec §6.2/§6.3, §13.5).

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::json;
use tower::ServiceExt;

use pria_guest_agent::api::build_router;
use pria_guest_agent::os::{FakeUserManager, UserRecord};
use pria_guest_agent::pria_client::fake::FakePriaClient;
use pria_guest_agent::test_support::test_state_full;

fn post(uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn reconcile_creates_then_is_idempotent() {
    let pria = Arc::new(FakePriaClient::default());
    let os = Arc::new(FakeUserManager::default());
    let state = test_state_full(pria.clone(), os.clone());

    let body = json!({
        "account_id": "acct_123",
        "desired": [{
            "user_id": "user_abc",
            "linux_username": "pria_u_104251",
            "uid": 104251,
            "gid": 104251,
            "state": "active",
            "home_dir": "/home/pria_u_104251",
            "instance_ids": ["inst_1"]
        }],
        "request_id": "req_1"
    });

    let resp = build_router(state.clone())
        .oneshot(post("/guest/v1/principals/reconcile", body.clone()))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v: serde_json::Value =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(v["results"][0]["action"], "created");
    assert_eq!(v["results"][0]["ok"], true);

    // Second apply -> unchanged (idempotent).
    let resp2 = build_router(state)
        .oneshot(post("/guest/v1/principals/reconcile", body))
        .await
        .unwrap();
    let v2: serde_json::Value =
        serde_json::from_slice(&resp2.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(v2["results"][0]["action"], "unchanged");

    // principal.created audit emitted.
    let audits = pria.audits.lock().unwrap();
    assert!(audits.iter().any(|a| a["kind"] == "principal.created"));
}

#[tokio::test]
async fn reconcile_accepts_per_account_group_name() {
    // The control plane sends a deterministic per-account `group_name` + gid so
    // the guest creates a private primary group before `useradd --gid`. The
    // payload must be accepted (no 400) and the principal created.
    let pria = Arc::new(FakePriaClient::default());
    let os = Arc::new(FakeUserManager::default());
    let state = test_state_full(pria.clone(), os.clone());

    let body = json!({
        "account_id": "acct_123",
        "desired": [{
            "user_id": "user_abc",
            "linux_username": "pria_u_104251",
            "uid": 104251,
            "gid": 14242,
            "group_name": "acct_acme",
            "state": "active",
            "home_dir": "/home/pria_u_104251",
            "instance_ids": ["inst_1"]
        }],
        "request_id": "req_grp"
    });

    let resp = build_router(state.clone())
        .oneshot(post("/guest/v1/principals/reconcile", body))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v: serde_json::Value =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(v["results"][0]["action"], "created");
    assert_eq!(v["results"][0]["ok"], true);
}

#[tokio::test]
async fn reconcile_rejects_home_dir_traversal() {
    let state = test_state_full(
        Arc::new(FakePriaClient::default()),
        Arc::new(FakeUserManager::default()),
    );
    let body = json!({
        "account_id": "acct_123",
        "desired": [{
            "user_id": "u",
            "linux_username": "x",
            "uid": 1000,
            "gid": 1000,
            "home_dir": "/home/../etc/evil"
        }]
    });
    let resp = build_router(state)
        .oneshot(post("/guest/v1/principals/reconcile", body))
        .await
        .unwrap();
    let v: serde_json::Value =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(v["results"][0]["ok"], false);
    assert_eq!(v["results"][0]["action"], "rejected");
}

#[tokio::test]
async fn reconcile_wrong_account_is_forbidden() {
    let state = test_state_full(
        Arc::new(FakePriaClient::default()),
        Arc::new(FakeUserManager::default()),
    );
    let body = json!({ "account_id": "acct_OTHER", "desired": [] });
    let resp = build_router(state)
        .oneshot(post("/guest/v1/principals/reconcile", body))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn disable_locks_principal_and_kills_sessions() {
    let os = Arc::new(FakeUserManager::default().with_user(UserRecord {
        username: "pria_u_104251".into(),
        uid: 104251,
        gid: 104251,
        active: true,
    }));
    let pria = Arc::new(FakePriaClient::default());
    let state = test_state_full(pria.clone(), os.clone());
    let body = json!({
        "account_id": "acct_123",
        "user_id": "user_abc",
        "linux_username": "pria_u_104251",
        "kill_active_sessions": true,
        "reason": "membership_revoked",
        "request_id": "req_x"
    });
    let resp = build_router(state)
        .oneshot(post("/guest/v1/principals/disable", body))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v: serde_json::Value =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(v["disabled"], true);
    assert!(os.killed.lock().unwrap().contains(&104251));
    assert!(pria
        .audits
        .lock()
        .unwrap()
        .iter()
        .any(|a| a["kind"] == "principal.disabled"));
}

#[tokio::test]
async fn disable_unknown_principal_is_not_found() {
    let state = test_state_full(
        Arc::new(FakePriaClient::default()),
        Arc::new(FakeUserManager::default()),
    );
    let body = json!({
        "account_id": "acct_123",
        "user_id": "u",
        "linux_username": "ghost"
    });
    let resp = build_router(state)
        .oneshot(post("/guest/v1/principals/disable", body))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}
