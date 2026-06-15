//! Desktop endpoint integration tests (spec §5.4, §8.2).
//!
//! Tests cover:
//! - POST /guest/v1/desktops/start  (start_desktop handler)
//! - POST /guest/v1/desktops/:linux_username/stop  (stop_desktop handler)
//! - GET  /guest/v1/desktops  (list_desktops handler)
//!
//! Uses FakeSystemctl + FakeUserManager — no systemd or KVM required.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use pria_guest_agent::api::build_router;
use pria_guest_agent::desktop::kasmvnc::{DesktopStore, FakeSystemctl};
use pria_guest_agent::os::{FakeUserManager, UserRecord};
use pria_guest_agent::pria_client::fake::FakePriaClient;
use pria_guest_agent::synaps::launcher::FakeLauncher;
use pria_guest_agent::test_support::{test_env, TestEnv};

fn desktop_test_env() -> (TestEnv, Arc<FakeSystemctl>) {
    let pria = Arc::new(FakePriaClient::default());
    let fake_ctl = Arc::new(FakeSystemctl::default());

    let os = Arc::new(
        FakeUserManager::default()
            .with_user(UserRecord {
                username: "pria_u_a".into(),
                uid: 12001,
                gid: 12001,
                active: true,
            })
            .with_user(UserRecord {
                username: "pria_u_b".into(),
                uid: 12002,
                gid: 12002,
                active: true,
            })
            .with_user(UserRecord {
                username: "pria_u_disabled".into(),
                uid: 12003,
                gid: 12003,
                active: false,
            }),
    );
    let synaps = Arc::new(FakeLauncher::default());
    let mut env = test_env(pria, os, synaps);

    // Replace the desktop store with one using the shared fake systemctl.
    env.state.desktops = Arc::new(DesktopStore::new(env.run_root.clone(), fake_ctl.clone()));

    (env, fake_ctl)
}

async fn body_json(body: Body) -> Value {
    let bytes = body.collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

fn post(path: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(path)
        .header("content-type", "application/json")
        // HMAC is disabled in test state
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

fn get(path: &str) -> Request<Body> {
    Request::builder()
        .method(Method::GET)
        .uri(path)
        .body(Body::empty())
        .unwrap()
}

// ── POST /desktops/start ──────────────────────────────────────────────────────

#[tokio::test]
async fn start_desktop_returns_200_with_port_display_and_password() {
    let (env, fake_ctl) = desktop_test_env();
    let app = build_router(env.state);

    let resp = app
        .oneshot(post(
            "/guest/v1/desktops/start",
            json!({
                "session_id": "sess_d1",
                "linux_username": "pria_u_a",
                "vnc_password": "vnc_secret_a",
                "request_id": "req_1"
            }),
        ))
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp.into_body()).await;
    assert_eq!(body["session_id"], "sess_d1");
    assert_eq!(body["linux_username"], "pria_u_a");
    assert_eq!(body["display"], ":1");
    assert_eq!(body["port"], 6901);
    assert_eq!(body["basic_user"], "kasm_user");
    assert_eq!(body["password"], "vnc_secret_a");
    assert_eq!(body["status"], "running");
    assert_eq!(body["request_id"], "req_1");

    // systemctl was called
    let started = fake_ctl.started.lock().unwrap();
    assert!(
        started.contains(&"kasmvnc@pria_u_a.service".to_string()),
        "expected kasmvnc@pria_u_a.service in started: {started:?}"
    );
}

#[tokio::test]
async fn start_desktop_two_users_get_distinct_ports() {
    let (env, _ctl) = desktop_test_env();
    let app = build_router(env.state);

    let r1 = app
        .clone()
        .oneshot(post(
            "/guest/v1/desktops/start",
            json!({ "session_id": "sa", "linux_username": "pria_u_a", "vnc_password": "pw1" }),
        ))
        .await
        .unwrap();
    let b1 = body_json(r1.into_body()).await;

    let r2 = app
        .oneshot(post(
            "/guest/v1/desktops/start",
            json!({ "session_id": "sb", "linux_username": "pria_u_b", "vnc_password": "pw2" }),
        ))
        .await
        .unwrap();
    let b2 = body_json(r2.into_body()).await;

    assert_ne!(b1["port"], b2["port"], "ports must be distinct");
    assert_ne!(b1["display"], b2["display"], "displays must be distinct");
    let port_a = b1["port"].as_u64().unwrap() as u16;
    let port_b = b2["port"].as_u64().unwrap() as u16;
    assert!((6901..6903).contains(&port_a));
    assert!((6901..6903).contains(&port_b));
}

#[tokio::test]
async fn start_desktop_principal_not_found_returns_404() {
    let (env, _ctl) = desktop_test_env();
    let app = build_router(env.state);

    let resp = app
        .oneshot(post(
            "/guest/v1/desktops/start",
            json!({ "session_id": "sx", "linux_username": "no_such_user", "vnc_password": "pw" }),
        ))
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let body = body_json(resp.into_body()).await;
    assert_eq!(body["error"]["code"], "principal_not_found");
}

#[tokio::test]
async fn start_desktop_disabled_principal_returns_403() {
    let (env, _ctl) = desktop_test_env();
    let app = build_router(env.state);

    let resp = app
        .oneshot(post(
            "/guest/v1/desktops/start",
            json!({ "session_id": "sx", "linux_username": "pria_u_disabled", "vnc_password": "pw" }),
        ))
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let body = body_json(resp.into_body()).await;
    assert_eq!(body["error"]["code"], "principal_disabled");
}

#[tokio::test]
async fn start_desktop_empty_password_returns_400() {
    let (env, _ctl) = desktop_test_env();
    let app = build_router(env.state);

    let resp = app
        .oneshot(post(
            "/guest/v1/desktops/start",
            json!({ "session_id": "sx", "linux_username": "pria_u_a", "vnc_password": "" }),
        ))
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let body = body_json(resp.into_body()).await;
    assert_eq!(body["error"]["code"], "invalid_request");
}

#[tokio::test]
async fn start_desktop_emits_audit_event() {
    let pria = Arc::new(FakePriaClient::default());
    let pria_clone = pria.clone();
    let fake_ctl = Arc::new(FakeSystemctl::default());
    let os = Arc::new(FakeUserManager::default().with_user(UserRecord {
        username: "pria_u_a".into(),
        uid: 12001,
        gid: 12001,
        active: true,
    }));
    let synaps = Arc::new(FakeLauncher::default());
    let mut env = test_env(pria, os, synaps);
    env.state.desktops = Arc::new(DesktopStore::new(env.run_root.clone(), fake_ctl));
    let app = build_router(env.state);

    app.oneshot(post(
        "/guest/v1/desktops/start",
        json!({ "session_id": "sess_audit", "linux_username": "pria_u_a", "vnc_password": "pw" }),
    ))
    .await
    .unwrap();

    let audits = pria_clone.audits.lock().unwrap();
    let ev = audits.iter().find(|e| e["kind"] == "desktop.started");
    assert!(ev.is_some(), "desktop.started audit event must be emitted");
    let ev = ev.unwrap();
    assert_eq!(ev["linux_username"], "pria_u_a");
    // password MUST NOT appear in audit
    let audit_str = serde_json::to_string(ev).unwrap();
    assert!(
        !audit_str.contains("pw"),
        "password must not appear in audit: {audit_str}"
    );
}

// ── POST /desktops/:linux_username/stop ───────────────────────────────────────

#[tokio::test]
async fn stop_desktop_calls_systemctl_and_returns_200() {
    let (env, fake_ctl) = desktop_test_env();
    let app = build_router(env.state);

    // Start first.
    app.clone()
        .oneshot(post(
            "/guest/v1/desktops/start",
            json!({ "session_id": "sa", "linux_username": "pria_u_a", "vnc_password": "pw" }),
        ))
        .await
        .unwrap();

    // Stop.
    let resp = app
        .oneshot(post(
            "/guest/v1/desktops/pria_u_a/stop",
            json!({ "reason": "session closed" }),
        ))
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp.into_body()).await;
    assert_eq!(body["linux_username"], "pria_u_a");
    assert_eq!(body["status"], "stopped");

    let stopped = fake_ctl.stopped.lock().unwrap();
    assert!(
        stopped.contains(&"kasmvnc@pria_u_a.service".to_string()),
        "systemctl stop must be called"
    );
}

