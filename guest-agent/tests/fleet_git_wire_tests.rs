//! F7-W — the guest's git wire verbs against a fake Pria over REAL HTTP with
//! REAL HMAC verification (charter /tmp/synaps-skills-f7-charter.md; the
//! W3.10.1/W4.1 lesson: never a mocked signer — drive the live call shape).
//!
//! `PriaCallbackClient` gains:
//!   fleet_git_fetch(handle_id, generation, session_id)
//!       → GET /internal/agentic-vm/fleet-git-fetch?handle_id&generation
//!         (signed query, EMPTY body, x-pria-session-id header) →
//!         Ok(GitFetch::Bundle(bytes)) on 200 octet-stream,
//!         Ok(GitFetch::Refused(reason)) on 200 JSON {ok:false,reason}.
//!   fleet_git_push(handle_id, generation, ref, session_id, bytes)
//!       → POST /internal/agentic-vm/fleet-git-push?handle_id&generation&ref
//!         (RAW bundle body, HMAC over the raw bytes, x-pria-session-id header)
//!         → Ok(GitPush::Accepted) on {accepted:true},
//!         Ok(GitPush::Refused(reason)) on {accepted:false,reason}.
//!
//! Born-RED: the verbs do not exist at birth.
//!
//! Run: cargo test --features test-fakes --test fleet_git_wire_tests

use std::sync::Arc;
use std::sync::Mutex;

use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;

use pria_guest_agent::config::Config;
use pria_guest_agent::hmac::HmacVerifier;
use pria_guest_agent::pria_client::{GitFetch, GitPush, HttpPriaClient, PriaCallbackClient};

const SECRET: &[u8] = b"f7-wire-secret";
const ACCOUNT: &str = "acct_f7";
const VM: &str = "vm_f7";
const SESSION: &str = "sess_f7";
const HANDLE: &str = "fj-w5-test";
const GEN: u64 = 1;

fn cfg(base_url: &str) -> Config {
    let yaml = format!(
        r#"
mode: local-virsh
account_id: {ACCOUNT}
vm_id: {VM}
replica_id: r0
pria:
  base_url: {base_url}
  hmac_key_id: k1
  hmac_secret_file: /tmp/f7-secret
paths:
  efs_root: /efs
  run_root: /run/pria
  policy_dir: /efs/policy
  audit_spool_dir: /tmp/f7-spool
synaps:
  binary: /bin/true
fsmon:
  socket: /run/fsmon.sock
"#
    );
    Config::from_yaml(&yaml).unwrap()
}

/// A fake Pria that records the fleet-git requests and answers with
/// programmable shapes. Verifies the HMAC on every request (the live-shape
/// law) before answering.
#[derive(Clone, Default)]
struct FakePria {
    fetch_queries: Arc<Mutex<Vec<String>>>,
    push_queries: Arc<Mutex<Vec<String>>>,
    push_bodies: Arc<Mutex<Vec<Vec<u8>>>>,
    push_session_headers: Arc<Mutex<Vec<String>>>,
    fetch_session_headers: Arc<Mutex<Vec<String>>>,
    // Programmable answers.
    fetch_answer: Arc<Mutex<FetchAnswer>>,
    push_answer: Arc<Mutex<PushAnswer>>,
}

#[derive(Clone)]
enum FetchAnswer {
    Bundle(Vec<u8>),
    RefusedJson(String),
}
impl Default for FetchAnswer {
    fn default() -> Self {
        FetchAnswer::Bundle(b"BUNDLE".to_vec())
    }
}

#[derive(Clone)]
enum PushAnswer {
    Accepted,
    RefusedJson(String),
}
impl Default for PushAnswer {
    fn default() -> Self {
        PushAnswer::Accepted
    }
}

fn verify_or_401(method: &str, path: &str, query: &str, headers: &HeaderMap, body: &[u8]) -> Result<(), StatusCode> {
    let verifier = HmacVerifier::new(SECRET.to_vec(), ACCOUNT, VM, 300, 300);
    verifier
        .verify(method, path, query, headers, body)
        .map(|_| ())
        .map_err(|_| StatusCode::UNAUTHORIZED)
}

async fn fetch_handler(
    State(st): State<FakePria>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    // Verify against the RAW query (never the decoded+rebuilt form — the real
    // Pria verifies originalUrl; the HMAC covers the exact bytes on the wire).
    let query = raw.unwrap_or_default();
    verify_or_401("GET", "/internal/agentic-vm/fleet-git-fetch", &query, &headers, b"")?;
    st.fetch_queries.lock().unwrap().push(query);
    st.fetch_session_headers.lock().unwrap().push(
        headers
            .get("x-pria-session-id")
            .map(|v| v.to_str().unwrap_or("").to_string())
            .unwrap_or_default(),
    );
    let answer = st.fetch_answer.lock().unwrap().clone();
    match answer {
        FetchAnswer::Bundle(bytes) => Ok(Response::builder()
            .status(200)
            .header("content-type", "application/octet-stream")
            .body(Body::from(bytes))
            .unwrap()),
        FetchAnswer::RefusedJson(reason) => Ok(Response::builder()
            .status(200)
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"ok":false,"reason":"{reason}"}}"#)))
            .unwrap()),
    }
}

