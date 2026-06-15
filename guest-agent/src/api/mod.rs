//! HTTP API surface (`/guest/v1/*`).

use std::sync::Arc;

use axum::routing::get;
use axum::Router;

use crate::config::Config;
use crate::desktop::kasmvnc::DesktopStore;
use crate::fsmon::client::FsmonControl;
use crate::hmac::HmacVerifier;
use crate::os::OsUserManager;
use crate::pria_client::PriaCallbackClient;
use crate::runtime::RuntimeState;
use crate::sessions::SessionStore;
use crate::synaps::launcher::SynapsLauncher;
use crate::versions::Versions;

pub mod desktop;
pub mod fsmon;
pub mod health;
pub mod policy;
pub mod principals;
pub mod sessions;
pub mod usage;

/// Shared application state. Cloned into handlers via axum `State`; the heavy
/// members are behind `Arc` so cloning is cheap.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub hmac: Arc<HmacVerifier>,
    pub runtime: Arc<RuntimeState>,
    pub versions: Arc<Versions>,
    pub pria: Arc<dyn PriaCallbackClient>,
    pub os: Arc<dyn OsUserManager>,
    pub synaps: Arc<dyn SynapsLauncher>,
    pub sessions: Arc<SessionStore>,
    pub fsmon: Arc<dyn FsmonControl>,
    /// Desktop session store (KasmVNC lifecycle, spec §5.4).
    pub desktops: Arc<DesktopStore>,
}

/// Build the axum router for the configured route prefix.
pub fn build_router(state: AppState) -> Router {
    use axum::routing::post;
    let prefix = state.config.route_prefix.clone();
    Router::new()
        .route(&format!("{prefix}/health"), get(health::health))
        .route(
            &format!("{prefix}/principals/reconcile"),
            post(principals::reconcile),
        )
        .route(
            &format!("{prefix}/principals/disable"),
            post(principals::disable),
        )
        .route(&format!("{prefix}/sessions/start"), post(sessions::start))
        .route(
            &format!("{prefix}/sessions/{{session_id}}/send"),
            post(sessions::send),
        )
        .route(
            &format!("{prefix}/sessions/{{session_id}}/cancel"),
            post(sessions::cancel),
        )
        .route(
            &format!("{prefix}/sessions/{{session_id}}/close"),
            post(sessions::close),
        )
        .route(
            &format!("{prefix}/sessions/{{session_id}}/status"),
            get(sessions::status),
        )
        .route(&format!("{prefix}/policy/apply"), post(policy::apply))
        .route(&format!("{prefix}/usage"), post(usage::ingest))
        .route(&format!("{prefix}/fsmon/status"), get(fsmon::status))
        .route(&format!("{prefix}/fsmon/reload"), post(fsmon::reload))
        // Desktop / KasmVNC lifecycle (spec §5.4, §8.2)
        .route(
            &format!("{prefix}/desktops/start"),
            post(desktop::start_desktop),
        )
        .route(
            &format!("{prefix}/desktops/{{linux_username}}/stop"),
            post(desktop::stop_desktop),
        )
        .route(&format!("{prefix}/desktops"), get(desktop::list_desktops))
        .with_state(state)
}
