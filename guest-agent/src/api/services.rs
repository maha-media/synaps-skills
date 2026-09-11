//! App-service HTTP handlers (VM-Sites RC, guest transport WP-B/WP-F).
//!
//! Routes (all HMAC-signed, spec §5 — GETs through [`SignedGet`]):
//!
//! | Method | Path | Body → Response |
//! |--------|------|-----------------|
//! | `POST` | `/guest/v1/services/start` | `StartServiceRequest` → [`ServiceSnapshot`] |
//! | `POST` | `/guest/v1/services/{id}/stop` | `{generation}` → [`ServiceSnapshot`] (fenced) |
//! | `GET`  | `/guest/v1/services/{id}/status` | → [`ServiceSnapshot`] |
//! | `GET`  | `/guest/v1/services/{id}/logs?cursor&limit` | → `{entries, next, dropped}` |
//! | `POST` | `/guest/v1/artifacts/seal` | `{workdir, outputDir, maxFiles, maxBytes}` → `{files, totalBytes}` |
//!
//! Wire shape is camelCase (RC plan); errors use the crate's typed
//! `{error:{code,…}}` envelope (`service_not_found`, `service_generation_stale`,
//! `service_busy`, `service_limit_exceeded`, `service_start_failed`,
//! `artifact_bounds_exceeded`, `invalid_request`, `session_not_found`).
//!
//! The guest never decides *authorization* (which project/session may start
//! what) — Pria does that before calling here. The guest enforces the local
//! safety envelope: allowlisted executable, allowlisted env, workdir jailed
//! under the workspace root, loopback-only port, bounded readiness/runtime/log
//! sizes, and — when running as root — the owning session's Linux identity.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use axum::extract::{Path as AxPath, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::api::AppState;
use crate::error::{ErrorCode, GuestAgentError};
use crate::hmac::{SignedGet, SignedJson};
use crate::services::logs::{LogEntry, DEFAULT_PAGE_LIMIT, MAX_LINE_BYTES, MAX_PAGE_LIMIT};
use crate::services::retained::{ArtifactDescriptor, Receipt};
use crate::services::validate::{
    filter_env, validate_command, validate_service_id, validate_workdir,
};
use crate::services::{RunAs, ServiceKind, ServiceSnapshot, StartSpec};

/// Longest accepted readiness path.
const MAX_READINESS_PATH_BYTES: usize = 1024;

// ── POST /services/start ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadinessSpec {
    pub path: String,
    pub timeout_ms: u64,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LimitsSpec {
    #[serde(default)]
    pub max_log_bytes: Option<usize>,
    #[serde(default)]
    pub max_runtime_sec: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartServiceRequest {
    #[serde(default)]
    pub hosting: Option<crate::services::retained::Hosting>,
    #[serde(default)]
    pub generation: Option<u64>,
    pub artifact: Option<ArtifactDescriptor>,
    pub service_id: String,
    pub kind: ServiceKind,
    pub session_id: String,
    pub workdir: PathBuf,
    pub command: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub readiness: ReadinessSpec,
    #[serde(default)]
    pub limits: LimitsSpec,
    #[serde(default)]
    pub request_id: Option<String>,
}

fn validate_session_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("sessionId must be 1..128 chars".into());
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
    {
        return Err("sessionId must match [A-Za-z0-9_.-]+".into());
    }
    Ok(())
}

fn validate_readiness_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("readiness.path must start with '/'".into());
    }
    if path.len() > MAX_READINESS_PATH_BYTES {
        return Err(format!(
            "readiness.path exceeds {MAX_READINESS_PATH_BYTES} bytes"
        ));
    }
    if !path.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err("readiness.path must be visible ASCII without whitespace".into());
    }
    Ok(())
}

