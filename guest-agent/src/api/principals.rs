//! Principal reconcile/disable handlers (spec §6.2/§6.3).

use axum::extract::State;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::api::AppState;
use crate::error::{ErrorCode, GuestAgentError};
use crate::hmac::SignedJson;
use crate::os::{PrincipalAction, PrincipalState, UserSpec};
use crate::paths::has_no_traversal;
use crate::pria_client::{kinds, AuditEventBuilder};

#[derive(Debug, Deserialize)]
pub struct DesiredPrincipal {
    pub user_id: String,
    pub linux_username: String,
    pub uid: u32,
    pub gid: u32,
    #[serde(default = "default_state")]
    pub state: String,
    #[serde(default)]
    pub home_dir: Option<String>,
    #[serde(default)]
    pub instance_ids: Vec<String>,
}

fn default_state() -> String {
    "active".to_string()
}

#[derive(Debug, Deserialize)]
pub struct ReconcileRequest {
    pub account_id: String,
    pub desired: Vec<DesiredPrincipal>,
    #[serde(default)]
    pub disable_unspecified: bool,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReconcileResult {
    pub user_id: String,
    pub linux_username: String,
    pub uid: u32,
    pub state: String,
    pub action: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReconcileResponse {
    pub request_id: Option<String>,
    pub results: Vec<ReconcileResult>,
}

pub async fn reconcile(
    State(state): State<AppState>,
    SignedJson { value: req, .. }: SignedJson<ReconcileRequest>,
) -> Result<Json<ReconcileResponse>, GuestAgentError> {
    // Bind check: the request's account must match this VM's account.
    if req.account_id != state.config.account_id.as_str() {
        return Err(GuestAgentError::new(
            ErrorCode::ForbiddenAccountVmMismatch,
            "account mismatch",
        )
        .with_request_id(req.request_id.clone()));
    }

    let mut results = Vec::with_capacity(req.desired.len());
    for d in &req.desired {
        // Validate home dir is traversal-free if provided.
        if let Some(home) = &d.home_dir {
            if !has_no_traversal(std::path::Path::new(home)) {
                results.push(ReconcileResult {
                    user_id: d.user_id.clone(),
                    linux_username: d.linux_username.clone(),
                    uid: d.uid,
                    state: d.state.clone(),
                    action: "rejected".to_string(),
                    ok: false,
                    error: Some("home_dir contains traversal".to_string()),
                });
                continue;
            }
        }
        let desired_state = PrincipalState::from_str_loose(&d.state);
        let spec = UserSpec {
            username: d.linux_username.clone(),
            uid: d.uid,
            gid: d.gid,
            home_dir: d.home_dir.clone(),
            state: desired_state,
        };
        match state.os.ensure_user(&spec).await {
            Ok(action) => {
                emit_principal_audit(&state, &req.account_id, d, action).await;
                results.push(ReconcileResult {
                    user_id: d.user_id.clone(),
                    linux_username: d.linux_username.clone(),
                    uid: d.uid,
                    state: d.state.clone(),
                    action: action.as_str().to_string(),
                    ok: true,
                    error: None,
                });
            }
            Err(e) => {
                results.push(ReconcileResult {
                    user_id: d.user_id.clone(),
                    linux_username: d.linux_username.clone(),
                    uid: d.uid,
                    state: d.state.clone(),
                    action: "failed".to_string(),
                    ok: false,
                    error: Some(e.to_string()),
                });
            }
        }
    }

    Ok(Json(ReconcileResponse {
        request_id: req.request_id,
        results,
    }))
}

async fn emit_principal_audit(
    state: &AppState,
    account_id: &str,
    d: &DesiredPrincipal,
    action: PrincipalAction,
) {
    let kind = match action {
        PrincipalAction::Created => kinds::PRINCIPAL_CREATED,
        PrincipalAction::Disabled => kinds::PRINCIPAL_DISABLED,
        PrincipalAction::Updated | PrincipalAction::Unchanged => kinds::PRINCIPAL_UPDATED,
    };
    let ev = AuditEventBuilder::new(kind)
        .str_field("account_id", account_id)
        .str_field("vm_id", state.config.vm_id.to_string())
        .str_field("user_id", d.user_id.clone())
        .str_field("linux_username", d.linux_username.clone())
        .u32_field("linux_uid", d.uid)
        .str_field("action", action.as_str())
        .build();
    let _ = state.pria.audit(vec![ev]).await;
}

#[derive(Debug, Deserialize)]
pub struct DisableRequest {
    pub account_id: String,
    pub user_id: String,
    pub linux_username: String,
    #[serde(default)]
    pub kill_active_sessions: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DisableResponse {
    pub request_id: Option<String>,
    pub linux_username: String,
    pub disabled: bool,
    pub killed_processes: u32,
}

pub async fn disable(
    State(state): State<AppState>,
    SignedJson { value: req, .. }: SignedJson<DisableRequest>,
) -> Result<Json<DisableResponse>, GuestAgentError> {
    if req.account_id != state.config.account_id.as_str() {
        return Err(GuestAgentError::new(
            ErrorCode::ForbiddenAccountVmMismatch,
            "account mismatch",
        )
        .with_request_id(req.request_id.clone()));
    }

    let record = state
        .os
        .lookup(&req.linux_username)
        .await
        .map_err(|e| GuestAgentError::internal(e.to_string()))?
        .ok_or_else(|| {
            GuestAgentError::new(ErrorCode::PrincipalNotFound, "principal not found")
                .with_request_id(req.request_id.clone())
        })?;

    state
        .os
        .disable_user(&req.linux_username)
        .await
        .map_err(|e| GuestAgentError::internal(e.to_string()))?;

    let mut killed = 0;
    if req.kill_active_sessions {
        killed = state
            .os
            .kill_user_processes(record.uid)
            .await
            .map_err(|e| GuestAgentError::internal(e.to_string()))?;
    }

    let ev = AuditEventBuilder::new(kinds::PRINCIPAL_DISABLED)
        .str_field("account_id", req.account_id.clone())
        .str_field("vm_id", state.config.vm_id.to_string())
        .str_field("user_id", req.user_id.clone())
        .str_field("linux_username", req.linux_username.clone())
        .u32_field("linux_uid", record.uid)
        .opt_str("reason", req.reason.clone())
        .build();
    let _ = state.pria.audit(vec![ev]).await;

    Ok(Json(DisableResponse {
        request_id: req.request_id,
        linux_username: req.linux_username,
        disabled: true,
        killed_processes: killed,
    }))
}
