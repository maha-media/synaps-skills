//! AC-B1.3 — RPC-boundary usage fallback (HS-U6): meter `RpcEvent::AgentEnd
//! { usage }`, sign + forward to `/internal/agentic-vm/usage`, spool when Pria
//! is unreachable. No SynapsCLI core change is involved — the guest agent tags
//! the untagged RPC event at the boundary.

use std::sync::Arc;

use pria_guest_agent::config::Config;
use pria_guest_agent::hmac::HmacVerifier;
use pria_guest_agent::pria_client::fake::FakePriaClient;
use pria_guest_agent::pria_client::{HttpPriaClient, OutboundSigner, PriaCallbackClient};
use pria_guest_agent::synaps::launcher::{tag_agent_end_usage, UsageIdentity};
use serde_json::json;

fn identity() -> UsageIdentity {
    UsageIdentity {
        account_id: "acct_1".into(),
        instance_id: "inst_2".into(),
        user_id: "user_3".into(),
        vm_id: "vm_4".into(),
        replica_id: "r0".into(),
        session_id: "sess_5".into(),
        ephemeral_task_id: None,
    }
}

fn agent_end_event() -> serde_json::Value {
    json!({
        "type": "agent_end",
        "usage": {
            "input_tokens": 1234, "output_tokens": 567,
            "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 200,
            "cache_creation_5m": 200, "cache_creation_1h": 0,
            "model": "claude-sonnet-4-test"
        }
    })
}

const SIGN_CONFIG: &str = r#"
mode: local-virsh
account_id: acct_1
vm_id: vm_4
replica_id: r0
pria:
  base_url: http://127.0.0.1:1/
  hmac_key_id: key_1
  hmac_secret_file: /tmp/does-not-exist
paths:
  efs_root: /efs
  run_root: /run/pria
  policy_dir: /efs/policy
  audit_spool_dir: /tmp/ga-usage-spool-test
synaps:
  binary: /bin/true
fsmon:
  socket: /run/fsmon.sock
"#;

/// The signed usage POST verifies on the receive side (GA-A3 middleware shape).
#[test]
fn usage_payload_signs() {
    let payload = tag_agent_end_usage(&agent_end_event(), &identity()).unwrap();
    let body = serde_json::to_vec(&payload).unwrap();

    let signer = OutboundSigner::new(b"sekret".to_vec(), "key_1", "acct_1", "vm_4");
    let signed = signer.sign_post("/internal/agentic-vm/usage", &body, Some("sess_5"));

    let mut hm = axum::http::HeaderMap::new();
    for (k, v) in &signed.headers {
        let val: axum::http::HeaderValue = v.parse().unwrap();
        hm.insert(*k, val);
    }
    let verifier = HmacVerifier::new(b"sekret".to_vec(), "acct_1", "vm_4", 300, 300);
    let principal = verifier
        .verify("POST", "/internal/agentic-vm/usage", "", &hm, &body)
        .expect("usage POST must verify");
    assert_eq!(principal.account_id, "acct_1");
    assert_eq!(principal.session_id.as_deref(), Some("sess_5"));
}

/// A tagged `agent_end` reaches the Pria client as a raw-only usage payload.
#[tokio::test]
async fn agent_end_tagged_forwarded() {
    let fake = Arc::new(FakePriaClient::default());
    let payload = tag_agent_end_usage(&agent_end_event(), &identity()).expect("must tag");
    fake.usage(&payload).await.unwrap();

    let usages = fake.usages.lock().unwrap();
    assert_eq!(usages.len(), 1);
    let p = &usages[0];
    assert_eq!(p.source, "synaps-rpc-agent-end");
    assert_eq!(p.account_id, "acct_1");
    assert_eq!(p.session_id, "sess_5");
    assert_eq!(p.events.len(), 1);
    assert_eq!(p.events[0].event_type, "llm.tokens");
    assert_eq!(p.events[0].model.as_deref(), Some("claude-sonnet-4-test"));
    // Raw-only: serialised payload carries no credits anywhere.
    let v = serde_json::to_value(p).unwrap();
    assert!(
        v.to_string().find("credits").is_none(),
        "raw-only invariant"
    );
}

