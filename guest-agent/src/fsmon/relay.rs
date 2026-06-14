//! fsmon → guest-agent audit-forward relay (spec §6.7 / §7.2, GA-B8).
//!
//! fsmon does not embed a TLS client by design (`control.rs` docs). It streams
//! `AuditForwardEnvelope` NDJSON to this socket; the guest agent enriches each
//! record with the uid→session map and performs the authenticated, signed
//! `/internal/agentic-vm/audit` POST. The fanotify hot path never makes a
//! synchronous network call — this relay is fully off that path.

use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::api::AppState;

/// Mirrors `fsmon::control::AuditForwardEnvelope`.
#[derive(Debug, Deserialize)]
pub struct AuditForwardEnvelope {
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub events: Vec<Value>,
}

/// Enrich + count a single fsmon audit event using the live session map.
pub fn enrich_event(state: &AppState, mut event: Value) -> Value {
    if let Some(obj) = event.as_object_mut() {
        // Count the decision for the status endpoint.
        if let Some(decision) = obj.get("decision").and_then(|d| d.as_str()) {
            state.runtime.record_decision(decision);
        }
        // Map uid -> session identity if the event lacks it.
        if let Some(uid) = obj.get("linux_uid").and_then(|u| u.as_u64()) {
            if let Some((session_id, account_id, instance_id, user_id)) =
                state.sessions.find_by_uid(uid as u32)
            {
                obj.entry("session_id")
                    .or_insert_with(|| Value::String(session_id));
                obj.entry("account_id")
                    .or_insert_with(|| Value::String(account_id));
                obj.entry("instance_id")
                    .or_insert_with(|| Value::String(instance_id));
                obj.entry("user_id")
                    .or_insert_with(|| Value::String(user_id));
            }
        }
        // Always stamp the vm_id this agent owns.
        obj.entry("vm_id")
            .or_insert_with(|| Value::String(state.config.vm_id.to_string()));
    }
    event
}

/// Process one NDJSON line (an envelope): enrich + forward as signed audit.
pub async fn handle_line(state: &AppState, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let envelope: AuditForwardEnvelope = match serde_json::from_str(line) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(error = %e, "dropping malformed fsmon audit envelope");
            return;
        }
    };
    let enriched: Vec<Value> = envelope
        .events
        .into_iter()
        .map(|ev| enrich_event(state, ev))
        .collect();
    if !enriched.is_empty() {
        // Off the hot path: the guest agent does the authenticated POST (spools
        // on failure inside the client).
        let _ = state.pria.audit(enriched).await;
    }
}

/// Spawn the audit-forward listener on `socket_path`. Returns the join handle.
pub fn spawn_audit_relay(
    state: AppState,
    socket_path: impl AsRef<Path>,
) -> std::io::Result<tokio::task::JoinHandle<()>> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::UnixListener;

    let path = socket_path.as_ref().to_path_buf();
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = UnixListener::bind(&path)?;
    let state = Arc::new(state);

    let handle = tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let state = state.clone();
                    tokio::spawn(async move {
                        let reader = BufReader::new(stream);
                        let mut lines = reader.lines();
                        while let Ok(Some(line)) = lines.next_line().await {
                            handle_line(&state, &line).await;
                        }
                    });
                }
                Err(e) => {
                    tracing::warn!(error = %e, "fsmon audit relay accept failed");
                }
            }
        }
    });
    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pria_client::fake::FakePriaClient;
    use crate::test_support::test_state_with_pria;

    #[tokio::test]
    async fn enriches_and_counts_and_forwards() {
        let pria = Arc::new(FakePriaClient::default());
        let state = test_state_with_pria(pria.clone());
        let envelope = serde_json::json!({
            "source": "synaps-sidecar",
            "events": [
                {"kind": "file.write.denied", "decision": "deny", "linux_uid": 104251, "path": "/etc/x"},
                {"kind": "file.write.allowed", "decision": "allow", "linux_uid": 104251, "path": "/home/x"}
            ]
        });
        handle_line(&state, &envelope.to_string()).await;

        let audits = pria.audits.lock().unwrap();
        assert_eq!(audits.len(), 2);
        // vm_id stamped on every forwarded record.
        assert_eq!(audits[0]["vm_id"], "vm_456");
        // decision counters updated.
        let d = state.runtime.fsmon_decisions();
        assert_eq!(d.denied, 1);
        assert_eq!(d.allowed, 1);
    }

    #[tokio::test]
    async fn drops_malformed_line_without_panic() {
        let pria = Arc::new(FakePriaClient::default());
        let state = test_state_with_pria(pria.clone());
        handle_line(&state, "not json").await;
        assert_eq!(pria.audits.lock().unwrap().len(), 0);
    }
}