pub async fn start(
    State(state): State<AppState>,
    SignedJson { value: req, .. }: SignedJson<StartServiceRequest>,
) -> Result<Json<ServiceSnapshot>, GuestAgentError> {
    let rid = req.request_id.clone();
    let err = |code, msg: String| GuestAgentError::new(code, msg).with_request_id(rid.clone());
    let bad = |msg: String| err(ErrorCode::InvalidRequest, msg);
    let cfg = &state.config.app_services;

    validate_service_id(&req.service_id).map_err(bad)?;
    if req.generation.is_some() && req.generation != Some(1) {
        return Err(bad("new service intent generation must be 1".into()));
    }
    let intent = if req.generation.is_some() {
        if req.request_id.as_deref().unwrap_or("").is_empty() {
            return Err(bad("durable start requires requestId".into()));
        }
        Some(serde_json::to_string(&req).map_err(|_| bad("invalid intent".into()))?)
    } else {
        None
    };
    validate_session_id(&req.session_id).map_err(bad)?;
    validate_readiness_path(&req.readiness.path).map_err(bad)?;
    if req.readiness.timeout_ms == 0 {
        return Err(bad("readiness.timeoutMs must be > 0".into()));
    }

    if req.kind == ServiceKind::Release {
        if req.command != ["static-serve"] {
            return Err(bad("release requires built-in static-serve".into()));
        }
        if state.services.get(&req.service_id).is_some() {
            return Err(bad("service id belongs to dev".into()));
        }
        let descriptor = req
            .artifact
            .ok_or_else(|| bad("release artifact required".into()))?;
        if req
            .hosting
            .as_ref()
            .is_some_and(|h| h.account_id != state.config.account_id.to_string())
        {
            return Err(bad("hosting account mismatch".into()));
        }
        return state
            .services
            .retained
            .start_hosted(&req.service_id, descriptor, req.hosting)
            .map(Json)
            .map_err(bad);
    }
    if req.artifact.is_some() || state.services.retained.status(&req.service_id).is_some() {
        return Err(bad("dev cannot bind a retained release".into()));
    }
    let workdir = owning_workdir(&state, &req.session_id, &req.workdir).map_err(bad)?;

    // Env allowlist, then the effective PATH used for executable resolution.
    let env = filter_env(&req.env).map_err(bad)?;
    let search_path = "/usr/local/bin:/usr/bin:/bin";
    let (executable, args) =
        validate_command(&cfg.command_allowlist, &req.command, search_path, &workdir)
            .map_err(bad)?;

    // Workload identity: the owning session's uid/gid/groups when the agent
    // is root (fail closed: never spawn project code as root).
    let run_as = if state.services.is_root() {
        let (uid, gid, groups) = state.sessions.identity(&req.session_id).ok_or_else(|| {
            err(
                ErrorCode::SessionNotFound,
                "session is not running on this VM; a service needs its workload identity".into(),
            )
        })?;
        if uid == 0 || gid == 0 {
            return Err(bad("refusing to run a service as root".into()));
        }
        Some(RunAs { uid, gid, groups })
    } else {
        None
    };

    let readiness_timeout = Duration::from_millis(
        req.readiness
            .timeout_ms
            .min(cfg.max_readiness_timeout_ms.max(1)),
    );
    let max_runtime = Duration::from_secs(
        req.limits
            .max_runtime_sec
            .unwrap_or(cfg.max_runtime_sec)
            .clamp(1, cfg.max_runtime_sec.max(1)),
    );
    let max_log_bytes = req
        .limits
        .max_log_bytes
        .unwrap_or(cfg.log_ring_max_bytes)
        .clamp(MAX_LINE_BYTES, cfg.log_ring_max_bytes.max(MAX_LINE_BYTES));

    let spec = StartSpec {
        service_id: req.service_id.clone(),
        kind: req.kind,
        session_id: req.session_id.clone(),
        workdir,
        executable,
        args,
        env,
        readiness_path: req.readiness.path.clone(),
        readiness_timeout,
        max_log_bytes,
        max_runtime,
        run_as,
    };
    tracing::info!(
        service_id = %req.service_id,
        session_id = %req.session_id,
        kind = ?req.kind,
        command0 = %req.command[0],
        "app-service start requested"
    );
    let snap = if let Some(intent) = intent {
        state.services.start_durable(spec, &intent).await
    } else {
        state.services.start(spec).await
    }
    .map_err(|e| GuestAgentError::from(e).with_request_id(rid.clone()))?;
    Ok(Json(snap))
}

// ── POST /services/{id}/stop ─────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopServiceRequest {
    pub generation: u64,
    #[serde(default)]
    pub request_id: Option<String>,
}