// ── GET /desktops ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn list_desktops_empty_when_no_sessions() {
    let (env, _ctl) = desktop_test_env();
    let app = build_router(env.state);

    let resp = app.oneshot(get("/guest/v1/desktops")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp.into_body()).await;
    assert_eq!(body["sessions"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn list_desktops_returns_spec_8_2_fields() {
    let (env, _ctl) = desktop_test_env();
    let app = build_router(env.state);

    // Start two sessions.
    app.clone()
        .oneshot(post(
            "/guest/v1/desktops/start",
            json!({ "session_id": "sa", "linux_username": "pria_u_a", "vnc_password": "pw_a" }),
        ))
        .await
        .unwrap();
    app.clone()
        .oneshot(post(
            "/guest/v1/desktops/start",
            json!({ "session_id": "sb", "linux_username": "pria_u_b", "vnc_password": "pw_b" }),
        ))
        .await
        .unwrap();

    let resp = app.oneshot(get("/guest/v1/desktops")).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp.into_body()).await;
    let sessions = body["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2, "both desktop sessions must appear");

    for s in sessions {
        // Spec §8.2 required fields.
        assert!(s["session_id"].is_string() && !s["session_id"].as_str().unwrap().is_empty());
        assert!(s["linux_username"].is_string());
        assert!(
            s["display"].as_str().unwrap().starts_with(':'),
            "display must start with ':'"
        );
        assert!(s["port"].as_u64().unwrap() >= 6901);
        assert_eq!(s["basic_user"], "kasm_user");
        // password must be present (controller needs it for Basic auth, spec §5.1)
        assert!(!s["password"].as_str().unwrap().is_empty());
    }

    // Ports must be distinct (multi-user isolation).
    let ports: std::collections::HashSet<u64> = sessions
        .iter()
        .map(|s| s["port"].as_u64().unwrap())
        .collect();
    assert_eq!(ports.len(), 2, "each session must have a unique port");
}

#[tokio::test]
async fn list_desktops_after_stop_removes_session() {
    let (env, _ctl) = desktop_test_env();
    let app = build_router(env.state);

    app.clone()
        .oneshot(post(
            "/guest/v1/desktops/start",
            json!({ "session_id": "sa", "linux_username": "pria_u_a", "vnc_password": "pw" }),
        ))
        .await
        .unwrap();

    app.clone()
        .oneshot(post("/guest/v1/desktops/pria_u_a/stop", json!({})))
        .await
        .unwrap();

    let resp = app.oneshot(get("/guest/v1/desktops")).await.unwrap();
    let body = body_json(resp.into_body()).await;
    assert_eq!(
        body["sessions"].as_array().unwrap().len(),
        0,
        "session must be removed after stop"
    );
}
