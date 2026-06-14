//! `POST {prefix}/usage` — AC-B2.2 in-VM usage signing proxy.
//!
//! The Pria session-context plugin fires SynapsCLI's `on_usage` hook (protocol
//! v2), builds the spec §6.2 usage envelope, and POSTs it here. The plugin holds
//! **no** Pria HMAC key — the guest agent owns signing + attribution:
//!
//!   1. The plugin names a `session_id`; the guest agent resolves the trusted
//!      account/instance/user tags from its own session table (the plugin may
//!      NOT spoof them) and stamps `vm_id`/`replica_id` from config.
//!   2. `tag_plugin_usage` preserves the plugin-derived idempotency keys and the
//!      raw token counts, forces the `synaps-hook-on-usage` source, drops empty
//!      turns, and rejects any `credits` field (raw-only, spec §5.5).
//!   3. The result is forwarded via `pria.usage()` — the same signed primitive
//!      the RPC-boundary fallback (AC-B1.3) uses — which signs + POSTs to
//!      `/internal/agentic-vm/usage` and spools on failure.
//!
//! Unlike the Pria-facing routes this endpoint is **not** Pria-HMAC-verified:
//! the in-VM plugin cannot hold the Pria key. Trust is bounded by (a) requiring
//! a known `session_id` and (b) overriding all identity tags from the session
//! table, so a caller can at most attribute raw usage to an already-running
//! session it must already know. Hardening to a loopback/UDS-only listener is a
//! deployment concern (see handoff notes).

use axum::extract::State;
use axum::Json;
use serde::Serialize;
use serde_json::Value;

use crate::api::AppState;
use crate::error::{ErrorCode, GuestAgentError};
use crate::synaps::launcher::{tag_plugin_usage, UsageIdentity};

#[derive(Debug, Serialize)]
pub struct UsageProxyResponse {
    /// Number of billable usage events accepted + forwarded.
    pub accepted: usize,
    /// The canonical source tag applied to the forwarded batch.
    pub source: &'static str,
    pub session_id: String,
}

pub async fn ingest(
    State(state): State<AppState>,
    Json(envelope): Json<Value>,
) -> Result<Json<UsageProxyResponse>, GuestAgentError> {
    let session_id = envelope
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if session_id.is_empty() {
        return Err(GuestAgentError::new(
            ErrorCode::InvalidRequest,
            "usage envelope missing session_id",
        ));
    }

    // Trusted attribution: account/instance/user come from the session table,
    // NOT from the plugin-supplied envelope (anti-spoof).
    let (account_id, instance_id, user_id) = state
        .sessions
        .identity_tags(&session_id)
        .ok_or_else(|| GuestAgentError::new(ErrorCode::SessionNotFound, "unknown session_id"))?;

    let ephemeral_task_id = envelope
        .get("ephemeral_task_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let identity = UsageIdentity {
        account_id,
        instance_id,
        user_id,
        vm_id: state.config.vm_id.to_string(),
        replica_id: state.config.replica_id.clone(),
        session_id: session_id.clone(),
        ephemeral_task_id,
    };

    match tag_plugin_usage(&envelope, &identity) {
        Some(payload) => {
            let accepted = payload.events.len();
            // Best-effort signed forward (spools on failure — never errors out).
            let _ = state.pria.usage(&payload).await;
            Ok(Json(UsageProxyResponse {
                accepted,
                source: crate::pria_client::payloads::SOURCE_ON_USAGE,
                session_id,
            }))
        }
        // No billable events (empty turn / all-zero) — accept with zero count.
        None => Ok(Json(UsageProxyResponse {
            accepted: 0,
            source: crate::pria_client::payloads::SOURCE_ON_USAGE,
            session_id,
        })),
    }
}
