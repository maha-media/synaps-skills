//! Control-socket protocol (B8): guest-agent → fsmon policy push, and the
//! fsmon → ingest audit-forward contract.
//!
//! Transport is a local Unix domain socket (newline-delimited JSON). The guest
//! agent's `POST /guest/v1/policy/apply` (A11) terminates at this socket; the
//! request carries the centrally-authored policy + the uid→principal table.
//! Applying it refreshes the L1 cache WITHOUT restarting the daemon and without
//! any synchronous network call on the write hot path (spec §4.7).
//!
//! Audit forwarding: fsmon does not embed a TLS HTTP client (it stays
//! dependency-light and CAP-scoped). It writes every decision to the durable
//! JSONL spool AND streams it as NDJSON to the guest agent's audit socket; the
//! guest agent (which already holds the ingest bearer token and the uid→session
//! map, A11/A15) performs the authenticated `POST /agents/ingest/events`. See
//! [`AuditForwardEnvelope`].

use serde::{Deserialize, Serialize};

use crate::policy::PolicyDoc;

/// A request received on the control socket.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlRequest {
    /// Hot policy push (A11 → fsmon). Replaces policy + clears the L1 cache.
    PolicyApply { policy: PolicyDoc },
    /// Liveness probe.
    Ping,
    /// Report cache / principal stats.
    Stats,
    /// Toggle degraded posture (e.g. fanotify init failed).
    SetDegraded { degraded: bool },
}

/// A response written back on the control socket.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlResponse {
    Ok {
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_len: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        principals: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        degraded: Option<bool>,
    },
    Error {
        message: String,
    },
}

impl ControlResponse {
    pub fn ok() -> Self {
        ControlResponse::Ok {
            cache_len: None,
            principals: None,
            degraded: None,
        }
    }
}

/// The NDJSON envelope fsmon streams to the guest agent's audit socket. The
/// guest agent maps `linux_uid → session` (if not already populated) and POSTs
/// to `{ingest_url}/agents/ingest/events` with the bearer token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditForwardEnvelope {
    pub source: String,
    pub events: Vec<serde_json::Value>,
}

/// Parse a single control request line.
pub fn parse_request(line: &str) -> Result<ControlRequest, String> {
    serde_json::from_str(line.trim()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_policy_apply() {
        let line = r#"{"type":"policy_apply","policy":{"default_decision":"deny","rules":[],"principals":[{"uid":12001,"instance_roots":["/srv/x"]}]}}"#;
        let req = parse_request(line).unwrap();
        match req {
            ControlRequest::PolicyApply { policy } => {
                assert_eq!(policy.principals.len(), 1);
                assert_eq!(policy.principals[0].uid, 12001);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parse_ping_and_stats() {
        assert!(matches!(parse_request(r#"{"type":"ping"}"#).unwrap(), ControlRequest::Ping));
        assert!(matches!(parse_request(r#"{"type":"stats"}"#).unwrap(), ControlRequest::Stats));
    }

    #[test]
    fn parse_set_degraded() {
        let req = parse_request(r#"{"type":"set_degraded","degraded":true}"#).unwrap();
        assert!(matches!(req, ControlRequest::SetDegraded { degraded: true }));
    }

    #[test]
    fn bad_json_errors() {
        assert!(parse_request("not json").is_err());
    }

    #[test]
    fn response_serializes() {
        let resp = ControlResponse::Ok {
            cache_len: Some(3),
            principals: Some(2),
            degraded: Some(false),
        };
        let s = serde_json::to_string(&resp).unwrap();
        assert!(s.contains("\"cache_len\":3"));
    }

    #[test]
    fn audit_forward_envelope_roundtrips() {
        let env = AuditForwardEnvelope {
            source: "synaps-sidecar".to_string(),
            events: vec![serde_json::json!({"kind": "file.write.denied"})],
        };
        let s = serde_json::to_string(&env).unwrap();
        let back: AuditForwardEnvelope = serde_json::from_str(&s).unwrap();
        assert_eq!(back.source, "synaps-sidecar");
        assert_eq!(back.events.len(), 1);
    }
}