pub async fn stop(
    State(state): State<AppState>,
    AxPath(service_id): AxPath<String>,
    SignedJson { value: req, .. }: SignedJson<StopServiceRequest>,
) -> Result<Json<ServiceSnapshot>, GuestAgentError> {
    let rid = req.request_id.clone();
    validate_service_id(&service_id)
        .map_err(|m| GuestAgentError::invalid_request(m).with_request_id(rid.clone()))?;
    if state.services.retained.status(&service_id).is_some() {
        return state
            .services
            .retained
            .stop(&service_id, req.generation)
            .map(Json)
            .map_err(GuestAgentError::invalid_request);
    }
    let snap = state
        .services
        .stop(&service_id, req.generation)
        .await
        .map_err(|e| GuestAgentError::from(e).with_request_id(rid.clone()))?;
    Ok(Json(snap))
}

// ── GET /services/{id}/status ────────────────────────────────────────────────

pub async fn status(
    State(state): State<AppState>,
    AxPath(service_id): AxPath<String>,
    _auth: SignedGet,
) -> Result<Json<ServiceSnapshot>, GuestAgentError> {
    validate_service_id(&service_id).map_err(GuestAgentError::invalid_request)?;
    let snap = state
        .services
        .status(&service_id)
        .or_else(|| state.services.retained.status(&service_id))
        .ok_or_else(|| GuestAgentError::new(ErrorCode::ServiceNotFound, "service not found"))?;
    Ok(Json(snap))
}

// ── GET /services/{id}/logs ──────────────────────────────────────────────────

/// Raw query strings so malformed values map to the typed `invalid_request`
/// envelope instead of axum's plain-text rejection.
#[derive(Debug, Default, Deserialize, Serialize)]
pub struct LogsQuery {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LogsResponse {
    pub entries: Vec<LogEntry>,
    /// Opaque resume cursor (echo it back as `?cursor=`).
    pub next: String,
    /// Entries evicted from the guest ring so far (a gap indicator).
    pub dropped: u64,
}

pub async fn logs(
    State(state): State<AppState>,
    AxPath(service_id): AxPath<String>,
    Query(q): Query<LogsQuery>,
    _auth: SignedGet,
) -> Result<Json<LogsResponse>, GuestAgentError> {
    validate_service_id(&service_id).map_err(GuestAgentError::invalid_request)?;
    let cursor =
        match q.cursor.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => Some(raw.parse::<u64>().map_err(|_| {
                GuestAgentError::invalid_request("cursor must be an unsigned integer")
            })?),
        };
    let limit = match q.limit.as_deref().map(str::trim) {
        None | Some("") => DEFAULT_PAGE_LIMIT,
        Some(raw) => raw
            .parse::<usize>()
            .ok()
            .filter(|n| *n >= 1)
            .ok_or_else(|| GuestAgentError::invalid_request("limit must be an integer >= 1"))?,
    };
    let page = state
        .services
        .logs(&service_id, cursor, limit.min(MAX_PAGE_LIMIT))
        .ok_or_else(|| GuestAgentError::new(ErrorCode::ServiceNotFound, "service not found"))?;
    Ok(Json(LogsResponse {
        entries: page.entries,
        next: page.next.to_string(),
        dropped: page.dropped,
    }))
}

// ── POST /artifacts/seal ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SealRequest {
    #[serde(default)]
    pub build_commands: Option<Vec<Vec<String>>>,
    #[serde(default)]
    pub packaging: Option<crate::services::retained::Packaging>,
    pub session_id: String,
    pub revision_id: String,
    pub workdir: PathBuf,
    pub output_dir: PathBuf,
    #[serde(default)]
    pub max_files: Option<usize>,
    #[serde(default)]
    pub max_bytes: Option<u64>,
    #[serde(default)]
    pub request_id: Option<String>,
}

