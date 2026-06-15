//! `POST /guest/v1/policy/apply` (spec §6.6). Fail-closed validation.

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::api::AppState;
use crate::error::{ErrorCode, GuestAgentError};
use crate::fsmon::compile::{compile, ApplyPolicyRequest};
use crate::hmac::SignedJson;
use crate::pria_client::{kinds, AuditEventBuilder};
use crate::runtime::{FsmonStatus, PolicyState};

#[derive(Debug, Serialize)]
pub struct ApplyPolicyResponse {
    pub request_id: Option<String>,
    pub applied: bool,
    pub policy_hash: String,
    pub fsmon_applied: bool,
    pub synaps_plugin_policy_applied: bool,
    pub warnings: Vec<String>,
}

pub async fn apply(
    State(state): State<AppState>,
    SignedJson { value: req, .. }: SignedJson<ApplyPolicyRequest>,
) -> Result<Json<ApplyPolicyResponse>, GuestAgentError> {
    let rid = req.request_id.clone();

    if req.account_id != state.config.account_id.as_str() {
        return Err(GuestAgentError::new(
            ErrorCode::ForbiddenAccountVmMismatch,
            "account mismatch",
        )
        .with_request_id(rid.clone()));
    }

    // Validate + compile (fail-closed). On reject: emit policy.rejected, 400.
    let compiled = match compile(&req) {
        Ok(c) => c,
        Err(reason) => {
            let ev = AuditEventBuilder::new(kinds::POLICY_REJECTED)
                .str_field("account_id", req.account_id.clone())
                .str_field("vm_id", state.config.vm_id.to_string())
                .opt_str("policy_profile_id", req.policy_profile_id.clone())
                .str_field("reason", reason.clone())
                .build();
            let _ = state.pria.audit(vec![ev]).await;
            return Err(
                GuestAgentError::new(ErrorCode::InvalidPolicy, reason).with_request_id(rid.clone())
            );
        }
    };

    let mut warnings = Vec::new();

    // Push to fsmon (kernel enforcement, HS-8). fsmon is not started at boot
    // (boot-time whole-mount FAN_*_PERM marking deadlocks the guest), so activate
    // it on demand here before pushing the policy. fsmon down => warn, not fail.
    if let Err(e) = state.fsmon.ensure_running().await {
        warnings.push(format!("fsmon_activation: {e}"));
    }
    let fsmon_applied = match state.fsmon.apply_policy(&compiled.doc).await {
        Ok(_) => {
            state.runtime.set_fsmon_status(FsmonStatus::Healthy);
            state.runtime.set_last_fsmon_policy(compiled.doc.clone());
            true
        }
        Err(e) => {
            warnings.push(format!("fsmon_unavailable: {e}"));
            state.runtime.set_fsmon_status(FsmonStatus::Unavailable);
            // Still remember the policy so a later fsmon/reload can re-push it.
            state.runtime.set_last_fsmon_policy(compiled.doc.clone());
            false
        }
    };

    // Apply to the plugin via the policy file (HS-8 mitigation: no SynapsCLI
    // core policy-ingestion API exists; the plugin reads the policy file).
    let synaps_plugin_policy_applied = write_plugin_policy(&state, &req).is_ok();
    if !synaps_plugin_policy_applied {
        warnings.push("plugin_policy_write_failed".to_string());
    }

    // Record the applied policy summary for health/heartbeat.
    state.runtime.set_policy(PolicyState {
        policy_profile_id: req.policy_profile_id.clone(),
        policy_version: req.policy_version,
        policy_hash: Some(compiled.policy_hash.clone()),
    });

    let ev = AuditEventBuilder::new(kinds::POLICY_APPLIED)
        .str_field("account_id", req.account_id.clone())
        .str_field("vm_id", state.config.vm_id.to_string())
        .opt_str("policy_profile_id", req.policy_profile_id.clone())
        .str_field("policy_hash", compiled.policy_hash.clone())
        .json_field("fsmon_applied", serde_json::json!(fsmon_applied))
        .build();
    let _ = state.pria.audit(vec![ev]).await;

    Ok(Json(ApplyPolicyResponse {
        request_id: rid,
        applied: true,
        policy_hash: compiled.policy_hash,
        fsmon_applied,
        synaps_plugin_policy_applied,
        warnings,
    }))
}

/// Write the compiled policy to `policy_dir/active-policy.json` for the
/// session-context plugin to read (HS-8 mitigation, no core mutation).
fn write_plugin_policy(state: &AppState, req: &ApplyPolicyRequest) -> std::io::Result<()> {
    let dir = &state.config.paths.policy_dir;
    std::fs::create_dir_all(dir)?;
    let path = dir.join("active-policy.json");
    let json = serde_json::to_vec_pretty(&serde_json::json!({
        "policy_profile_id": req.policy_profile_id,
        "policy_version": req.policy_version,
        "policy_hash": req.policy_hash,
        "rules": req.rules.filesystem.as_ref().map(|f| serde_json::json!({
            "default": f.default,
            "deny": f.deny,
            "observe": f.observe,
        })),
        "tools": req.rules.tools.as_ref().map(|t| serde_json::json!({
            "credential_required": t.credential_required,
        })),
    }))?;
    std::fs::write(path, json)
}
