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
use crate::synaps::launcher::{relay_agent_end_usage, RpcReadyReceipt, UsageIdentity};
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
pub struct ExtensionRef {
    pub name: String,
    #[serde(default)]
    pub source: Option<String>,
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
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub extensions: Vec<ExtensionRef>,
}

#[derive(Debug, Serialize)]
pub struct StartSessionResponse {
    pub request_id: Option<String>,
    pub session_id: String,
    pub status: String,
    pub pid: u32,
    pub context_path: String,
    pub started_at: String,
    /// Synaps emitted a validated RPC-ready frame before this response.
    pub ready: bool,
    /// UTC receipt time assigned by the guest after it validated Synaps RPC Ready.
    pub ready_at: String,
    pub ready_model: String,
    pub ready_protocol_version: u32,
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

    // Create the session directory (spec §6.4 step 2). Same treatment as the
    // workspace dir: uid-owned, 2770 (inherited inst_<id> group), and a
    // traverse-only (0711) `sessions/` intermediate — the hardened umask would
    // otherwise leave both 0700 root and the session user locked out.
    if let Err(e) = prepare_workspace_dir(&req.session_dir, req.uid) {
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
    // Build args: base is always `rpc`; add `--system <file>` when a non-empty
    // system prompt is provided (spec §Q1 — agent-runtime resolves file paths).
    let mut args = vec!["rpc".to_string()];
    if let Some(ref prompt) = req.system_prompt {
        if !prompt.trim().is_empty() {
            let prompt_path = crate::synaps::system_prompt::write_system_prompt(
                prompt,
                &req.session_dir,
                req.uid,
            )
            .map_err(|e| e.with_request_id(rid.clone()))?;
            args.push("--system".into());
            args.push(prompt_path.display().to_string());
        }
    }

    // Build env. Persistent configuration/plugin discovery stays at SYNAPS_BASE_DIR,
    // but Unix RPC sockets cannot live under the long EFS session path: Linux
    // sockaddr_un.sun_path is limited to 108 bytes. Give the runtime a short,
    // per-UID 0700 directory instead.
    let mut env = req.environment.clone();
    let runtime_dir = prepare_synaps_runtime_dir(req.uid)
        .map_err(|e| GuestAgentError::internal(e).with_request_id(rid.clone()))?;
    env.insert(
        "SYNAPS_RUNTIME_DIR".into(),
        runtime_dir.display().to_string(),
    );
    let staged_base: Option<PathBuf> = if !req.extensions.is_empty() {
        let plugin_store = state.config.synaps.plugin_dir.as_deref().ok_or_else(|| {
            GuestAgentError::new(
                ErrorCode::InvalidRequest,
                "extensions requested but synaps.plugin_dir is not configured",
            )
            .with_request_id(rid.clone())
        })?;
        let base = crate::synaps::plugin_stage::stage_extensions(
            &req.extensions,
            &req.session_dir,
            plugin_store,
            req.uid,
        )
        .map_err(|e| e.with_request_id(rid.clone()))?;
        env.insert("SYNAPS_BASE_DIR".into(), base.display().to_string());
        Some(base)
    } else {
        None
    };

    // Re-write the context with the optional base-dir mirror so the
    // pria-session-context plugin can find it via its third lookup path
    // ($SYNAPS_BASE_DIR/sessions/<id>/context.json).
    let written = write_context(
        &ctx,
        state.config.paths.run_root.as_path(),
        staged_base.as_deref(),
    )
    .map_err(|e| e.with_request_id(rid.clone()))?;
    let context_path = written.path.to_string_lossy().to_string();

    // chown the synaps-base session-state tree to the session uid. write_context
    // (running as root) creates <base>/sessions/<id>/context.json owned by root,
    // but synaps runs dropped to `req.uid` and must persist turn state there —
    // without this the runtime crashes with "failed to save session: Permission
    // denied". Mirrors the inbox/run chown in plugin staging. plugins/ stays
    // root-owned (read-only staged) on purpose.
    //
    // The synaps-base DIR ITSELF must also be uid-owned (non-recursive — plugins/
    // stays root): SYNAPS_BASE_DIR is synaps's active config dir and its rolling
    // file appender creates synaps.log.<date> directly inside it at startup.
    // Root-owned base ⇒ PermissionDenied ⇒ tracing-appender panic ⇒ the synaps
    // process aborts within the 500ms smoke-check window (#212) and the session
    // start 500s.
    if let Some(bd) = staged_base.as_deref() {
        chown_dir_to_uid(bd, req.uid);
        chown_tree_to_uid(&bd.join("sessions"), req.uid);
    }

    // Launch synaps dropped to uid/gid (spec §6.4 step 4, §16.3).
    let spec = LaunchSpec {
        binary: state.config.synaps.binary.clone(),
        args,
        uid: req.uid,
        gid: req.gid,
        groups,
        cwd: Some(req.workspace_dir.clone()),
        env,
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
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<RpcReadyReceipt>();
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
        tokio::spawn(relay_agent_end_usage(
            stdout,
            identity,
            pria,
            Some(ready_tx),
        ));
    } else {
        // We launched a child but cannot observe its readiness handshake. Kill
        // it rather than leaking an unsupervised synaps process: every other
        // failure path below reaps the child, and this one must not be the
        // exception that leaves an orphan holding the session's uid.
        let _ = process.close(0).await;
        return Err(GuestAgentError::new(
            ErrorCode::SynapsLaunchFailed,
            "synaps stdout unavailable; cannot verify RPC readiness",
        )
        .with_request_id(rid));
    }

    // #212 smoke-check: if synaps rpc crashes on startup (bad env, missing HOME,
    // permission crash, etc), catch it here as a LOUD failure instead of returning
    // 200 to a caller who then discovers the corpse via a mislabeled 404 on /send.
    // 500ms is enough for the runtime to init logging + fail on config issues but
    // short enough not to add noticeable latency.
    //
    // Clone the Arc before the timeout so `process` is still available to move
    // into SessionEntry afterwards (same pattern Case used for reaper_proc).
    let smoke_proc = process.clone();
    let smoke = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        smoke_proc.wait_for_exit(),
    )
    .await;
    if smoke.is_ok() {
        // Process exited within 500ms — it was DOA. Report loud.
        tracing::error!(
            session_id = %req.session_id,
            pid,
            "smoke-check: synaps rpc exited within 500ms of spawn — check spec.env and HOME",
        );
        return Err(GuestAgentError::new(
            ErrorCode::SynapsLaunchFailed,
            "synaps rpc exited within 500ms of spawn — check spec.env and HOME",
        )
        .with_request_id(rid));
    }
    // Timeout elapsed → child survived. Now require the runtime's own
    // protocol-level ready handshake. This makes `/sessions/start` truthful for
    // all presets: a live PID alone never proves Synaps can accept a prompt.
    let ready = match tokio::time::timeout(std::time::Duration::from_secs(15), ready_rx).await {
        Ok(Ok(receipt)) => receipt,
        Ok(Err(_)) => {
            let _ = process.close(0).await;
            return Err(GuestAgentError::new(
                ErrorCode::SynapsLaunchFailed,
                "synaps exited before emitting its RPC ready frame",
            )
            .with_request_id(rid));
        }
        Err(_) => {
            let _ = process.close(0).await;
            return Err(GuestAgentError::new(
                ErrorCode::SynapsLaunchFailed,
                "synaps did not emit its RPC ready frame before startup timeout",
            )
            .with_request_id(rid));
        }
    };

