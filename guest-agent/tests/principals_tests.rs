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

#[tokio::test]
async fn reconcile_with_instance_groups_grants_membership_and_isolates_dir() {
    use pria_guest_agent::synaps::launcher::FakeLauncher;
    use pria_guest_agent::test_support::test_env;

    let pria = Arc::new(FakePriaClient::default());
    let os = Arc::new(FakeUserManager::default());
    // Writable temp efs_root so the per-instance directory can be created.
    let env = test_env(pria.clone(), os.clone(), Arc::new(FakeLauncher::default()));
    let efs_root = env.efs_root.clone();

    let body = json!({
        "account_id": "acct_123",
        "desired": [{
            "user_id": "user_abc",
            "linux_username": "pria_u_104251",
            "uid": 104251,
            "gid": 14952,
            "state": "active",
            "group_name": "acct_x",
            "instance_ids": ["507f1f77bcf86cd799439011"],
            "instance_groups": [{
                "id": "507f1f77bcf86cd799439011",
                "name": "inst_507f1f77bcf86cd799439011",
                "gid": 60001
            }]
        }],
        "request_id": "req_iso"
    });

    let resp = build_router(env.state.clone())
        .oneshot(post("/guest/v1/principals/reconcile", body))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v: serde_json::Value =
        serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();

    // Wiring proof (CI-safe, no privilege needed): the handler asked the OS to
    // add the user to the per-instance group BEFORE attempting the dir.
    let m = os.memberships_of("pria_u_104251");
    assert!(
        m.iter().any(|(g, n)| *g == 60001 && n == "inst_507f1f77bcf86cd799439011"),
        "user must be added to the instance group"
    );

    let is_root = unsafe { libc::geteuid() } == 0;
    if is_root {
        // Full success: dir exists, mode 2770 + setgid, group = instance gid.
        assert_eq!(v["results"][0]["ok"], true);
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;
        let dir = efs_root.join("instances").join("507f1f77bcf86cd799439011");
        let md = std::fs::metadata(&dir).expect("instance dir must exist");
        assert!(md.is_dir());
        assert_eq!(md.gid(), 60001, "instance dir group must be the inst gid");
        // setgid (0o2000) + rwxrwx--- (0o0770).
        assert_eq!(md.permissions().mode() & 0o7777, 0o2770);
    } else {
        // Fail-closed: chown to the instance gid needs root; if it cannot be
        // performed the reconcile must FAIL rather than leave a world/owner dir.
        assert_eq!(
            v["results"][0]["ok"], false,
            "unprivileged dir-secure failure must fail the reconcile (fail-closed)"
        );
        let err = v["results"][0]["error"].as_str().unwrap_or("");
        assert!(
            err.contains("instance dir") || err.contains("chown"),
            "fail-closed error should reference the dir/chown step, got: {err}"
        );
    }
}
