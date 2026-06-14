//! GA-B10 E2E harness.
//!
//! Two layers:
//!  * `e2e_signed_loop` (runs by default) — boots the REAL guest-agent axum
//!    server with HMAC **enabled** plus a fake Pria callback receiver that
//!    verifies inbound signatures, then drives the §9.7 in-VM steps that do not
//!    need libvirt (5 principal, 6 session, 8 policy, 9 fsmon, 11 close) over a
//!    fully signed round-trip in both directions.
//!  * `e2e_virsh_full` (`#[ignore]`) — the full 12-step §9.7 path; requires
//!    libvirt + the Track A GA-A12 driver (`npm run test:agentic-vm:virsh:e2e`)
//!    and is skipped in default CI (spec §13.3/§13.4).

use std::sync::Arc;
use std::sync::Mutex;

use axum::body::Bytes;
use axum::extract::State as AxState;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::Router;

use pria_guest_agent::api::{build_router, AppState};
use pria_guest_agent::config::Config;
use pria_guest_agent::fsmon::client::FakeFsmonControl;
use pria_guest_agent::hmac::HmacVerifier;
use pria_guest_agent::os::{FakeUserManager, UserRecord};
use pria_guest_agent::pria_client::{HttpPriaClient, OutboundSigner};
use pria_guest_agent::runtime::RuntimeState;
use pria_guest_agent::sessions::SessionStore;
use pria_guest_agent::synaps::launcher::FakeLauncher;
use pria_guest_agent::versions::Versions;

const SECRET: &[u8] = b"e2e-shared-secret";
const ACCOUNT: &str = "acct_e2e";
const VM: &str = "vm_e2e";

// ── fake Pria callback receiver ──────────────────────────────────────────────

#[derive(Clone)]
struct FakePria {
    verifier: Arc<HmacVerifier>,
    received: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
}

async fn fake_callback(
    AxState(state): AxState<FakePria>,
    headers: HeaderMap,
    uri: axum::http::Uri,
    body: Bytes,
) -> StatusCode {
    let path = uri.path().to_string();
    let query = uri.query().unwrap_or("");
    match state.verifier.verify("POST", &path, query, &headers, &body) {
        Ok(_) => {
            let v: serde_json::Value =
                serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
            state.received.lock().unwrap().push((path, v));
            StatusCode::OK
        }
        Err(_) => StatusCode::UNAUTHORIZED,
    }
}

async fn spawn_fake_pria() -> (String, Arc<Mutex<Vec<(String, serde_json::Value)>>>) {
    let received = Arc::new(Mutex::new(Vec::new()));
    let state = FakePria {
        verifier: Arc::new(HmacVerifier::new(SECRET.to_vec(), ACCOUNT, VM, 300, 300)),
        received: received.clone(),
    };
    let app = Router::new()
        .route("/internal/agentic-vm/heartbeat", post(fake_callback))
        .route("/internal/agentic-vm/audit", post(fake_callback))
        .route("/internal/agentic-vm/session-event", post(fake_callback))
        .route(
            "/internal/agentic-vm/credential-request",
            post(fake_callback),
        )
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), received)
}

// ── guest-agent server under test ────────────────────────────────────────────

async fn spawn_guest_agent(pria_base: &str) -> (String, std::path::PathBuf) {
    let base = std::env::temp_dir().join(format!("ga-e2e-{}", uuid::Uuid::new_v4()));
    let efs = base.join("efs");
    let run = base.join("run");
    std::fs::create_dir_all(&efs).unwrap();
    std::fs::create_dir_all(&run).unwrap();

    let yaml = format!(
        r#"
mode: local-virsh
account_id: {ACCOUNT}
vm_id: {VM}
replica_id: replica_0
pria:
  base_url: {pria_base}
  hmac_key_id: key_e2e
  hmac_secret_file: /tmp/unused
paths:
  efs_root: {efs}
  run_root: {run}
  policy_dir: {efs}/policy
  audit_spool_dir: {efs}/spool
synaps:
  binary: /bin/true
fsmon:
  socket: /run/pria/fsmon.sock
"#,
        efs = efs.display(),
        run = run.display(),
    );
    let config = Config::from_yaml(&yaml).unwrap();

    let os = Arc::new(FakeUserManager::default().with_user(UserRecord {
        username: "pria_u_55001".into(),
        uid: 55001,
        gid: 55001,
        active: true,
    }));
    let runtime = Arc::new(RuntimeState::new());
    let sessions = Arc::new(SessionStore::new(runtime.clone()));
    let versions = Arc::new(Versions::detect(&config));
    let pria = Arc::new(HttpPriaClient::new(&config, SECRET.to_vec()));

    let state = AppState {
        config: Arc::new(config),
        hmac: Arc::new(HmacVerifier::new(SECRET.to_vec(), ACCOUNT, VM, 300, 300)),
        runtime,
        versions,
        pria,
        os,
        synaps: Arc::new(FakeLauncher::default()),
        sessions,
        fsmon: Arc::new(FakeFsmonControl::healthy()),
    };

    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), efs)
}

// ── signed client helpers ────────────────────────────────────────────────────

