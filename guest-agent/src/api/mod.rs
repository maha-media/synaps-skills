//! HTTP API surface (`/guest/v1/*`).

use std::sync::Arc;

use axum::routing::get;
use axum::Router;

use crate::config::Config;
use crate::hmac::HmacVerifier;
use crate::runtime::RuntimeState;
use crate::versions::Versions;

pub mod health;

/// Shared application state. Cloned into handlers via axum `State`; the heavy
/// members are behind `Arc` so cloning is cheap. Later slices (B5..B8) extend
/// this with the OS layer, session table, fsmon client, and Pria callback
/// client.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub hmac: Arc<HmacVerifier>,
    pub runtime: Arc<RuntimeState>,
    pub versions: Arc<Versions>,
}

/// Build the axum router for the configured route prefix.
pub fn build_router(state: AppState) -> Router {
    let prefix = state.config.route_prefix.clone();
    Router::new()
        .route(&format!("{prefix}/health"), get(health::health))
        .with_state(state)
}
