//! AC-B1.3 — RPC-boundary usage fallback (HS-U6): meter `RpcEvent::AgentEnd
//! { usage }`, sign + forward to `/internal/agentic-vm/usage`, spool when Pria
//! is unreachable. No SynapsCLI core change is involved — the guest agent tags
//! the untagged RPC event at the boundary.

use std::sync::Arc;

use pria_guest_agent::hmac::HmacVerifier;
use pria_guest_agent::pria_client::fake::FakePriaClient;
use pria_guest_agent::pria_client::{HttpPriaClient, OutboundSigner, PriaCallbackClient};
use pria_guest_agent::config::Config;
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
    assert!(v.to_string().find("credits").is_none(), "raw-only invariant");
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
