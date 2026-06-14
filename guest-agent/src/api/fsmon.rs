//! fsmon status + reload handlers (spec §6.7).

use axum::extract::State;
use axum::Json;
use serde::Serialize;
use serde_json::Value;

use crate::api::AppState;
use crate::error::{ErrorCode, GuestAgentError};
use crate::hmac::SignedJson;
use crate::runtime::FsmonStatus;

#[derive(Debug, Serialize)]
pub struct DecisionCounts {
    pub allowed: u64,
    pub denied: u64,
    pub observed: u64,
}

#[derive(Debug, Serialize)]
pub struct FsmonStatusResponse {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_loaded_at: Option<String>,
    pub decisions: DecisionCounts,
    pub last_error: Option<String>,
}

/// `GET /guest/v1/fsmon/status` (unauthenticated, like health — read-only).
pub async fn status(State(state): State<AppState>) -> Json<FsmonStatusResponse> {
    // Probe liveness via the control socket.
    let (status, last_error) = match state.fsmon.stats().await {
        Ok(_) => {
            state.runtime.set_fsmon_status(FsmonStatus::Healthy);
            (FsmonStatus::Healthy, None)
        }
        Err(e) => {
            state.runtime.set_fsmon_status(FsmonStatus::Unavailable);
            (FsmonStatus::Unavailable, Some(e.to_string()))
        }
    };
    let d = state.runtime.fsmon_decisions();
    Json(FsmonStatusResponse {
        status: status.as_str(),
        pid: None,
        policy_hash: state.runtime.policy().policy_hash,
        policy_loaded_at: state.runtime.policy_loaded_at(),
        decisions: DecisionCounts {
            allowed: d.allowed,
            denied: d.denied,
            observed: d.observed,
        },
        last_error,
    })
}

#[derive(Debug, Serialize)]
pub struct ReloadResponse {
    pub reloaded: bool,
    pub fsmon_applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_hash: Option<String>,
}

/// `POST /guest/v1/fsmon/reload` — re-push the last applied policy.
pub async fn reload(
    State(state): State<AppState>,
    _signed: SignedJson<Value>,
) -> Result<Json<ReloadResponse>, GuestAgentError> {
    match state.runtime.last_fsmon_policy() {
        Some(doc) => match state.fsmon.apply_policy(&doc).await {
            Ok(_) => {
                state.runtime.set_fsmon_status(FsmonStatus::Healthy);
                Ok(Json(ReloadResponse {
                    reloaded: true,
                    fsmon_applied: true,
                    policy_hash: state.runtime.policy().policy_hash,
                }))
            }
            Err(e) => {
                state.runtime.set_fsmon_status(FsmonStatus::Unavailable);
                Err(GuestAgentError::new(
                    ErrorCode::FsmonUnavailable,
                    e.to_string(),
                ))
            }
        },
        None => {
            // No policy applied yet — a reload is a no-op but ping the daemon.
            state
                .fsmon
                .ping()
                .await
                .map_err(|e| GuestAgentError::new(ErrorCode::FsmonUnavailable, e.to_string()))?;
            Ok(Json(ReloadResponse {
                reloaded: false,
                fsmon_applied: false,
                policy_hash: None,
            }))
        }
    }
}
