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
    pub capabilities: serde_json::Value,
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
    let pack = crate::services::skill_pack::verify(cfg.app_services.skill_pack_root.as_deref())
        .ok()
        .map(|p| p.identity);
    let overall = match state.runtime.fsmon_status() {
        FsmonStatus::Healthy | FsmonStatus::Degraded => "healthy",
        FsmonStatus::Unavailable => "healthy", // agent is up even if fsmon is not
    };
    Json(HealthResponse {
        capabilities: serde_json::json!({
            "skillPack": pack,
            "sourceBuildV1": pack.is_some()
                && cfg.app_services.source_build_dependencies.as_ref().is_some_and(|p| crate::services::dependency_bundle::verify(p).is_ok())
                && cfg.app_services.source_build_cgroup_root.as_ref().is_some_and(|p| crate::services::build_cgroup::BuildCgroup::create(p).is_ok())
                && std::path::Path::new("/usr/bin/bwrap").is_file(),
            "workloadIsolationV1": false,
            "retainedArtifactsV1": state.services.retained.prepare().is_ok(),
            "serviceProxyV1": true,
            "relativeReactV1": true,
            "releaseAdoptionV1": true,
            "finiteHostingV1": true,
            "hostingAccounting": "node-authoritative-credits",
            "stableServiceIntentV1": state.services.retained.prepare().is_ok()
        }),
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

/// Exact descriptor proof for callers which cannot wait for signed heartbeat.
/// Same VM-SITES/1 nonce/status/body proof as service proxy; fixed identity.
pub async fn skill_pack(
    State(state): State<AppState>,
    req: axum::extract::Request,
) -> Result<axum::response::Response, crate::error::GuestAgentError> {
    use crate::error::GuestAgentError;
    let uri = req.uri().clone();
    let headers = req.headers().clone();
    let method = req.method().clone();
    let body = axum::body::to_bytes(req.into_body(), 1024)
        .await
        .map_err(|_| GuestAgentError::invalid_request("pack request body bound"))?;
    state.hmac.verify(
        method.as_str(),
        uri.path(),
        uri.query().unwrap_or(""),
        &headers,
        &body,
    )?;
    if !body.is_empty() || method != axum::http::Method::GET || uri.query().is_some() {
        return Err(GuestAgentError::invalid_request(
            "pack query must be bodyless GET without query",
        ));
    }
    let nonce = headers
        .get("x-pria-nonce")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| GuestAgentError::invalid_request("missing nonce"))?;
    let (status, value) = match crate::services::skill_pack::verify(
        state.config.app_services.skill_pack_root.as_deref(),
    ) {
        Ok(pack) => (
            200,
            serde_json::json!({"accountId":state.config.account_id.to_string(),"vmId":state.config.vm_id.to_string(),"pack":pack.identity}),
        ),
        Err(_) => (
            503,
            serde_json::json!({"error":"trusted skill pack unavailable"}),
        ),
    };
    let bytes =
        serde_json::to_vec(&value).map_err(|_| GuestAgentError::internal("pack response"))?;
    let proof = state
        .hmac
        .service_proof(nonce, "app_builder_pack", 1, status, &bytes);
    axum::response::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .header("x-pria-service-proof", proof)
        .body(axum::body::Body::from(bytes))
        .map_err(|_| GuestAgentError::internal("pack response"))
}
