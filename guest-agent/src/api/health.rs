//! `GET /guest/v1/health` (spec §6.1).
//!
//! Health is an unauthenticated liveness/status endpoint (no sensitive mutation,
//! used by substrate health checks and Pattern-A discovery). The rich,
//! account/vm-bound state is also pushed via the signed heartbeat callback
//! (GA-B4 / spec §7.1).

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::api::AppState;
use crate::runtime::FsmonStatus;

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub account_id: String,
    pub vm_id: String,
    pub replica_id: String,
    pub mode: String,
    pub guest_agent_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synaps_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fsmon_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_bundle_version: Option<String>,
    pub active_sessions: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_hash: Option<String>,
    pub fsmon_status: &'static str,
    pub uptime_seconds: u64,
}

pub async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let cfg = &state.config;
    let policy = state.runtime.policy();
    let overall = match state.runtime.fsmon_status() {
        FsmonStatus::Healthy | FsmonStatus::Degraded => "healthy",
        FsmonStatus::Unavailable => "healthy", // agent is up even if fsmon is not
    };
    Json(HealthResponse {
        status: overall,
        account_id: cfg.account_id.to_string(),
        vm_id: cfg.vm_id.to_string(),
        replica_id: cfg.replica_id.clone(),
        mode: cfg.mode.clone(),
        guest_agent_version: state.versions.guest_agent_version.clone(),
        synaps_version: state.versions.synaps_version.clone(),
        fsmon_version: state.versions.fsmon_version.clone(),
        plugin_bundle_version: state.versions.plugin_bundle_version.clone(),
        active_sessions: state.runtime.active_sessions(),
        policy_profile_id: policy.policy_profile_id,
        policy_version: policy.policy_version,
        policy_hash: policy.policy_hash,
        fsmon_status: state.runtime.fsmon_status().as_str(),
        uptime_seconds: state.runtime.uptime_seconds(),
    })
}
