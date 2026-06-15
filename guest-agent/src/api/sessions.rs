//! Session start/control handlers (spec §6.4/§6.5).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use axum::extract::{Path as AxPath, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::AppState;
use crate::error::{ErrorCode, GuestAgentError};
use crate::hmac::SignedJson;
use crate::paths::ensure_under;
use crate::pria_client::{kinds, AuditEventBuilder};
use crate::sessions::SessionEntry;
use crate::synaps::launcher::LaunchSpec;
use crate::synaps::launcher::{relay_agent_end_usage, UsageIdentity};
use crate::synaps::session_context::{now_timestamps, write_context, SessionContext};

#[derive(Debug, Deserialize)]
pub struct TransportSpec {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    // token_ref is a reference, never an inline long-lived secret (§16.3).
    #[serde(default)]
    pub token_ref: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StartSessionRequest {
    pub account_id: String,
    pub instance_id: String,
    pub user_id: String,
    pub session_id: String,
    pub vm_id: String,
    pub linux_username: String,
    pub uid: u32,
    pub gid: u32,
    #[serde(default)]
    pub policy_profile_id: Option<String>,
    #[serde(default)]
    pub policy_version: Option<u64>,
    #[serde(default)]
    pub policy_hash: Option<String>,
    pub workspace_dir: PathBuf,
    #[serde(default)]
    pub user_home_dir: Option<PathBuf>,
    pub session_dir: PathBuf,
    #[serde(default)]
    pub transport: Option<TransportSpec>,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub environment: HashMap<String, String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StartSessionResponse {
    pub request_id: Option<String>,
    pub session_id: String,
    pub status: String,
    pub pid: u32,
    pub context_path: String,
    pub started_at: String,
}

pub async fn start(
    State(state): State<AppState>,
    SignedJson { value: req, .. }: SignedJson<StartSessionRequest>,
) -> Result<Json<StartSessionResponse>, GuestAgentError> {
    let rid = req.request_id.clone();
    let err = |code, msg: &str| GuestAgentError::new(code, msg).with_request_id(rid.clone());

    // Bind checks.
    if req.account_id != state.config.account_id.as_str()
        || req.vm_id != state.config.vm_id.as_str()
    {
        return Err(err(
            ErrorCode::ForbiddenAccountVmMismatch,
            "account/vm mismatch",
        ));
    }

    // Never root.
    if req.uid == 0 || req.gid == 0 {
        return Err(err(
            ErrorCode::InvalidRequest,
            "refusing to start a session as root",
        ));
    }

    // Path validation: workspace + session dir must be under the EFS root and
    // traversal-free (spec §13.5).
    let efs_root = state.config.paths.efs_root.as_path();
    ensure_under(efs_root, &req.workspace_dir).map_err(|e| err(ErrorCode::InvalidRequest, &e))?;
    ensure_under(efs_root, &req.session_dir).map_err(|e| err(ErrorCode::InvalidRequest, &e))?;

    // Duplicate session guard.
    if state.sessions.contains(&req.session_id) {
        return Err(err(
            ErrorCode::SessionAlreadyRunning,
            "session already running",
        ));
    }

    // Verify the principal exists and is active (spec §6.4 step 1).
    let record = state
        .os
        .lookup(&req.linux_username)
        .await
        .map_err(|e| GuestAgentError::internal(e.to_string()).with_request_id(rid.clone()))?
        .ok_or_else(|| err(ErrorCode::PrincipalNotFound, "principal not found"))?;
    if !record.active {
        return Err(err(
            ErrorCode::PrincipalDisabled,
            "principal is disabled and cannot start a session",
        ));
    }
    if record.uid != req.uid {
        return Err(err(
            ErrorCode::InvalidRequest,
            "uid does not match the resolved principal",
        ));
    }

    // Create the session directory (spec §6.4 step 2).
    if let Err(e) = std::fs::create_dir_all(&req.session_dir) {
        return Err(err(
            ErrorCode::InternalError,
            &format!("failed to create session dir: {e}"),
        ));
    }

    // Per-instance tenant isolation (Track G): ensure the session's working
    // directory exists, is owned by the launching user, and is private to the
    // instance group. The parent `instances/<id>` dir carries the setgid bit +
    // the `inst_<id>` group (set at reconcile), so the freshly created subtree
    // inherits that group; we then take ownership for the user and lock mode to
    // 2770 (no "other" access). A user not in `inst_<id>` cannot traverse here.
    if let Err(e) = prepare_workspace_dir(&req.workspace_dir, req.uid) {
        return Err(err(
            ErrorCode::InternalError,
            &format!("failed to prepare workspace dir: {e}"),
        ));
    }

    // Resolve the launching user's full group list for an initgroups-style
    // privilege drop. The synaps child must run with EXACTLY these groups so it
    // (a) gains its authorized `inst_<id>` instance groups and (b) drops the
    // agent's root supplementary groups (spec §16.3). Fail-closed: a session
    // that can't resolve groups would either leak root groups or lose instance
    // access, so refuse rather than launch with the wrong group set.
    let groups = state
        .os
        .resolve_group_gids(&req.linux_username)
        .await
        .map_err(|e| err(ErrorCode::InternalError, &format!("resolve groups: {e}")))?;

    // Write the session-context file (spec §6.4 step 3 / §8 / HS-2).
    let (issued, expires, created) = now_timestamps(60);
    let transport = match &req.transport {
        Some(t) => {
            json!({ "kind": t.kind.clone().unwrap_or_else(|| "pria-agent-websocket".into()) })
        }
        None => json!({ "kind": "pria-agent-websocket" }),
    };
    let ctx = SessionContext {
        account_id: req.account_id.clone(),
        instance_id: req.instance_id.clone(),
        user_id: req.user_id.clone(),
        vm_id: req.vm_id.clone(),
        replica_id: state.config.replica_id.clone(),
        session_id: req.session_id.clone(),
        linux_username: req.linux_username.clone(),
        linux_uid: req.uid,
        linux_gid: req.gid,
        roles: req.roles.clone(),
        policy_profile_id: req.policy_profile_id.clone(),
        policy_version: req.policy_version,
        policy_hash: req.policy_hash.clone(),
        pria_base_url: state.config.pria.base_url.clone(),
        audit_endpoint: "/internal/agentic-vm/audit".into(),
        credential_broker_endpoint: "/internal/agentic-vm/credential-request".into(),
        transport,
        issued_at: issued,
        expires_at: expires,
        created_at: created.clone(),
    };
    let written = write_context(&ctx, state.config.paths.run_root.as_path())
        .map_err(|e| e.with_request_id(rid.clone()))?;
    let context_path = written.path.to_string_lossy().to_string();

    // Launch synaps dropped to uid/gid (spec §6.4 step 4, §16.3).
    let spec = LaunchSpec {
        binary: state.config.synaps.binary.clone(),
        args: vec!["rpc".to_string()],
        uid: req.uid,
        gid: req.gid,
        groups,
        cwd: Some(req.workspace_dir.clone()),
        env: req.environment.clone(),
        context_path: written.path.clone(),
        session_id: req.session_id.clone(),
    };
    let process = state.synaps.launch(&spec).await.map_err(|e| {
        GuestAgentError::new(ErrorCode::SynapsLaunchFailed, e.to_string())
            .with_request_id(rid.clone())
    })?;
    let pid = process.pid();

    // Spawn the usage-relay reader: stream synaps `rpc` stdout and meter every
    // billable `agent_end` frame into Pria's signed usage callback (spec §5.5,
    // HS-U6). The guest agent stamps trusted account/vm/user/session identity
    // that SynapsCLI core cannot know.
    if let Some(stdout) = process.take_stdout() {
        let identity = UsageIdentity {
            account_id: req.account_id.clone(),
            instance_id: req.instance_id.clone(),
            user_id: req.user_id.clone(),
            vm_id: req.vm_id.clone(),
            replica_id: state.config.replica_id.clone(),
            session_id: req.session_id.clone(),
            ephemeral_task_id: None,
        };
        let pria = state.pria.clone();
        tokio::spawn(relay_agent_end_usage(stdout, identity, pria));
    }

    state.sessions.insert(SessionEntry {
        session_id: req.session_id.clone(),
        account_id: req.account_id.clone(),
        instance_id: req.instance_id.clone(),
        user_id: req.user_id.clone(),
        uid: req.uid,
        pid,
        started_at: created.clone(),
        context_path: context_path.clone(),
        process,
    });

    // Emit session.started audit (spec §6.4 step 6).
    let ev = AuditEventBuilder::new(kinds::SESSION_STARTED)
        .str_field("account_id", req.account_id.clone())
        .str_field("instance_id", req.instance_id.clone())
        .str_field("user_id", req.user_id.clone())
        .str_field("vm_id", req.vm_id.clone())
        .str_field("session_id", req.session_id.clone())
        .u32_field("linux_uid", req.uid)
        .u32_field("pid", pid)
        .opt_str("policy_hash", req.policy_hash.clone())
        .build();
    let _ = state.pria.audit(vec![ev]).await;

    Ok(Json(StartSessionResponse {
        request_id: req.request_id,
        session_id: req.session_id,
        status: "starting".to_string(),
        pid,
        context_path,
        started_at: created,
    }))
}

// ── control ──────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SendRequest {
    #[serde(default)]
    pub message_id: Option<String>,
    pub input: String,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct AckResponse {
    pub session_id: String,
    pub ok: bool,
}

pub async fn send(
    State(state): State<AppState>,
    AxPath(session_id): AxPath<String>,
    SignedJson { value: req, .. }: SignedJson<SendRequest>,
) -> Result<Json<AckResponse>, GuestAgentError> {
    let proc = state
        .sessions
        .process(&session_id)
        .ok_or_else(|| GuestAgentError::new(ErrorCode::SessionNotFound, "session not found"))?;
    proc.send(&req.input)
        .await
        .map_err(|e| GuestAgentError::new(ErrorCode::SessionNotFound, e.to_string()))?;
    Ok(Json(AckResponse {
        session_id,
        ok: true,
    }))
}

#[derive(Debug, Deserialize)]
pub struct CancelRequest {
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

pub async fn cancel(
    State(state): State<AppState>,
    AxPath(session_id): AxPath<String>,
    SignedJson { value: req, .. }: SignedJson<CancelRequest>,
) -> Result<Json<AckResponse>, GuestAgentError> {
    let proc = state
        .sessions
        .process(&session_id)
        .ok_or_else(|| GuestAgentError::new(ErrorCode::SessionNotFound, "session not found"))?;
    proc.cancel()
        .await
        .map_err(|e| GuestAgentError::internal(e.to_string()))?;
    let ev = AuditEventBuilder::new(kinds::SESSION_CANCELLED)
        .str_field("account_id", state.config.account_id.to_string())
        .str_field("vm_id", state.config.vm_id.to_string())
        .str_field("session_id", session_id.clone())
        .opt_str("reason", req.reason.clone())
        .build();
    let _ = state.pria.audit(vec![ev]).await;
    Ok(Json(AckResponse {
        session_id,
        ok: true,
    }))
}

#[derive(Debug, Deserialize)]
pub struct CloseRequest {
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub grace_period_ms: Option<u64>,
    #[serde(default)]
    pub request_id: Option<String>,
}

pub async fn close(
    State(state): State<AppState>,
    AxPath(session_id): AxPath<String>,
    SignedJson { value: req, .. }: SignedJson<CloseRequest>,
) -> Result<Json<AckResponse>, GuestAgentError> {
    let proc = state
        .sessions
        .process(&session_id)
        .ok_or_else(|| GuestAgentError::new(ErrorCode::SessionNotFound, "session not found"))?;
    proc.close(req.grace_period_ms.unwrap_or(5000))
        .await
        .map_err(|e| GuestAgentError::internal(e.to_string()))?;
    state.sessions.remove(&session_id);
    let ev = AuditEventBuilder::new(kinds::SESSION_EXITED)
        .str_field("account_id", state.config.account_id.to_string())
        .str_field("vm_id", state.config.vm_id.to_string())
        .str_field("session_id", session_id.clone())
        .opt_str("reason", req.reason.clone())
        .build();
    let _ = state.pria.audit(vec![ev]).await;
    Ok(Json(AckResponse {
        session_id,
        ok: true,
    }))
}

#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub session_id: String,
    pub status: String,
    pub pid: u32,
    pub started_at: String,
}

pub async fn status(
    State(state): State<AppState>,
    AxPath(session_id): AxPath<String>,
) -> Result<Json<StatusResponse>, GuestAgentError> {
    let (pid, started_at, st) = state
        .sessions
        .status(&session_id)
        .ok_or_else(|| GuestAgentError::new(ErrorCode::SessionNotFound, "session not found"))?;
    Ok(Json(StatusResponse {
        session_id,
        status: st.as_str().to_string(),
        pid,
        started_at,
    }))
}

/// Helper used by start to validate that a path string is a normal absolute
/// path (re-exported for tests).
pub fn is_abs(p: &Path) -> bool {
    p.is_absolute()
}

/// Create the session working directory and make it private to the launching
/// user + the instance group it inherits (per-instance tenant isolation).
///
///   * `create_dir_all` materializes the per-instance subtree
///     (`instances/<id>/work/<user>`); intermediate dirs inherit the
///     `inst_<id>` group from the setgid parent created at reconcile.
///   * `chown(uid, -1)` gives the user ownership while KEEPING the inherited
///     instance group (gid `-1` = unchanged) so group collaboration still works.
///   * mode `2770` = owner+group rwx, NO "other" access, setgid preserved so
///     new files keep the instance group. A user outside `inst_<id>` is denied.
fn prepare_workspace_dir(dir: &Path, uid: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir).map_err(|e| format!("create_dir_all: {e}"))?;
    // 0o2770 — setgid + rwxrwx--- (owner + instance group only). This is what
    // actually enforces isolation: the dir's group is the inherited `inst_<id>`
    // group, group members get rwx, and there is NO "other" access.
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o2770))
        .map_err(|e| format!("set_permissions: {e}"))?;
    // chown owner → uid (group unchanged: -1, keep the inherited instance gid).
    // Best-effort: a member of the instance group already has rwx via the group
    // bits above, so ownership is a convenience (cleaner `ls`, owner-delete),
    // not the access mechanism. Requires root (prod always is); skipped silently
    // where unprivileged so the access path still works.
    let c_path = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes())
        .map_err(|e| format!("path nul: {e}"))?;
    // SAFETY: valid NUL-terminated path; gid u32::MAX == (gid_t)-1 = unchanged.
    let _ = unsafe { libc::chown(c_path.as_ptr(), uid, u32::MAX) };
    Ok(())
}
