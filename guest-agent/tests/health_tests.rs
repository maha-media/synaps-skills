//! GA-B3 health endpoint contract test (spec §6.1). Health is unauthenticated.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use pria_guest_agent::api::{build_router, AppState};
use pria_guest_agent::config::Config;
use pria_guest_agent::hmac::HmacVerifier;
use pria_guest_agent::runtime::{FsmonStatus, PolicyState, RuntimeState};
use pria_guest_agent::versions::Versions;

const CONFIG: &str = r#"
mode: local-virsh
account_id: acct_123
vm_id: vm_456
replica_id: replica_0
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

#[tokio::test]
async fn health_returns_section_6_1_payload() {
    let cfg = Config::from_yaml(CONFIG).unwrap();
    let versions = Versions::detect(&cfg);
    let runtime = RuntimeState::new();
    runtime.incr_sessions();
    runtime.incr_sessions();
    runtime.set_fsmon_status(FsmonStatus::Healthy);
    runtime.set_policy(PolicyState {
        policy_profile_id: Some("policy_default".into()),
        policy_version: Some(17),
        policy_hash: Some("sha256:abc".into()),
    });
    let state = AppState {
        config: Arc::new(cfg),
        hmac: Arc::new(HmacVerifier::new(
            b"x".to_vec(),
            "acct_123",
            "vm_456",
            300,
            300,
        )),
        runtime: Arc::new(runtime),
        versions: Arc::new(versions),
    };

    let resp = build_router(state)
        .oneshot(
            Request::builder()
                .uri("/guest/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["status"], "healthy");
    assert_eq!(v["account_id"], "acct_123");
    assert_eq!(v["vm_id"], "vm_456");
    assert_eq!(v["mode"], "local-virsh");
    assert_eq!(v["active_sessions"], 2);
    assert_eq!(v["policy_version"], 17);
    assert_eq!(v["policy_hash"], "sha256:abc");
    assert_eq!(v["fsmon_status"], "healthy");
    assert!(v["guest_agent_version"].is_string());
    assert!(v["uptime_seconds"].is_number());
}
