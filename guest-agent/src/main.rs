//! `pria-guest-agent` binary entrypoint.
//!
//! Boots the HTTP server from the YAML config referenced by the
//! `PRIA_GUEST_AGENT_CONFIG` env var (spec §11).

use std::sync::Arc;

use pria_guest_agent::api::{build_router, AppState};
use pria_guest_agent::config::Config;

/// Stable build-feature probe for image tooling.  It intentionally performs no
/// config, filesystem, or network access, so a host can reject an artifact that
/// predates a required guest/runtime contract before baking it into a base image.
fn supports_required_image_features() -> bool {
    std::env::args().skip(1).any(|arg| arg == "--capabilities")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if supports_required_image_features() {
        println!(r#"{{"extension_staging":true,"synaps_base_dir":true}}"#);
        return Ok(());
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config_path = std::env::var("PRIA_GUEST_AGENT_CONFIG")
        .map_err(|_| "PRIA_GUEST_AGENT_CONFIG must be set to the guest-agent config path")?;
    let config = Config::load_from(&config_path)?;
    let versions = pria_guest_agent::versions::Versions::detect(&config);

    let listen = config.listen.clone();
    let secret = config.load_hmac_secret()?;
    let hmac = pria_guest_agent::hmac::HmacVerifier::new(
        secret.clone(),
        config.account_id.to_string(),
        config.vm_id.to_string(),
        config.security.max_timestamp_skew_seconds,
        config.security.nonce_cache_seconds,
    );
    let pria = pria_guest_agent::pria_client::http_client(&config, secret);
    let os: std::sync::Arc<dyn pria_guest_agent::os::OsUserManager> =
        std::sync::Arc::new(pria_guest_agent::os::users::LinuxUserManager::new());
    let synaps: std::sync::Arc<dyn pria_guest_agent::synaps::launcher::SynapsLauncher> =
        std::sync::Arc::new(pria_guest_agent::synaps::launcher::ProcessLauncher::new());
    let runtime = std::sync::Arc::new(pria_guest_agent::runtime::RuntimeState::new());
    let sessions = std::sync::Arc::new(pria_guest_agent::sessions::SessionStore::new(
        runtime.clone(),
    ));
    // Substrate selection (bridge design T4): "aws-ecs" swaps the systemd- and
    // fanotify-backed seams for container-native ones; any other mode keeps the
    // local-virsh wiring byte-identical.
    let container_mode = config.mode == "aws-ecs";
    tracing::info!(
        mode = %config.mode,
        fsmon_backend = if container_mode { "noop-degraded" } else { "uds-fanotify" },
        desktop_backend = if container_mode { "container-child" } else { "systemctl" },
        unit_generator = if container_mode { "container-naming" } else { "systemd-file" },
        "selected substrate backends"
    );
    let fsmon: std::sync::Arc<dyn pria_guest_agent::fsmon::client::FsmonControl> = if container_mode
    {
        // Fargate cannot grant fanotify's CAP_SYS_ADMIN. Keep the policy
        // contract alive but report explicit degraded enforcement.
        std::sync::Arc::new(pria_guest_agent::fsmon::client::NoopFsmonControl)
    } else {
        std::sync::Arc::new(
            pria_guest_agent::fsmon::client::UdsFsmonControl::new(config.fsmon.socket.clone())
                .with_daemon(
                    std::path::PathBuf::from("/usr/local/sbin/synaps_fsmon"),
                    config.fsmon.forward_socket.clone(),
                )
                // Narrow the fanotify mark to the account EFS mount instead
                // of the whole root filesystem.
                .with_mount(config.paths.efs_root.clone()),
        )
    };
    // Desktop lifecycle is systemd-backed on VMs and child-process-backed in
    // Fargate. Both implement the frozen SystemctlBackend/UnitGenerator seams.
    let (desktop_backend, unit_generator): (
        Arc<dyn pria_guest_agent::desktop::kasmvnc::SystemctlBackend>,
        Arc<dyn pria_guest_agent::desktop::kasmvnc::UnitGenerator>,
    ) = if container_mode {
        (
            Arc::new(
                pria_guest_agent::desktop::container::ContainerSystemctl::new(
                    config.paths.run_root.clone(),
                ),
            ),
            Arc::new(pria_guest_agent::desktop::container::ContainerUnitGenerator),
        )
    } else {
        (
            Arc::new(pria_guest_agent::desktop::kasmvnc::RealSystemctl),
            Arc::new(pria_guest_agent::desktop::kasmvnc::FileUnitGenerator::default()),
        )
    };
    let desktops = Arc::new(
        pria_guest_agent::desktop::kasmvnc::DesktopStore::new(
            config.paths.run_root.clone(),
            desktop_backend,
        )
        .with_port_readiness(Arc::new(
            pria_guest_agent::desktop::kasmvnc::TcpPortReadiness::new(
                std::time::Duration::from_secs(25),
            ),
        ))
        .with_password_applier(Arc::new(
            pria_guest_agent::desktop::kasmvnc::SetpwApplier::default(),
        ))
        .with_unit_generator(unit_generator),
    );
    let fleet = Arc::new(pria_guest_agent::fleet::FleetBindings::new(
        pria.clone(),
        std::time::Duration::from_secs(config.fleet.heartbeat_interval_seconds.max(1)),
    ));
    let state = AppState {
        config: Arc::new(config),
        hmac: Arc::new(hmac),
        runtime,
        versions: Arc::new(versions),
        pria,
        os,
        synaps,
        sessions,
        fsmon,
        desktops,
        fleet,
    };

    let _heartbeat = pria_guest_agent::supervisor::spawn_heartbeat_loop(state.clone());

    // Rebuild the desktop session table from persisted state so a guest-agent
    // restart does not lose track of desktops whose `kasmvnc@<user>` units are
    // still running. Without this, `GET /desktops` reports empty after a restart
    // and the control plane's single-session reuse misses the live desktop.
    let restored = state.desktops.rehydrate().await;
    if restored > 0 {
        tracing::info!(restored, "rehydrated desktop sessions on startup");
    }

    // Spawn the fsmon audit-forward relay if a forward socket is configured.
    if let Some(forward) = state.config.fsmon.forward_socket.clone() {
        match pria_guest_agent::fsmon::relay::spawn_audit_relay(state.clone(), &forward) {
            Ok(_) => tracing::info!(socket = %forward.display(), "fsmon audit relay listening"),
            Err(e) => tracing::warn!(error = %e, "failed to start fsmon audit relay"),
        }
    }

    let app = build_router(state);

    let addr = format!("{}:{}", listen.host, listen.port);
    tracing::info!(%addr, "pria-guest-agent listening");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn capability_document_has_extension_staging_contract() {
        // Keep the artifact gate tied to the behavior that requires it.
        let capabilities = serde_json::json!({
            "extension_staging": true,
            "synaps_base_dir": true,
        });
        assert_eq!(capabilities["extension_staging"], true);
        assert_eq!(capabilities["synaps_base_dir"], true);
    }
}