pub async fn seal_artifact(
    State(state): State<AppState>,
    SignedJson { value: req, .. }: SignedJson<SealRequest>,
) -> Result<Json<Receipt>, GuestAgentError> {
    let rid = req.request_id.clone();
    let bad = |msg: String| GuestAgentError::invalid_request(msg).with_request_id(rid.clone());
    let cfg = &state.config.app_services;
    validate_session_id(&req.session_id).map_err(bad)?;
    let workdir = owning_workdir(&state, &req.session_id, &req.workdir).map_err(bad)?;
    if !crate::paths::has_no_traversal(&req.output_dir) {
        return Err(bad("outputDir traversal".into()));
    }
    let output = if req.output_dir.is_absolute() {
        req.output_dir.clone()
    } else {
        workdir.join(&req.output_dir)
    };
    if !output.starts_with(&workdir) {
        return Err(bad("outputDir escapes workdir".into()));
    }
    let max_files = req
        .max_files
        .unwrap_or(cfg.seal_max_files)
        .clamp(1, cfg.seal_max_files.max(1));
    let max_bytes = req
        .max_bytes
        .unwrap_or(cfg.seal_max_bytes)
        .clamp(1, cfg.seal_max_bytes.max(1));
    tracing::info!(
        workdir = %workdir.display(),
        output_dir = %output.display(),
        max_files,
        max_bytes,
        "artifact seal requested"
    );
    if let Some(commands) = &req.build_commands {
        let pack =
            crate::services::skill_pack::verify(cfg.skill_pack_root.as_deref()).map_err(bad)?;
        if req.output_dir != std::path::Path::new("dist") {
            return Err(bad("source profile requires outputDir dist".into()));
        }
        if let Some(receipt) = state
            .services
            .retained
            .source_replay(&req.revision_id, commands, &req.packaging)
            .map_err(bad)?
        {
            let source = receipt
                .source
                .as_ref()
                .ok_or_else(|| bad("source receipt unavailable".into()))?;
            if source.skill_pack.as_ref() != Some(&pack.identity) {
                return Err(bad(
                    "retained skill pack pin differs from installed pack".into()
                ));
            }
            pack.check_source(source).map_err(bad)?;
            return Ok(Json(receipt));
        }
        let dependencies = cfg
            .source_build_dependencies
            .as_ref()
            .ok_or_else(|| bad("source build dependencies not configured".into()))?;
        let identity = if state.services.is_root() {
            let (uid, gid, groups) = state
                .sessions
                .identity(&req.session_id)
                .ok_or_else(|| bad("build identity unavailable".into()))?;
            if uid == 0 || gid == 0 {
                return Err(bad("build identity must be nonroot".into()));
            }
            Some(RunAs { uid, gid, groups })
        } else {
            None
        };
        let build = crate::services::source_build::build_with_pack(
            &workdir,
            dependencies,
            commands,
            identity,
            cfg.source_build_cgroup_root.as_deref(),
            Some(&pack),
        )
        .await
        .map_err(bad)?;
        let result = state
            .services
            .retained
            .seal_with_source(
                &build.output(),
                &req.revision_id,
                max_files,
                max_bytes,
                req.packaging,
                Some(build.source.clone()),
            )
            .map_err(bad)?;
        return Ok(Json(result));
    }
    let services = state.services.clone();
    let manifest = tokio::task::spawn_blocking(move || {
        services.retained.seal_packaged(
            &output,
            &req.revision_id,
            max_files,
            max_bytes,
            req.packaging,
        )
    })
    .await
    .map_err(|_| GuestAgentError::internal("seal task failed"))?
    .map_err(|m| {
        if m == "artifact bounds exceeded" {
            GuestAgentError::new(ErrorCode::ArtifactBoundsExceeded, m)
        } else {
            bad(m)
        }
    })?;
    Ok(Json(manifest))
}

fn owning_workdir(
    state: &AppState,
    session: &str,
    requested: &std::path::Path,
) -> Result<PathBuf, String> {
    let root = match state.sessions.workspace_and_uid(session) {
        Some((root, _)) => root,
        None => {
            // Only the explicit test-fakes build may use a synthetic fixture root.
            #[cfg(feature = "test-fakes")]
            {
                state
                    .config
                    .app_services
                    .workspace_root
                    .clone()
                    .ok_or("owning session workspace unavailable")?
            }
            #[cfg(not(feature = "test-fakes"))]
            {
                return Err("owning session workspace unavailable".into());
            }
        }
    };
    let path = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    validate_workdir(&root, &path)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptRequest {
    #[serde(default)]
    hosting: Option<crate::services::retained::Hosting>,
    #[serde(default)]
    intent_id: Option<String>,
    generation: u64,
    revision_id: String,
    artifact_digest: String,
}
pub async fn adopt(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    SignedJson { value: req, .. }: SignedJson<AdoptRequest>,
) -> Result<Json<ServiceSnapshot>, GuestAgentError> {
    if req
        .hosting
        .as_ref()
        .is_some_and(|h| h.account_id != state.config.account_id.to_string())
    {
        return Err(GuestAgentError::invalid_request("hosting account mismatch"));
    }
    state
        .services
        .retained
        .adopt_hosted(
            &id,
            req.generation,
            &req.revision_id,
            &req.artifact_digest,
            req.hosting,
            req.intent_id,
        )
        .map(Json)
        .map_err(GuestAgentError::invalid_request)
}
