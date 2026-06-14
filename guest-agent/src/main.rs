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
    let state = AppState {
        config: Arc::new(config),
        hmac: Arc::new(hmac),
        runtime: Arc::new(pria_guest_agent::runtime::RuntimeState::new()),
        versions: Arc::new(versions),
        pria,
        os,
    };

    let _heartbeat = pria_guest_agent::supervisor::spawn_heartbeat_loop(state.clone());

    let app = build_router(state);

    let addr = format!("{}:{}", listen.host, listen.port);
    tracing::info!(%addr, "pria-guest-agent listening");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