    // Clone the process Arc BEFORE moving it into SessionEntry so the reaper
    // task can await process exit without holding the session table lock.
    let reaper_proc = process.clone();
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

    // Zombie reaper: background task that awaits natural child exit and
    // removes the session from the store so status/send return 404 (not lies).
    // Keeps launcher pure — session lifecycle is owned here, not in the launcher.
    {
        let sessions = state.sessions.clone();
        let sid = req.session_id.clone();
        tokio::spawn(async move {
            reaper_proc.wait_for_exit().await;
            // Only remove if still present — explicit close/cancel may have
            // already removed it, and remove() is idempotent on absent keys.
            sessions.remove(&sid);
            tracing::info!(session_id = %sid, "reaper: session removed after child exit");
        });
    }

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

    let ready_at = chrono::Utc::now().to_rfc3339();
    Ok(Json(StartSessionResponse {
        request_id: req.request_id,
        session_id: req.session_id,
        status: "ready".to_string(),
        pid,
        context_path,
        started_at: created,
        ready: true,
        ready_at,
        ready_model: ready.model,
        ready_protocol_version: ready.protocol_version,
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
    // The runtime umask is hardened (077), so intermediate dirs materialized by
    // `create_dir_all` above (e.g. `instances/<id>/work`) come out with NO
    // group/other access — and they inherit setgid + the inst_<id> group from
    // the 2770 instance root, so mode ends up 2700 root:inst_gid: untraversable
    // by the session user even though the leaf below is fixed up. Normalize by
    // ADDING the two execute (traverse) bits when both are absent — a minimal,
    // idempotent delta that never downgrades an already-traversable dir (the
    // deliberate 2770 instance-root gate has group rwx and is left untouched),
    // preserves setgid, and still denies listing/reads to non-members.
    if let Some(parent) = dir.parent() {
        if let Ok(meta) = std::fs::metadata(parent) {
            let mode = meta.permissions().mode();
            if mode & 0o0011 == 0 {
                std::fs::set_permissions(
                    parent,
                    std::fs::Permissions::from_mode((mode & 0o7777) | 0o0011),
                )
                .map_err(|e| format!("set_permissions parent: {e}"))?;
            }
        }
    }
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

/// Create the short, per-UID socket root used by Synaps RPC.
///
/// This intentionally is not under EFS or SYNAPS_BASE_DIR: socket paths have a
/// kernel-imposed 108-byte limit. `/run/user/<uid>` is tmpfs-backed and both it
/// and its `synaps` child are private to the launching principal.
fn prepare_synaps_runtime_dir(uid: u32) -> Result<PathBuf, String> {
    prepare_synaps_runtime_dir_at(Path::new("/run/user"), uid)
}

/// Prepare a private Synaps runtime directory below `runtime_root`.
///
/// Kept separate from [`prepare_synaps_runtime_dir`] so the ownership and
/// traversal invariant can be regression-tested in a temporary directory rather
/// than mutating the host's `/run/user` during tests.
fn prepare_synaps_runtime_dir_at(runtime_root: &Path, uid: u32) -> Result<PathBuf, String> {
    use std::io::ErrorKind;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    fn ensure_real_dir(path: &Path, label: &str) -> Result<(), String> {
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|e| format!("stat {label} {}: {e}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!("unsafe {label} {}", path.display()));
        }
        Ok(())
    }

    fn create_dir_if_missing(path: &Path, label: &str) -> Result<(), String> {
        match std::fs::create_dir(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(()),
            Err(e) => Err(format!("create {label} {}: {e}", path.display())),
        }
    }

    // `/run` is root-controlled in production. Do not follow a pre-existing
    // symlink for either user-controlled component before chowning it.
    create_dir_if_missing(runtime_root, "runtime root")?;
    ensure_real_dir(runtime_root, "runtime root")?;
    std::fs::set_permissions(runtime_root, std::fs::Permissions::from_mode(0o711))
        .map_err(|e| format!("chmod runtime root {}: {e}", runtime_root.display()))?;

    let user_dir = runtime_root.join(uid.to_string());
    create_dir_if_missing(&user_dir, "user runtime dir")?;
    ensure_real_dir(&user_dir, "user runtime dir")?;
    chown_private_dir(&user_dir, uid, "user runtime dir")?;
    std::fs::set_permissions(&user_dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("chmod user runtime dir {}: {e}", user_dir.display()))?;

    let dir = user_dir.join("synaps");
    create_dir_if_missing(&dir, "synaps runtime dir")?;
    ensure_real_dir(&dir, "synaps runtime dir")?;
    chown_private_dir(&dir, uid, "synaps runtime dir")?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("chmod synaps runtime dir {}: {e}", dir.display()))?;

    // Re-read after mutation: callers rely on both components being directly
    // traversable by the dropped-privilege Synaps process.
    for (path, label) in [
        (&user_dir, "user runtime dir"),
        (&dir, "synaps runtime dir"),
    ] {
        ensure_real_dir(path, label)?;
        let metadata =
            std::fs::metadata(path).map_err(|e| format!("stat {label} {}: {e}", path.display()))?;
        if metadata.uid() != uid || metadata.mode() & 0o7777 != 0o700 {
            return Err(format!(
                "{label} {} did not retain uid {uid} and mode 0700",
                path.display()
            ));
        }
    }
    Ok(dir)
}

fn chown_private_dir(path: &Path, uid: u32, label: &str) -> Result<(), String> {
    let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|e| format!("{label} path NUL: {e}"))?;
    // SAFETY: valid NUL-terminated path; gid u32::MAX == (gid_t)-1 = unchanged.
    if unsafe { libc::chown(c_path.as_ptr(), uid, u32::MAX) } != 0 {
        return Err(format!(
            "chown {label} {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod runtime_dir_tests {
    use super::prepare_synaps_runtime_dir_at;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::process::CommandExt;

    #[test]
    fn runtime_parent_and_child_are_owned_private_and_traversable_by_launch_uid() {
        let current_uid = unsafe { libc::geteuid() };
        // When tests are root, deliberately drop the probe to nobody. This
        // reproduces the production failure mode: root creates the directory,
        // then Synaps starts as another principal. Otherwise, use the test user.
        let launch_uid = if current_uid == 0 {
            65_534
        } else {
            current_uid
        };
        let root = std::env::temp_dir().join(format!(
            "pria-guest-agent-runtime-dir-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();

        let child = prepare_synaps_runtime_dir_at(&root, launch_uid).unwrap();
        let parent = child.parent().unwrap();
        for path in [parent, child.as_path()] {
            let metadata = std::fs::metadata(path).unwrap();
            assert_eq!(metadata.uid(), launch_uid, "{} owner", path.display());
            assert_eq!(metadata.mode() & 0o7777, 0o700, "{} mode", path.display());
        }

        // This is the regression probe: a process with the launch UID must be
        // able to traverse the parent and create runtime state in the child.
        // The former implementation left `parent` root:0700, causing exactly
        // this operation to fail before Synaps could initialize its RPC server.
        let probe = child.join("dropped-privilege-probe");
        let status = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("test -x \"$1\" && : > \"$1/dropped-privilege-probe\"")
            .arg("sh")
            .arg(&child)
            .gid(launch_uid)
            .uid(launch_uid)
            .status()
            .unwrap();
        assert!(
            status.success(),
            "launch UID could not use {}",
            child.display()
        );
        assert!(probe.is_file(), "launch UID did not create runtime state");

        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Best-effort non-recursive chown of a single directory to `uid`, gid
/// unchanged. Used for the synaps-base dir itself: synaps's rolling log
/// appender writes synaps.log.<date> directly into its active config dir
/// (SYNAPS_BASE_DIR), so the dropped-privilege process needs to own the dir —
/// but its children (plugins/) must stay root-owned read-only staging.
fn chown_dir_to_uid(dir: &Path, uid: u32) {
    if let Ok(c_path) = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes()) {
        // SAFETY: valid NUL-terminated path; gid u32::MAX == (gid_t)-1 = unchanged.
        let _ = unsafe { libc::chown(c_path.as_ptr(), uid, u32::MAX) };
    }
}

/// Best-effort recursive chown of `root` (dirs + files) to `uid`, gid unchanged.
/// Used for the synaps-base/sessions state tree that write_context creates as
/// root but the dropped-privilege synaps process must write to.
fn chown_tree_to_uid(root: &Path, uid: u32) {
    fn chown_one(p: &Path, uid: u32) {
        if let Ok(c_path) = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()) {
            // SAFETY: valid NUL-terminated path; gid u32::MAX == (gid_t)-1 = unchanged.
            let _ = unsafe { libc::chown(c_path.as_ptr(), uid, u32::MAX) };
        }
    }
    chown_one(root, uid);
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            chown_tree_to_uid(&p, uid);
        } else {
            chown_one(&p, uid);
        }
    }
}
