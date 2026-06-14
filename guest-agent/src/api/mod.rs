//! HTTP API surface (`/guest/v1/*`).

use std::sync::Arc;

use axum::routing::get;
use axum::Router;

use crate::config::Config;

/// Placeholder slice-B1 application state. Later slices (B2..B8) extend this with
/// the HMAC verifier, OS layer, session table, fsmon client, and Pria callback
/// client. Held behind `Arc` and cloned into handlers via axum `State`.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
}

/// Build the axum router for the configured route prefix.
pub fn build_router(state: AppState) -> Router {
    let prefix = state.config.route_prefix.clone();
    Router::new()
        .route(&format!("{prefix}/health"), get(health_stub))
        .with_state(state)
}

async fn health_stub() -> &'static str {
    "ok"
}