async fn push_handler(
    State(st): State<FakePria>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Response, StatusCode> {
    let query = raw.unwrap_or_default();
    verify_or_401("POST", "/internal/agentic-vm/fleet-git-push", &query, &headers, &body)?;
    st.push_queries.lock().unwrap().push(query);
    st.push_bodies.lock().unwrap().push(body.to_vec());
    st.push_session_headers.lock().unwrap().push(
        headers
            .get("x-pria-session-id")
            .map(|v| v.to_str().unwrap_or("").to_string())
            .unwrap_or_default(),
    );
    let answer = st.push_answer.lock().unwrap().clone();
    let json = match answer {
        PushAnswer::Accepted => r#"{"accepted":true,"resultOid":"abc"}"#.to_string(),
        PushAnswer::RefusedJson(reason) => format!(r#"{{"accepted":false,"reason":"{reason}"}}"#),
    };
    Ok(Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(Body::from(json))
        .unwrap())
}

async fn serve(st: FakePria) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route("/internal/agentic-vm/fleet-git-fetch", get(fetch_handler))
        .route("/internal/agentic-vm/fleet-git-push", post(push_handler))
        .with_state(st);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}/"), handle)
}

// ── fetch ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn f7w_fetch_sends_signed_get_with_empty_body_and_session_header() {
    let st = FakePria::default();
    *st.fetch_answer.lock().unwrap() = FetchAnswer::Bundle(b"REAL-BUNDLE-BYTES".to_vec());
    let (base, _h) = serve(st.clone()).await;
    let client = HttpPriaClient::new(&cfg(&base), SECRET.to_vec());
    let out = client
        .fleet_git_fetch(HANDLE, GEN, SESSION)
        .await
        .expect("fetch ok");
    match out {
        GitFetch::Bundle(bytes) => assert_eq!(bytes, b"REAL-BUNDLE-BYTES"),
        other => panic!("expected Bundle, got {other:?}"),
    }
    // The exact signed query + the header session id (W3.10.1 law).
    let q = st.fetch_queries.lock().unwrap();
    assert_eq!(q.len(), 1);
    assert!(q[0].contains(&format!("handle_id={HANDLE}")), "query: {}", q[0]);
    assert!(q[0].contains(&format!("generation={GEN}")), "query: {}", q[0]);
    let sh = st.fetch_session_headers.lock().unwrap();
    assert_eq!(sh[0], SESSION, "x-pria-session-id header");
}

#[tokio::test]
async fn f7w_fetch_refusal_json_maps_to_typed_refused() {
    let st = FakePria::default();
    *st.fetch_answer.lock().unwrap() = FetchAnswer::RefusedJson("workspace_refused".into());
    let (base, _h) = serve(st.clone()).await;
    let client = HttpPriaClient::new(&cfg(&base), SECRET.to_vec());
    let out = client.fleet_git_fetch(HANDLE, GEN, SESSION).await.expect("fetch ok");
    match out {
        GitFetch::Refused(reason) => assert_eq!(reason, "workspace_refused"),
        other => panic!("expected Refused, got {other:?}"),
    }
}

// ── push ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn f7w_push_sends_signed_raw_body_with_ref_query_and_session_header() {
    let st = FakePria::default();
    let (base, _h) = serve(st.clone()).await;
    let client = HttpPriaClient::new(&cfg(&base), SECRET.to_vec());
    let bundle = b"PUSH-BUNDLE-\x00\x01\x02-raw".to_vec();
    let out = client
        .fleet_git_push(HANDLE, GEN, &format!("refs/vm/{HANDLE}/result"), SESSION, &bundle)
        .await
        .expect("push ok");
    match out {
        GitPush::Accepted => {}
        other => panic!("expected Accepted, got {other:?}"),
    }
    // The exact signed query (handle_id + generation + ref) …
    let q = st.push_queries.lock().unwrap();
    assert_eq!(q.len(), 1);
    assert!(q[0].contains(&format!("handle_id={HANDLE}")), "query: {}", q[0]);
    assert!(q[0].contains(&format!("generation={GEN}")), "query: {}", q[0]);
    // The ref rides the query, percent-encoded (`/` → %2F) so the HMAC
    // canonical query matches the verify side byte-for-byte.
    assert!(
        q[0].contains("ref=refs%2Fvm%2F") && q[0].contains("%2Fresult"),
        "ref percent-encoded in query: {}", q[0]
    );
    // … the RAW body byte-identical (HMAC over raw bytes) …
    let bodies = st.push_bodies.lock().unwrap();
    assert_eq!(bodies[0], bundle, "raw body byte-identical");
    // … and the header session id.
    let sh = st.push_session_headers.lock().unwrap();
    assert_eq!(sh[0], SESSION);
}

#[tokio::test]
async fn f7w_push_refusal_maps_to_typed_refused() {
    let st = FakePria::default();
    *st.push_answer.lock().unwrap() = PushAnswer::RefusedJson("secret_path".into());
    let (base, _h) = serve(st.clone()).await;
    let client = HttpPriaClient::new(&cfg(&base), SECRET.to_vec());
    let out = client
        .fleet_git_push(HANDLE, GEN, &format!("refs/vm/{HANDLE}/result"), SESSION, b"x")
        .await
        .expect("push ok");
    match out {
        GitPush::Refused(reason) => assert_eq!(reason, "secret_path"),
        other => panic!("expected Refused, got {other:?}"),
    }
}
