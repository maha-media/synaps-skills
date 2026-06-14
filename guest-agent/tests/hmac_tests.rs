//! GA-B2 HMAC tests: the frozen golden vector (shared with GA-A1) plus the
//! spec §13.5 negative matrix exercised through the `SignedJson` extractor.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::post;
use axum::Router;
use http_body_util::BodyExt;
use serde::Deserialize;
use tower::ServiceExt;

use pria_guest_agent::api::AppState;
use pria_guest_agent::config::Config;
use pria_guest_agent::hmac::{
    body_sha256_hex, build_canonical_string, sign, CanonicalParts, HmacVerifier, SignedJson,
};

const SECRET: &[u8] = b"local-dev-generated-secret";

#[test]
fn golden_vector_matches_frozen_signature() {
    // docs/contract.md §1.2 — must stay byte-identical to GA-A1's Node impl.
    let body = br#"{"hello":"world"}"#;
    let body_hash = body_sha256_hex(body);
    assert_eq!(
        body_hash,
        "93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588"
    );
    let canonical = build_canonical_string(&CanonicalParts {
        method: "POST",
        path: "/guest/v1/sessions/start",
        query: "",
        timestamp_ms: "1790000000000",
        nonce: "nonce-abc-123",
        account_id: "acct_local_123",
        vm_id: "vm_local_456",
        session_id: "sess_abc",
        body_sha256_hex: &body_hash,
    });
    let sig = sign(SECRET, &canonical);
    assert_eq!(
        sig,
        "eba9ba5e3577be996992878db905837d3ee8186c11fe801578d87a730a38b61e"
    );
}

// ── extractor harness ───────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct Echo {
    msg: String,
}

async fn echo(SignedJson { value, .. }: SignedJson<Echo>) -> String {
    value.msg
}

fn test_state() -> AppState {
    let cfg = Config::from_yaml(SAMPLE_CONFIG).unwrap();
    let hmac = HmacVerifier::new(SECRET.to_vec(), "acct_123", "vm_456", 300, 300);
    let versions = pria_guest_agent::versions::Versions::detect(&cfg);
    AppState {
        config: Arc::new(cfg),
        hmac: Arc::new(hmac),
        runtime: Arc::new(pria_guest_agent::runtime::RuntimeState::new()),
        versions: Arc::new(versions),
        pria: Arc::new(pria_guest_agent::pria_client::fake::FakePriaClient::default()),
        os: Arc::new(pria_guest_agent::os::FakeUserManager::default()),
    }
}

fn app() -> Router {
    let state = test_state();
    Router::new().route("/t", post(echo)).with_state(state)
}

struct SignedReq {
    ts: String,
    nonce: String,
    account: String,
    vm: String,
    session: Option<String>,
    body: Vec<u8>,
    body_hash: Option<String>,
    sig: Option<String>,
}

impl SignedReq {
    fn valid(body: &[u8]) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        Self {
            ts: now.to_string(),
            nonce: format!("nonce-{}", uuid::Uuid::new_v4()),
            account: "acct_123".into(),
            vm: "vm_456".into(),
            session: None,
            body: body.to_vec(),
            body_hash: None,
            sig: None,
        }
    }

    fn build(self) -> Request<Body> {
        let body_hash = self
            .body_hash
            .clone()
            .unwrap_or_else(|| body_sha256_hex(&self.body));
        let canonical = build_canonical_string(&CanonicalParts {
            method: "POST",
            path: "/t",
            query: "",
            timestamp_ms: &self.ts,
            nonce: &self.nonce,
            account_id: &self.account,
            vm_id: &self.vm,
            session_id: self.session.as_deref().unwrap_or(""),
            body_sha256_hex: &body_hash,
        });
        let sig = self.sig.clone().unwrap_or_else(|| sign(SECRET, &canonical));
        let mut builder = Request::builder()
            .method("POST")
            .uri("/t")
            .header("content-type", "application/json")
            .header("x-pria-account-id", &self.account)
            .header("x-pria-vm-id", &self.vm)
            .header("x-pria-timestamp-ms", &self.ts)
            .header("x-pria-nonce", &self.nonce)
            .header("x-pria-body-sha256", &body_hash)
            .header("x-pria-signature", &sig);
        if let Some(s) = &self.session {
            builder = builder.header("x-pria-session-id", s);
        }
        builder.body(Body::from(self.body)).unwrap()
    }
}

async fn status_of(req: Request<Body>) -> StatusCode {
    app().oneshot(req).await.unwrap().status()
}

#[tokio::test]
async fn valid_request_passes() {
    let req = SignedReq::valid(br#"{"msg":"hi"}"#).build();
    let resp = app().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&body[..], b"hi");
}

#[tokio::test]
async fn missing_hmac_rejected() {
    let req = Request::builder()
        .method("POST")
        .uri("/t")
        .body(Body::from(r#"{"msg":"hi"}"#))
        .unwrap();
    assert_eq!(status_of(req).await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn invalid_body_hash_rejected() {
    let mut r = SignedReq::valid(br#"{"msg":"hi"}"#);
    r.body_hash = Some("00".repeat(32));
    assert_eq!(status_of(r.build()).await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn bad_signature_rejected() {
    let mut r = SignedReq::valid(br#"{"msg":"hi"}"#);
    r.sig = Some("de".repeat(32));
    assert_eq!(status_of(r.build()).await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn stale_timestamp_rejected() {
    let mut r = SignedReq::valid(br#"{"msg":"hi"}"#);
    r.ts = "1000".to_string(); // ~1970
    assert_eq!(status_of(r.build()).await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn replayed_nonce_rejected() {
    let state = test_state();
    let make = |body: &[u8]| {
        let r = SignedReq::valid(body);
        let nonce = r.nonce.clone();
        (r.build(), nonce)
    };
    let (req1, nonce) = make(br#"{"msg":"a"}"#);
    let router = Router::new()
        .route("/t", post(echo))
        .with_state(state.clone());
    assert_eq!(
        router.clone().oneshot(req1).await.unwrap().status(),
        StatusCode::OK
    );
    // Re-send the exact same nonce.
    let mut r2 = SignedReq::valid(br#"{"msg":"a"}"#);
    r2.nonce = nonce;
    assert_eq!(
        router.oneshot(r2.build()).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn wrong_account_binding_rejected() {
    let mut r = SignedReq::valid(br#"{"msg":"hi"}"#);
    r.account = "acct_OTHER".to_string();
    // signature is computed over the wrong account, binding check returns 403.
    assert_eq!(status_of(r.build()).await, StatusCode::FORBIDDEN);
}

const SAMPLE_CONFIG: &str = r#"
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