async fn signed_post(
    client: &reqwest::Client,
    signer: &OutboundSigner,
    base: &str,
    path: &str,
    body: serde_json::Value,
    session_id: Option<&str>,
) -> (StatusCode, serde_json::Value) {
    let raw = serde_json::to_vec(&body).unwrap();
    let signed = signer.sign_post(path, &raw, session_id);
    let mut req = client
        .post(format!("{base}{path}"))
        .header("content-type", "application/json")
        .body(raw);
    for (k, v) in &signed.headers {
        req = req.header(*k, v);
    }
    let resp = req.send().await.unwrap();
    let status = resp.status();
    let json = resp
        .json::<serde_json::Value>()
        .await
        .unwrap_or(serde_json::Value::Null);
    (StatusCode::from_u16(status.as_u16()).unwrap(), json)
}

#[tokio::test]
async fn e2e_signed_loop() {
    let (pria_base, received) = spawn_fake_pria().await;
    let (ga_base, efs) = spawn_guest_agent(&pria_base).await;
    let client = reqwest::Client::new();
    let signer = OutboundSigner::new(SECRET.to_vec(), "key_e2e", ACCOUNT, VM);

    // §9.7 step (3/4) — guest agent up: health (unauthenticated).
    let health = client
        .get(format!("{ga_base}/guest/v1/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), reqwest::StatusCode::OK);
    let hv: serde_json::Value = health.json().await.unwrap();
    assert_eq!(hv["account_id"], ACCOUNT);

    // §9.7 step 5 — reconcile a principal (signed).
    let (st, v) = signed_post(
        &client,
        &signer,
        &ga_base,
        "/guest/v1/principals/reconcile",
        serde_json::json!({
            "account_id": ACCOUNT,
            "desired": [{
                "user_id": "user_e2e", "linux_username": "pria_u_55001",
                "uid": 55001, "gid": 55001, "state": "active"
            }]
        }),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "reconcile failed: {v}");
    assert_eq!(v["results"][0]["ok"], true);

    // §9.7 step 8 — apply policy (signed).
    let (st, v) = signed_post(
        &client,
        &signer,
        &ga_base,
        "/guest/v1/policy/apply",
        serde_json::json!({
            "account_id": ACCOUNT,
            "policy_profile_id": "policy_default",
            "policy_version": 3,
            "policy_hash": "sha256:e2e",
            "mode": "block",
            "rules": {"filesystem": {"default": "allow", "deny": ["/etc/**"], "observe": []}}
        }),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "policy apply failed: {v}");
    assert_eq!(v["fsmon_applied"], true);

    // §9.7 step 6 — start a session (signed).
    let ws = format!("{}/instances/inst_e2e/workspace", efs.display());
    let sd = format!("{}/sessions/sess_e2e", efs.display());
    let (st, v) = signed_post(
        &client,
        &signer,
        &ga_base,
        "/guest/v1/sessions/start",
        serde_json::json!({
            "account_id": ACCOUNT, "instance_id": "inst_e2e", "user_id": "user_e2e",
            "session_id": "sess_e2e", "vm_id": VM, "linux_username": "pria_u_55001",
            "uid": 55001, "gid": 55001, "policy_hash": "sha256:e2e",
            "workspace_dir": ws, "session_dir": sd, "roles": ["agent_operator"]
        }),
        Some("sess_e2e"),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "session start failed: {v}");
    assert_eq!(v["status"], "starting");
    assert!(v["pid"].as_u64().unwrap() > 0);

    // §9.7 step 9 — fsmon status healthy (unauthenticated read).
    let fs = client
        .get(format!("{ga_base}/guest/v1/fsmon/status"))
        .send()
        .await
        .unwrap();
    let fsv: serde_json::Value = fs.json().await.unwrap();
    assert_eq!(fsv["status"], "healthy");

    // §9.7 step 11 — close the session (signed).
    let (st, _v) = signed_post(
        &client,
        &signer,
        &ga_base,
        "/guest/v1/sessions/sess_e2e/close",
        serde_json::json!({"reason": "user_closed", "grace_period_ms": 100}),
        Some("sess_e2e"),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    // The signed Pria-callback loop fired: principal/policy/session audits all
    // arrived at the fake Pria with valid HMAC signatures.
    // Give async audit posts a moment to land.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let got = received.lock().unwrap();
    let audit_count = got
        .iter()
        .filter(|(p, _)| p == "/internal/agentic-vm/audit")
        .count();
    assert!(
        audit_count >= 3,
        "expected >=3 signed audit callbacks, got {audit_count}"
    );
}

/// Full virsh path — requires libvirt + the Track A GA-A12 driver. Opt-in.
#[tokio::test]
#[ignore = "requires libvirt + Track A GA-A12 driver (npm run test:agentic-vm:virsh:e2e)"]
async fn e2e_virsh_full() {
    // Driven externally by `scripts/agentic-vm-virsh.js` (Track A). This stub
    // exists so `cargo test -- --ignored` documents the entrypoint; the real
    // 12-step §9.7 assertions live in the Node E2E that provisions a disposable
    // local Account VM and boots this guest agent inside it.
    eprintln!("e2e_virsh_full is driven by the Track A virsh harness; see docs/integration.md");
}
