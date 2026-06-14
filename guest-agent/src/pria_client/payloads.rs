//! Pria callback payload types (spec §7) + the guest-agent audit event builder.

use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};

/// Heartbeat payload (spec §7.1).
#[derive(Debug, Clone, Serialize)]
pub struct HeartbeatPayload {
    pub account_id: String,
    pub vm_id: String,
    pub replica_id: String,
    pub mode: String,
    pub status: String,
    pub guest_agent_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synaps_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fsmon_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_bundle_version: Option<String>,
    pub active_sessions: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_hash: Option<String>,
    pub fsmon_status: String,
    pub timestamp: String,
}

/// Session event payload (spec §7.3) — bridged into Pria's Agent transport.
#[derive(Debug, Clone, Serialize)]
pub struct SessionEventPayload {
    pub account_id: String,
    pub instance_id: String,
    pub user_id: String,
    pub session_id: String,
    pub event_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
    pub timestamp: String,
}

/// Credential request payload (spec §7.4).
#[derive(Debug, Clone, Serialize)]
pub struct CredentialRequestPayload {
    pub account_id: String,
    pub instance_id: String,
    pub user_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub credential_kind: String,
    pub scope: Value,
    pub grant_modes_allowed: Vec<String>,
    pub reason: String,
    pub timestamp: String,
}

/// A single raw-usage event inside a [`UsagePayload`] (spec §6.2 `events[]`).
///
/// RAW USAGE ONLY — there is deliberately no `credits`/`credit_cost` field.
/// Pria's rating engine is the sole authority for credit conversion
/// (spec §5.5). The token counts are forwarded verbatim from the runtime.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UsageEvent {
    pub idempotency_key: String,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub occurred_at: String,
    /// Raw token breakdown (input/output/cache split), forwarded verbatim.
    pub usage: Value,
    pub metadata: Value,
}

/// Usage ingest payload (spec §6.2) — POSTed to `/internal/agentic-vm/usage`.
///
/// This is the no-core-change fallback/cross-check path (spec §0.2, HS-U6): the
/// guest agent meters `RpcEvent::AgentEnd { usage }` at the RPC boundary and
/// tags it with the session identity SynapsCLI core cannot supply. The envelope
/// IS the request body; attribution lives at the top level.
#[derive(Debug, Clone, Serialize)]
pub struct UsagePayload {
    pub account_id: String,
    pub instance_id: String,
    pub user_id: String,
    pub vm_id: String,
    pub replica_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ephemeral_task_id: Option<String>,
    pub source: String,
    pub events: Vec<UsageEvent>,
}

/// Source tag for the RPC-boundary fallback path (spec §6.1 / model `source`).
pub const SOURCE_RPC_AGENT_END: &str = "synaps-rpc-agent-end";

/// Canonical event type for LLM token usage.
pub const EVENT_TYPE_LLM_TOKENS: &str = "llm.tokens";

/// The recognised raw-token fields, in the **sorted** order Python's
/// `json.dumps(..., sort_keys=True)` produces. The idempotency hash is computed
/// over exactly these keys so the fallback and the future `on_usage` plugin
/// path derive convergent `usage_hash` values (spec §6.4; B2 convergence).
const USAGE_TOKEN_FIELDS_SORTED: [&str; 6] = [
    "cache_creation_1h",
    "cache_creation_5m",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "input_tokens",
    "output_tokens",
];

/// Normalise a raw `TurnUsage`-shaped JSON object onto the recognised token
/// fields. The four core counts default to `0`; the 5m/1h cache-TTL split stays
/// `null` when absent (mirrors `TurnUsage`'s `Option<u64>` fields).
pub fn normalise_usage(raw: &Value) -> Value {
    let mut obj = serde_json::Map::new();
    for field in USAGE_TOKEN_FIELDS_SORTED {
        let v = raw.get(field);
        let optional = matches!(field, "cache_creation_1h" | "cache_creation_5m");
        let normalised = match v.and_then(|x| x.as_u64()) {
            Some(n) => json!(n),
            None if optional => Value::Null,
            None => json!(0),
        };
        obj.insert(field.to_string(), normalised);
    }
    Value::Object(obj)
}

