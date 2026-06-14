//! Background supervisor loops (spec §7.1, §17, HS-3 mitigation).
//!
//! The guest agent emits the rich heartbeat itself (HS-3: SynapsCLI's native
//! watcher heartbeat is hardcoded to `{session_count, pid}` and cannot be
//! enriched without a core change). This loop builds the §7.1 payload from the
//! guest agent's own state and signs+POSTs it on the configured interval.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;

use crate::api::AppState;
use crate::pria_client::HeartbeatPayload;
use crate::runtime::FsmonStatus;

/// Build the §7.1 heartbeat payload from current guest-agent state.
pub fn build_heartbeat(state: &AppState) -> HeartbeatPayload {
    let cfg = &state.config;
    let policy = state.runtime.policy();
    let fsmon_status = state.runtime.fsmon_status();
    let status = match fsmon_status {
        FsmonStatus::Healthy | FsmonStatus::Unavailable => "healthy",
        FsmonStatus::Degraded => "degraded",
    };
    HeartbeatPayload {
        account_id: cfg.account_id.to_string(),
        vm_id: cfg.vm_id.to_string(),
        replica_id: cfg.replica_id.clone(),
        mode: cfg.mode.clone(),
        status: status.to_string(),
        guest_agent_version: state.versions.guest_agent_version.clone(),
        synaps_version: state.versions.synaps_version.clone(),
        fsmon_version: state.versions.fsmon_version.clone(),
        plugin_bundle_version: state.versions.plugin_bundle_version.clone(),
        active_sessions: state.runtime.active_sessions(),
        cpu: None,
        memory: None,
        disk: None,
        policy_hash: policy.policy_hash,
        fsmon_status: fsmon_status.as_str().to_string(),
        timestamp: Utc::now().to_rfc3339(),
    }
}

/// Spawn the periodic heartbeat task. Returns the join handle so the caller can
/// abort it on shutdown.
pub fn spawn_heartbeat_loop(state: AppState) -> tokio::task::JoinHandle<()> {
    let interval = state.config.heartbeat.interval_seconds.max(1);
    tokio::spawn(async move {
        let state = Arc::new(state);
        let mut ticker = tokio::time::interval(Duration::from_secs(interval));
        loop {
            ticker.tick().await;
            let payload = build_heartbeat(&state);
            if let Err(e) = state.pria.heartbeat(&payload).await {
                tracing::warn!(error = %e, "heartbeat callback failed");
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pria_client::fake::FakePriaClient;
    use crate::test_support::test_state_with_pria;

    #[test]
    fn heartbeat_payload_reflects_runtime() {
        let pria = Arc::new(FakePriaClient::default());
        let state = test_state_with_pria(pria);
        state.runtime.incr_sessions();
        state.runtime.set_fsmon_status(FsmonStatus::Healthy);
        let hb = build_heartbeat(&state);
        assert_eq!(hb.account_id, "acct_123");
        assert_eq!(hb.active_sessions, 1);
        assert_eq!(hb.fsmon_status, "healthy");
        assert_eq!(hb.status, "healthy");
    }
}
