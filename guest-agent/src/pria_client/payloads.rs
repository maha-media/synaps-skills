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
}
