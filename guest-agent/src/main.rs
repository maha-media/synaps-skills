//! `pria-guest-agent` binary entrypoint.
//!
//! Boots the HTTP server from the YAML config referenced by the
//! `PRIA_GUEST_AGENT_CONFIG` env var (spec §11).

use std::sync::Arc;

use pria_guest_agent::api::{build_router, AppState};
use pria_guest_agent::config::Config;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
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
    let fsmon: std::sync::Arc<dyn pria_guest_agent::fsmon::client::FsmonControl> =
        std::sync::Arc::new(
            pria_guest_agent::fsmon::client::UdsFsmonControl::new(config.fsmon.socket.clone())
                .with_daemon(
                    std::path::PathBuf::from("/usr/local/sbin/synaps_fsmon"),
                    config.fsmon.forward_socket.clone(),
                )
                // Narrow the fanotify mark to the account EFS mount instead of the
                // whole `/`: only opens on the account data subtree generate a
                // synchronous FAN_OPEN_PERM round-trip, so a busy root filesystem
                // never floods the permission loop into fd-exhaustion. This is
                // also a complete envelope: the data needing containment (instance
                // workspaces, session dirs, immutable prefixes) is EFS-rooted, so
                // it sits under this mount. Per-user homes (`/home/<user>`) hold
                // only ephemeral, legitimately-writable runtime config
                // (`~/.synaps-cli`, `~/.vnc`) and are isolated by Unix DAC (distinct
                // uid + 0700), not fanotify. System-path tamper protection (`/etc`,
                // `/srv/synaps`) is handled out-of-band (chattr +i / read-only
                // binds), not by a whole-`/` permission mark.
                .with_mount(config.paths.efs_root.clone()),
        );
    // Desktop store uses run_root for persisted allocations + env files.
    let desktops = Arc::new(
        pria_guest_agent::desktop::kasmvnc::DesktopStore::new(
            config.paths.run_root.clone(),
            Arc::new(pria_guest_agent::desktop::kasmvnc::RealSystemctl),
        )
        .with_port_readiness(Arc::new(
            pria_guest_agent::desktop::kasmvnc::TcpPortReadiness::new(
                std::time::Duration::from_secs(25),
            ),
        ))
        .with_password_applier(Arc::new(
            pria_guest_agent::desktop::kasmvnc::SetpwApplier::default(),
        )),
    );
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
    };

    let _heartbeat = pria_guest_agent::supervisor::spawn_heartbeat_loop(state.clone());

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