/// Stable short hash of the normalised token counts (idempotency input). Mirrors
/// the plugin's `usage_hash` byte-for-byte: canonical JSON of the sorted token
/// fields, SHA-256, first 16 hex chars.
pub fn usage_hash(normalised: &Value) -> String {
    use sha2::{Digest, Sha256};
    // Build the canonical string in sorted-key order with compact separators,
    // matching python `json.dumps(sort_keys=True, separators=(",", ":"))`.
    let mut parts = Vec::with_capacity(USAGE_TOKEN_FIELDS_SORTED.len());
    for field in USAGE_TOKEN_FIELDS_SORTED {
        let val = normalised.get(field).cloned().unwrap_or(Value::Null);
        let rendered = match val {
            Value::Null => "null".to_string(),
            other => other.to_string(),
        };
        parts.push(format!("\"{field}\":{rendered}"));
    }
    let canonical = format!("{{{}}}", parts.join(","));
    let digest = Sha256::digest(canonical.as_bytes());
    hex::encode(digest)[..16].to_string()
}

/// Derive a stable idempotency key (spec §6.4). For the RPC fallback there is no
/// message/turn id, so the correlator segment is `agent_end`. The `source` tag
/// (`synaps-rpc-agent-end`) keeps this cross-check distinct from the `on_usage`
/// plugin path in the ledger (`account + source + idempotency_key`).
pub fn derive_idempotency_key(
    session_id: &str,
    correlator: &str,
    event_type: &str,
    normalised: &Value,
) -> String {
    format!(
        "synaps:{}:{}:{}:{}",
        if session_id.is_empty() { "nosession" } else { session_id },
        correlator,
        event_type,
        usage_hash(normalised),
    )
}

/// The audit event family enum (spec §7.2). String-mapped to keep the wire
/// stable and to let GA-A5 adapt them into Pria's canonical buckets.
pub mod kinds {
    pub const GUEST_AGENT_STARTED: &str = "guest_agent.started";
    pub const GUEST_AGENT_STOPPED: &str = "guest_agent.stopped";
    pub const GUEST_AGENT_HEALTH_CHANGED: &str = "guest_agent.health_changed";
    pub const PRINCIPAL_CREATED: &str = "principal.created";
    pub const PRINCIPAL_UPDATED: &str = "principal.updated";
    pub const PRINCIPAL_DISABLED: &str = "principal.disabled";
    pub const SESSION_STARTED: &str = "session.started";
    pub const SESSION_EXITED: &str = "session.exited";
    pub const SESSION_CANCELLED: &str = "session.cancelled";
    pub const POLICY_APPLIED: &str = "policy.applied";
    pub const POLICY_REJECTED: &str = "policy.rejected";
    pub const FSMON_STARTED: &str = "fsmon.started";
    pub const FSMON_STOPPED: &str = "fsmon.stopped";
    pub const FSMON_WRITE_ALLOWED: &str = "fsmon.write.allowed";
    pub const FSMON_WRITE_DENIED: &str = "fsmon.write.denied";
    pub const FSMON_TAMPER_DETECTED: &str = "fsmon.tamper_detected";
    pub const CREDENTIAL_REQUESTED: &str = "credential.requested";
    pub const CREDENTIAL_APPROVED: &str = "credential.approved";
    pub const CREDENTIAL_DENIED: &str = "credential.denied";
    pub const CREDENTIAL_USED: &str = "credential.used";
    pub const SECURITY_HMAC_REJECTED: &str = "security.hmac_rejected";
    pub const SECURITY_REPLAY_REJECTED: &str = "security.replay_rejected";
    pub const SECURITY_BYPASS_ATTEMPT: &str = "security.bypass_attempt_detected";
}

/// Builder for a guest-agent-emitted audit record (spec §7.2). The record is a
/// flat JSON object so GA-A5 can stamp account/vm/session IDs into metadata.
pub struct AuditEventBuilder {
    obj: serde_json::Map<String, Value>,
}

impl AuditEventBuilder {
    pub fn new(kind: &str) -> Self {
        let mut obj = serde_json::Map::new();
        obj.insert("schema_version".into(), json!(1));
        obj.insert("event_id".into(), json!(uuid::Uuid::new_v4().to_string()));
        obj.insert("kind".into(), json!(kind));
        obj.insert("source".into(), json!("guest-agent"));
        obj.insert("timestamp".into(), json!(Utc::now().to_rfc3339()));
        Self { obj }
    }

    pub fn str_field(mut self, key: &str, value: impl Into<String>) -> Self {
        self.obj.insert(key.into(), json!(value.into()));
        self
    }

    pub fn opt_str(mut self, key: &str, value: Option<impl Into<String>>) -> Self {
        if let Some(v) = value {
            self.obj.insert(key.into(), json!(v.into()));
        }
        self
    }

    pub fn u32_field(mut self, key: &str, value: u32) -> Self {
        self.obj.insert(key.into(), json!(value));
        self
    }

    pub fn json_field(mut self, key: &str, value: Value) -> Self {
        self.obj.insert(key.into(), value);
        self
    }

