//! Desktop lifecycle HTTP handlers (spec §5.4, §8.2).
//!
//! Routes:
//!
//! | Method | Path | Spec |
//! |--------|------|------|
//! | `POST` | `/guest/v1/desktops/start` | §5.4 steps 1–5 |
//! | `POST` | `/guest/v1/desktops/:linux_username/stop` | §5.4 step 6 |
//! | `GET`  | `/guest/v1/desktops` | §8.2 snapshot |
//!
//! All mutating endpoints are HMAC-signed (spec §5).  The list endpoint is
//! intentionally unsigned (internal health use), consistent with `GET /health`.
//!
//! ## Security
//! * `vnc_password` is never logged — it appears only in the JSON response body
//!   (sent to the Pria control plane over TLS) and in the persisted env file.
//! * The response body includes `password` because the Pria VNC proxy needs it
//!   for `Basic kasm_user:<password>` (spec §5.1 controller contract).  The
//!   Pria backend must treat this field as a credential and store it encrypted.

use axum::extract::{Path as AxPath, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::api::AppState;
use crate::desktop::kasmvnc::DesktopSessionInfo;
use crate::error::{ErrorCode, GuestAgentError};
use crate::hmac::SignedJson;

// ── POST /desktops/start ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct StartDesktopRequest {
    /// Pria session identifier, used as `session_id` in the desktop record.
    pub session_id: String,
    /// Linux principal under which the KasmVNC process runs.
    pub linux_username: String,
    /// VNC transport password for the `kasm_user` Basic auth (spec §5.3).
    /// Provided by the Pria control plane; **never logged**.
    pub vnc_password: String,
    /// Optional geometry override (default `1280x800`).
    #[serde(default)]
    pub geometry: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StartDesktopResponse {
    pub request_id: Option<String>,
    pub session_id: String,
    pub linux_username: String,
    pub display: String,
    pub port: u16,
    pub basic_user: String,
    /// VNC password — included for the Pria VNC proxy (spec §5.1).
    /// The caller (Pria backend) must treat this as a credential.
    pub password: String,
    pub started_at: String,
    pub status: &'static str,
}

pub async fn start_desktop(
    State(state): State<AppState>,
    SignedJson { value: req, .. }: SignedJson<StartDesktopRequest>,
) -> Result<Json<StartDesktopResponse>, GuestAgentError> {
    let rid = req.request_id.clone();
    let err = |code, msg: &str| GuestAgentError::new(code, msg).with_request_id(rid.clone());

    // Validate the principal exists and is active before starting a desktop.
    let record = state
        .os
        .lookup(&req.linux_username)
        .await
        .map_err(|e| GuestAgentError::internal(e.to_string()).with_request_id(rid.clone()))?
        .ok_or_else(|| err(ErrorCode::PrincipalNotFound, "principal not found"))?;
    if !record.active {
        return Err(err(
            ErrorCode::PrincipalDisabled,
            "principal is disabled and cannot start a desktop session",
        ));
    }

    // Validate password non-empty (we must never pass an empty credential).
    if req.vnc_password.is_empty() {
        return Err(err(
            ErrorCode::InvalidRequest,
            "vnc_password must not be empty",
        ));
    }

    let ds = state
        .desktops
        .start(
            req.session_id.clone(),
            req.linux_username.clone(),
            req.vnc_password.clone(),
            req.geometry.clone(),
        )
        .await
        .map_err(|e| {
            GuestAgentError::new(ErrorCode::InternalError, e).with_request_id(rid.clone())
        })?;

    // Emit desktop.started audit (extends audit kinds for desktop lifecycle).
    // NOTE: password is deliberately excluded from the audit record.
    let ev = crate::pria_client::AuditEventBuilder::new("desktop.started")
        .str_field("account_id", state.config.account_id.to_string())
        .str_field("vm_id", state.config.vm_id.to_string())
        .str_field("session_id", ds.session_id.clone())
        .str_field("linux_username", ds.linux_username.clone())
        .str_field("display", ds.display.clone())
        .str_field("port", ds.port.to_string())
        .build();
    let _ = state.pria.audit(vec![ev]).await;

    Ok(Json(StartDesktopResponse {
        request_id: req.request_id,
        session_id: ds.session_id,
        linux_username: ds.linux_username,
        display: ds.display,
        port: ds.port,
        basic_user: ds.basic_user,
        password: ds.vnc_password,
        started_at: ds.started_at,
        status: "running",
    }))
}

// ── POST /desktops/:linux_username/stop ──────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct StopDesktopRequest {
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StopDesktopResponse {
    pub request_id: Option<String>,
    pub linux_username: String,
    pub status: &'static str,
}

pub async fn stop_desktop(
    State(state): State<AppState>,
    AxPath(linux_username): AxPath<String>,
    SignedJson { value: req, .. }: SignedJson<StopDesktopRequest>,
) -> Result<Json<StopDesktopResponse>, GuestAgentError> {
    let rid = req.request_id.clone();

    state.desktops.stop(&linux_username).await.map_err(|e| {
        GuestAgentError::new(ErrorCode::InternalError, e).with_request_id(rid.clone())
    })?;

    let ev = crate::pria_client::AuditEventBuilder::new("desktop.stopped")
        .str_field("account_id", state.config.account_id.to_string())
        .str_field("vm_id", state.config.vm_id.to_string())
        .str_field("linux_username", linux_username.clone())
        .opt_str("reason", req.reason.clone())
        .build();
    let _ = state.pria.audit(vec![ev]).await;

    Ok(Json(StopDesktopResponse {
        request_id: req.request_id,
        linux_username,
        status: "stopped",
    }))
}

// ── GET /desktops ────────────────────────────────────────────────────────────

/// Response shape for the list endpoint (spec §8.2 `vnc.sessions[]`).
#[derive(Debug, Serialize)]
pub struct ListDesktopsResponse {
    pub sessions: Vec<DesktopSessionInfo>,
}

pub async fn list_desktops(State(state): State<AppState>) -> Json<ListDesktopsResponse> {
    let sessions = state
        .desktops
        .list()
        .into_iter()
        .map(|ds| ds.to_info())
        .collect();
    Json(ListDesktopsResponse { sessions })
}
