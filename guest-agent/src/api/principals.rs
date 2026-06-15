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
pub struct InstanceGroup {
    /// Instance ObjectId (the EFS subdirectory name under `instances/`).
    pub id: String,
    /// Deterministic Linux group name (`inst_<slug>`).
    pub name: String,
    /// Deterministic gid (instance band, 60000–64999).
    pub gid: u32,
}

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
    /// Optional name of the primary group to create at `gid` before adding the
    /// user. Sent by the control plane for per-account primary-group isolation.
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub instance_ids: Vec<String>,
    /// Per-instance groups the user is authorized for. The guest ensures each
    /// group exists, adds the user to it, and materializes a private EFS
    /// workspace directory for the instance (`instances/<id>`, 2770/setgid,
    /// owned root:`gid`). This is the per-instance tenant isolation boundary.
    #[serde(default)]
    pub instance_groups: Vec<InstanceGroup>,
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
            group_name: d.group_name.clone(),
        };
        match state.os.ensure_user(&spec).await {
            Ok(action) => {
                // Per-instance tenant isolation: only materialize instance
                // groups + private dirs for an ACTIVE principal (a disabled one
                // gets no new grants). Fail-closed — if we cannot create the
                // isolation boundary the principal reconcile fails so the
                // session never launches into a shared/world dir.
                let mut iso_err: Option<String> = None;
                if desired_state == PrincipalState::Active {
                    if let Err(e) =
                        apply_instance_isolation(&state, &d.linux_username, &d.instance_groups).await
                    {
                        iso_err = Some(e);
                    }
                }
                if let Some(e) = iso_err {
                    results.push(ReconcileResult {
                        user_id: d.user_id.clone(),
                        linux_username: d.linux_username.clone(),
                        uid: d.uid,
                        state: d.state.clone(),
                        action: "failed".to_string(),
                        ok: false,
                        error: Some(e),
                    });
                    continue;
                }
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

/// Materialize per-instance tenant isolation for `username`: for each
/// authorized instance group, (1) ensure the group exists + the user is a
/// member, and (2) create the instance's private EFS directory
/// (`<efs_root>/instances/<id>`) owned `root:<gid>`, mode `2770` + setgid.
///
/// Fail-closed: any error aborts (returns `Err`) so the principal reconcile
/// fails and the session does not launch — never silently degrade to a
/// world-readable or shared workspace. Idempotent across reruns.
async fn apply_instance_isolation(
    state: &AppState,
    username: &str,
    groups: &[InstanceGroup],
) -> Result<(), String> {
    let efs_root = state.config.paths.efs_root.as_path();
    for g in groups {
        // Validate the instance id is a safe single path component (it becomes
        // a directory name under efs_root/instances).
        if g.id.is_empty()
            || g.id.contains('/')
            || g.id.contains('\\')
            || g.id == "."
            || g.id == ".."
        {
            return Err(format!("invalid instance id '{}'", g.id));
        }
        state
            .os
            .ensure_group_membership(username, g.gid, &g.name)
            .await
            .map_err(|e| format!("group membership {}: {e}", g.name))?;
        ensure_instance_dir(efs_root, &g.id, g.gid)
            .map_err(|e| format!("instance dir {}: {e}", g.id))?;
    }
    Ok(())
}

/// Create (idempotently) `<efs_root>/instances/<instance_id>` as the instance's
/// private shared root: owned `root:<gid>`, mode `2770` with the setgid bit so
/// every file/dir created beneath it inherits the `inst_<id>` group. Members of
/// that group collaborate; non-members get no access (no "other" bits).
fn ensure_instance_dir(efs_root: &std::path::Path, instance_id: &str, gid: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = efs_root.join("instances").join(instance_id);
    // Defense in depth: the resolved path must stay under efs_root.
    if !crate::paths::is_under(efs_root, &dir) {
        return Err("path escapes efs_root".to_string());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    let c_path = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes())
        .map_err(|e| format!("path nul: {e}"))?;
    // SAFETY: valid NUL-terminated path; owner root (0), group → instance gid.
    let rc = unsafe { libc::chown(c_path.as_ptr(), 0, gid) };
    if rc != 0 {
        return Err(format!("chown: {}", std::io::Error::last_os_error()));
    }
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o2770))
        .map_err(|e| format!("set_permissions: {e}"))?;
    Ok(())
}

/// Per-instance DE-authorization handler (the inverse of the additive
/// `instance_groups` grant in `reconcile`). Removes `linux_username` from each
/// listed instance group so the user loses access to that tenant's private EFS
/// workspace — WITHOUT touching the account principal or any OTHER instance
/// group. This is the surgical alternative to `disable` (which locks the whole
/// account across every instance). Idempotent + fail-open per-group: revoking a
/// membership the user no longer holds succeeds.
pub async fn revoke_instance(
    State(state): State<AppState>,
    SignedJson { value: req, .. }: SignedJson<RevokeInstanceRequest>,
) -> Result<Json<RevokeInstanceResponse>, GuestAgentError> {
    if req.account_id != state.config.account_id.as_str() {
        return Err(GuestAgentError::new(
            ErrorCode::ForbiddenAccountVmMismatch,
            "account mismatch",
        )
        .with_request_id(req.request_id.clone()));
    }

    let mut results = Vec::with_capacity(req.instance_groups.len());
    for g in &req.instance_groups {
        match state
            .os
            .revoke_group_membership(&req.linux_username, &g.name)
            .await
        {
            Ok(()) => {
                let ev = AuditEventBuilder::new(kinds::PRINCIPAL_UPDATED)
                    .str_field("account_id", req.account_id.clone())
                    .str_field("vm_id", state.config.vm_id.to_string())
                    .str_field("user_id", req.user_id.clone())
                    .str_field("linux_username", req.linux_username.clone())
                    .str_field("action", "instance_revoked")
                    .str_field("instance_id", g.id.clone())
                    .str_field("group_name", g.name.clone())
                    .build();
                let _ = state.pria.audit(vec![ev]).await;
                results.push(RevokeInstanceResult {
                    instance_id: g.id.clone(),
                    group_name: g.name.clone(),
                    ok: true,
                    error: None,
                });
            }
            Err(e) => results.push(RevokeInstanceResult {
                instance_id: g.id.clone(),
                group_name: g.name.clone(),
                ok: false,
                error: Some(e.to_string()),
            }),
        }
    }

    Ok(Json(RevokeInstanceResponse {
        request_id: req.request_id,
        linux_username: req.linux_username,
        results,
    }))
}

#[derive(Debug, Deserialize)]
pub struct RevokeInstanceRequest {
    pub account_id: String,
    pub user_id: String,
    pub linux_username: String,
    /// Per-instance groups to REMOVE the user from. Each corresponds to an
    /// instance whose per-instance authorization has been revoked.
    #[serde(default)]
    pub instance_groups: Vec<InstanceGroup>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RevokeInstanceResult {
    pub instance_id: String,
    pub group_name: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RevokeInstanceResponse {
    pub request_id: Option<String>,
    pub linux_username: String,
    pub results: Vec<RevokeInstanceResult>,
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
