//! HTTP API surface (`/guest/v1/*`).

use std::sync::Arc;

use axum::routing::get;
use axum::Router;

use crate::config::Config;
use crate::hmac::HmacVerifier;
use crate::os::OsUserManager;
use crate::pria_client::PriaCallbackClient;
use crate::runtime::RuntimeState;
use crate::sessions::SessionStore;
use crate::synaps::launcher::SynapsLauncher;
use crate::versions::Versions;

pub mod health;
pub mod principals;
pub mod sessions;

/// Shared application state. Cloned into handlers via axum `State`; the heavy
/// members are behind `Arc` so cloning is cheap. Later slices (B7..B8) extend
/// this with the fsmon client.
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
        .with_state(state)
}