    pub fn build(self) -> Value {
        Value::Object(self.obj)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_builder_sets_envelope_fields() {
        let ev = AuditEventBuilder::new(kinds::SESSION_STARTED)
            .str_field("account_id", "acct_1")
            .str_field("session_id", "sess_1")
            .u32_field("linux_uid", 12001)
            .build();
        assert_eq!(ev["kind"], "session.started");
        assert_eq!(ev["schema_version"], 1);
        assert_eq!(ev["source"], "guest-agent");
        assert_eq!(ev["account_id"], "acct_1");
        assert_eq!(ev["linux_uid"], 12001);
        assert!(ev["event_id"].is_string());
        assert!(ev["timestamp"].is_string());
    }

    #[test]
    fn opt_str_skips_none() {
        let ev = AuditEventBuilder::new(kinds::POLICY_APPLIED)
            .opt_str("session_id", None::<String>)
            .build();
        assert!(ev.get("session_id").is_none());
    }

    #[test]
    fn normalise_usage_defaults_core_zero_optional_null() {
        let raw = json!({ "input_tokens": 10 });
        let n = normalise_usage(&raw);
        assert_eq!(n["input_tokens"], 10);
        assert_eq!(n["output_tokens"], 0);
        assert_eq!(n["cache_read_input_tokens"], 0);
        assert_eq!(n["cache_creation_input_tokens"], 0);
        assert!(n["cache_creation_5m"].is_null());
        assert!(n["cache_creation_1h"].is_null());
    }

    #[test]
    fn normalise_usage_preserves_all_counts() {
        let raw = json!({
            "input_tokens": 1234, "output_tokens": 567,
            "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 200,
            "cache_creation_5m": 200, "cache_creation_1h": 0
        });
        let n = normalise_usage(&raw);
        assert_eq!(n["cache_read_input_tokens"], 1000);
        assert_eq!(n["cache_creation_5m"], 200);
        assert_eq!(n["cache_creation_1h"], 0);
    }

    #[test]
    fn usage_hash_matches_python_canonicalisation() {
        // Byte-identical with the plugin's usage_hash over the SAMPLE payload:
        // canonical = {"cache_creation_1h":0,"cache_creation_5m":200,
        //   "cache_creation_input_tokens":200,"cache_read_input_tokens":1000,
        //   "input_tokens":1234,"output_tokens":567}
        let n = normalise_usage(&json!({
            "input_tokens": 1234, "output_tokens": 567,
            "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 200,
            "cache_creation_5m": 200, "cache_creation_1h": 0
        }));
        let canonical = "{\"cache_creation_1h\":0,\"cache_creation_5m\":200,\
\"cache_creation_input_tokens\":200,\"cache_read_input_tokens\":1000,\
\"input_tokens\":1234,\"output_tokens\":567}";
        use sha2::{Digest, Sha256};
        let expected = hex::encode(Sha256::digest(canonical.as_bytes()))[..16].to_string();
        assert_eq!(usage_hash(&n), expected);
    }

    #[test]
    fn usage_hash_stable_and_content_sensitive() {
        let a = normalise_usage(&json!({ "input_tokens": 1 }));
        let b = normalise_usage(&json!({ "input_tokens": 2 }));
        assert_eq!(usage_hash(&a), usage_hash(&a));
        assert_ne!(usage_hash(&a), usage_hash(&b));
    }

    #[test]
    fn idempotency_key_structure_and_nosession_fallback() {
        let n = normalise_usage(&json!({ "input_tokens": 1 }));
        let k = derive_idempotency_key("sess_1", "agent_end", EVENT_TYPE_LLM_TOKENS, &n);
        assert!(k.starts_with("synaps:sess_1:agent_end:llm.tokens:"));
        let k0 = derive_idempotency_key("", "agent_end", EVENT_TYPE_LLM_TOKENS, &n);
        assert!(k0.starts_with("synaps:nosession:"));
    }

    #[test]
    fn usage_event_serializes_raw_only() {
        let ev = UsageEvent {
            idempotency_key: "synaps:s:agent_end:llm.tokens:abc".into(),
            event_type: EVENT_TYPE_LLM_TOKENS.into(),
            provider: None,
            model: Some("claude-x".into()),
            occurred_at: "2026-06-14T00:00:00Z".into(),
            usage: json!({ "input_tokens": 1 }),
            metadata: json!({}),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "llm.tokens");
        assert_eq!(v["model"], "claude-x");
        assert!(v.get("provider").is_none(), "None provider must be skipped");
        assert!(v.get("credits").is_none(), "raw-only: no credits field");
    }
}