/// Non-`agent_end` RPC events are ignored by the meter (relay should skip).
#[test]
fn non_agent_end_is_not_metered() {
    let raw = json!({"type": "synaps.output.delta", "payload": {"text": "x"}});
    assert!(tag_agent_end_usage(&raw, &identity()).is_none());
}

/// When Pria is unreachable, the HTTP client spools the usage envelope to a
/// dedicated file and never errors out of the hot path.
#[tokio::test]
async fn spools_when_unreachable() {
    let spool = std::env::temp_dir().join(format!("ga-usage-spool-{}", uuid::Uuid::new_v4()));
    let mut config = Config::from_yaml(SIGN_CONFIG).unwrap();
    config.paths.audit_spool_dir = spool.clone();
    let client = HttpPriaClient::new(&config, b"secret".to_vec());

    let payload = tag_agent_end_usage(&agent_end_event(), &identity()).unwrap();
    // base_url points at a closed port -> network error -> spool, no panic/err.
    client.usage(&payload).await.unwrap();

    let spooled = std::fs::read_to_string(spool.join("guest-agent-usage.jsonl")).unwrap();
    assert!(spooled.contains("synaps-rpc-agent-end"));
    assert!(spooled.contains("\"type\":\"llm.tokens\""));
    assert!(!spooled.contains("credits"));
    std::fs::remove_dir_all(&spool).ok();
}

// ── AC-B2.2 in-VM `on_usage` plugin signing proxy (primary path) ─────────────

use pria_guest_agent::api::build_router;
use pria_guest_agent::os::{FakeUserManager, UserRecord};
use pria_guest_agent::synaps::launcher::{tag_plugin_usage, FakeLauncher};
use pria_guest_agent::test_support::{test_env, TestEnv};

fn post(uri: &str, body: serde_json::Value) -> axum::http::Request<axum::body::Body> {
    axum::http::Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap()
}

fn started_env(pria: Arc<FakePriaClient>) -> TestEnv {
    let os = Arc::new(FakeUserManager::default().with_user(UserRecord {
        username: "pria_u_104251".into(),
        uid: 104251,
        gid: 104251,
        active: true,
    }));
    test_env(pria, os, Arc::new(FakeLauncher::default()))
}

fn start_body(env: &TestEnv) -> serde_json::Value {
    let ws = env.efs_root.join("instances/inst_456/workspace");
    let sd = env.efs_root.join("sessions/sess_abc");
    json!({
        "account_id": "acct_123", "instance_id": "inst_456", "user_id": "user_789",
        "session_id": "sess_abc", "vm_id": "vm_456",
        "linux_username": "pria_u_104251", "uid": 104251, "gid": 104251,
        "workspace_dir": ws.to_string_lossy(), "session_dir": sd.to_string_lossy(),
        "roles": ["agent_operator"], "transport": {"kind": "pria-agent-websocket"},
        "request_id": "req_1"
    })
}

/// The plugin's §6.2 envelope (note: claims a spoofed account the proxy ignores).
fn plugin_envelope() -> serde_json::Value {
    json!({
        "account_id": "acct_SPOOFED",
        "instance_id": "inst_SPOOFED",
        "user_id": "user_SPOOFED",
        "session_id": "sess_abc",
        "source": "synaps-hook-on-usage",
        "events": [{
            "idempotency_key": "synaps:sess_abc:msg_123:llm.tokens:deadbeefdeadbeef",
            "type": "llm.tokens",
            "provider": "anthropic",
            "model": "claude-sonnet-4-test",
            "occurred_at": "2026-06-14T00:00:00Z",
            "usage": {
                "input_tokens": 1234, "output_tokens": 567,
                "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 200,
                "cache_creation_5m": 200, "cache_creation_1h": 0
            },
            "metadata": { "message_id": "msg_123", "turn_id": "turn_abc" }
        }]
    })
}

