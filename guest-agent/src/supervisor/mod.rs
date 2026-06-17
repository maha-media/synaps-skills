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
use crate::pria_client::{HeartbeatPayload, HeartbeatVnc, VncSessionEntry};
use crate::runtime::FsmonStatus;

/// Build the §7.1 heartbeat payload from current guest-agent state.
///
/// Extends the payload with `vnc.sessions[]` (spec §8.2) when any desktop
/// sessions are active.  The VNC password is forwarded because the Pria control
/// plane needs it for proxy auth (spec §5.1) — it must never appear in logs.
pub fn build_heartbeat(state: &AppState) -> HeartbeatPayload {
    let cfg = &state.config;
    let policy = state.runtime.policy();
    let fsmon_status = state.runtime.fsmon_status();
    let status = match fsmon_status {
        FsmonStatus::Healthy | FsmonStatus::Unavailable => "healthy",
        FsmonStatus::Degraded => "degraded",
    };

    // Build the vnc.sessions[] list (spec §8.2).
    // NOTE: passwords are included in VncSessionEntry — never log this payload.
    let desktop_sessions = state.desktops.list();
    let vnc = if desktop_sessions.is_empty() {
        None
    } else {
        let sessions = desktop_sessions
            .into_iter()
            .map(|ds| VncSessionEntry {
                session_id: ds.session_id,
                linux_username: ds.linux_username,
                display: ds.display,
                port: ds.port,
                basic_user: ds.basic_user,
                password: ds.vnc_password,
            })
            .collect();
        Some(HeartbeatVnc { sessions })
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
        vnc,
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

    #[test]
    fn heartbeat_vnc_none_when_no_desktops() {
        let pria = Arc::new(FakePriaClient::default());
        let state = test_state_with_pria(pria);
        let hb = build_heartbeat(&state);
        assert!(
            hb.vnc.is_none(),
            "no desktop sessions → vnc field must be absent"
        );
    }

    #[tokio::test]
    async fn heartbeat_vnc_sessions_populated_after_desktop_start() {
        use crate::desktop::kasmvnc::{DesktopStore, FakeSystemctl};
        use crate::test_support::test_state_with_pria;
        use std::sync::Arc;

        let pria = Arc::new(FakePriaClient::default());
        let mut state = test_state_with_pria(pria);

        // Replace the desktop store with one backed by a temp dir.
        let root = std::env::temp_dir().join(format!("ga-hb-vnc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Arc::new(DesktopStore::new(
            root.clone(),
            Arc::new(FakeSystemctl::default()),
        ));
        store
            .start(
                "sess_1".into(),
                "pria_u_a".into(),
                "pw_a".into(),
                None,
                Default::default(),
            )
            .await
            .unwrap();
        store
            .start(
                "sess_2".into(),
                "pria_u_b".into(),
                "pw_b".into(),
                None,
                Default::default(),
            )
            .await
            .unwrap();
        state.desktops = store;

        let hb = build_heartbeat(&state);
        let vnc = hb
            .vnc
            .expect("vnc must be present when desktops are active");
        assert_eq!(vnc.sessions.len(), 2);

        // Spec §8.2 fields present.
        for sess in &vnc.sessions {
            assert!(!sess.session_id.is_empty());
            assert!(!sess.linux_username.is_empty());
            assert!(!sess.display.is_empty());
            assert!(sess.port >= 6901);
            assert_eq!(sess.basic_user, "kasm_user");
            // Password must be non-empty (proxy needs it) — but we must not log it.
            assert!(!sess.password.is_empty());
        }

        // Ports and displays must be distinct (multi-user isolation spec §5.2).
        let ports: std::collections::HashSet<u16> = vnc.sessions.iter().map(|s| s.port).collect();
        assert_eq!(ports.len(), 2, "each session must have a distinct port");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn heartbeat_serialises_vnc_field() {
        use crate::pria_client::payloads::{HeartbeatVnc, VncSessionEntry};
        let hb = HeartbeatPayload {
            account_id: "acct_1".into(),
            vm_id: "vm_1".into(),
            replica_id: "r0".into(),
            mode: "local-virsh".into(),
            status: "healthy".into(),
            guest_agent_version: "0.1.0".into(),
            synaps_version: None,
            fsmon_version: None,
            plugin_bundle_version: None,
            active_sessions: 1,
            cpu: None,
            memory: None,
            disk: None,
            policy_hash: None,
            fsmon_status: "healthy".into(),
            timestamp: "2026-06-14T00:00:00Z".into(),
            vnc: Some(HeartbeatVnc {
                sessions: vec![VncSessionEntry {
                    session_id: "sess_a".into(),
                    linux_username: "pria_u_12001".into(),
                    display: ":1".into(),
                    port: 6901,
                    basic_user: "kasm_user".into(),
                    password: "vnc_pw".into(),
                }],
            }),
        };
        let json = serde_json::to_value(&hb).unwrap();
        let sessions = &json["vnc"]["sessions"];
        assert!(sessions.is_array());
        let s = &sessions[0];
        assert_eq!(s["session_id"], "sess_a");
        assert_eq!(s["linux_username"], "pria_u_12001");
        assert_eq!(s["display"], ":1");
        assert_eq!(s["port"], 6901);
        assert_eq!(s["basic_user"], "kasm_user");
        assert_eq!(s["password"], "vnc_pw");
    }

    #[test]
    fn heartbeat_serialises_no_vnc_field_when_none() {
        use crate::pria_client::payloads::HeartbeatPayload;
        let hb = HeartbeatPayload {
            account_id: "a".into(),
            vm_id: "v".into(),
            replica_id: "r".into(),
            mode: "local-virsh".into(),
            status: "healthy".into(),
            guest_agent_version: "0.1.0".into(),
            synaps_version: None,
            fsmon_version: None,
            plugin_bundle_version: None,
            active_sessions: 0,
            cpu: None,
            memory: None,
            disk: None,
            policy_hash: None,
            fsmon_status: "unavailable".into(),
            timestamp: "2026-06-14T00:00:00Z".into(),
            vnc: None,
        };
        let json = serde_json::to_value(&hb).unwrap();
        assert!(
            json.get("vnc").is_none(),
            "vnc key must be absent when None (skip_serializing_if)"
        );
    }
}