/// End-to-end: start a session, then POST a plugin usage envelope to the local
/// proxy. The guest agent re-stamps trusted identity and forwards via the (fake)
/// signed Pria client.
#[tokio::test]
async fn plugin_usage_proxy_restamps_and_forwards() {
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    let pria = Arc::new(FakePriaClient::default());
    let env = started_env(pria.clone());
    let state = env.state.clone();

    // 1. Start the session so the proxy can resolve its trusted identity.
    let start = build_router(state.clone())
        .oneshot(post("/guest/v1/sessions/start", start_body(&env)))
        .await
        .unwrap();
    assert_eq!(start.status(), axum::http::StatusCode::OK);

    // 2. POST the plugin usage envelope to the local proxy.
    let resp = build_router(state.clone())
        .oneshot(post("/guest/v1/usage", plugin_envelope()))
        .await
        .unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["accepted"], 1);
    assert_eq!(v["source"], "synaps-hook-on-usage");

    // 3. The fake Pria client received a signed-forward usage payload with
    //    TRUSTED identity (not the spoofed values) and the plugin idempotency key.
    let usages = pria.usages.lock().unwrap();
    assert_eq!(usages.len(), 1);
    let p = &usages[0];
    assert_eq!(p.account_id, "acct_123"); // from session table, NOT acct_SPOOFED
    assert_eq!(p.instance_id, "inst_456");
    assert_eq!(p.user_id, "user_789");
    assert_eq!(p.vm_id, "vm_456");
    assert_eq!(p.replica_id, "replica_0");
    assert_eq!(p.source, "synaps-hook-on-usage");
    assert_eq!(
        p.events[0].idempotency_key,
        "synaps:sess_abc:msg_123:llm.tokens:deadbeefdeadbeef"
    );
    assert!(!serde_json::to_string(&*p).unwrap().contains("credits"));
}

/// An unknown session_id is rejected (anti-spoof: identity must be resolvable).
#[tokio::test]
async fn plugin_usage_proxy_rejects_unknown_session() {
    use tower::ServiceExt;
    let pria = Arc::new(FakePriaClient::default());
    let env = started_env(pria.clone());
    let resp = build_router(env.state.clone())
        .oneshot(post(
            "/guest/v1/usage",
            json!({
                "session_id": "sess_NOT_STARTED",
                "events": [{ "idempotency_key": "k", "type": "llm.tokens",
                             "occurred_at": "t", "usage": {"input_tokens": 1}, "metadata": {} }]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), axum::http::StatusCode::NOT_FOUND);
    assert_eq!(pria.usages.lock().unwrap().len(), 0);
}

/// Convergence (spec §6.4): the plugin path (`tag_plugin_usage`) and the RPC
/// fallback (`tag_agent_end_usage`) derive a **byte-identical `usage_hash`** for
/// the same token counts, but keep **distinct `source` tags** — so Pria's ledger
/// dedupe can cross-check/collapse without double-charging.
#[test]
fn paths_converge_on_usage_hash_with_distinct_sources() {
    use pria_guest_agent::pria_client::payloads::{
        derive_idempotency_key, normalise_usage, usage_hash, EVENT_TYPE_LLM_TOKENS,
    };

    let tokens = json!({
        "input_tokens": 1234, "output_tokens": 567,
        "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 200,
        "cache_creation_5m": 200, "cache_creation_1h": 0
    });
    let normalised = normalise_usage(&tokens);
    let expected_hash = usage_hash(&normalised);

    // The in-VM plugin derives its key over the SAME canonicalisation (asserted
    // byte-for-byte against Python in payloads.rs::usage_hash_matches_python_*).
    let plugin_key =
        derive_idempotency_key("sess_5", "msg_123", EVENT_TYPE_LLM_TOKENS, &normalised);
    let env = json!({
        "session_id": "sess_5", "source": "synaps-hook-on-usage",
        "events": [{
            "idempotency_key": plugin_key, "type": "llm.tokens",
            "provider": "anthropic", "model": "claude-sonnet-4-test",
            "occurred_at": "2026-06-14T00:00:00Z", "usage": tokens.clone(), "metadata": {}
        }]
    });

    let rpc =
        tag_agent_end_usage(&json!({"type": "agent_end", "usage": tokens}), &identity()).unwrap();
    let plugin = tag_plugin_usage(&env, &identity()).unwrap();

    // Distinct, auditable sources keep the two paths separate in the ledger.
    assert_eq!(rpc.source, "synaps-rpc-agent-end");
    assert_eq!(plugin.source, "synaps-hook-on-usage");
    // Both idempotency keys are built over the SAME convergent usage_hash, so
    // Pria can cross-check/collapse the overlap without double-charging.
    assert!(rpc.events[0].idempotency_key.ends_with(&expected_hash));
    assert!(plugin.events[0].idempotency_key.ends_with(&expected_hash));
}
