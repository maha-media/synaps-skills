//! Pria guest-agent library crate.
//!
//! The guest-agent is Pria's trusted in-VM supervisor (spec). It exposes a
//! narrow, typed `/guest/v1/*` HTTP API, authenticates every request with
//! HMAC-SHA256 (spec §5), and reconciles local VM state (Linux principals,
//! Synaps sessions, policy, fsmon) to Pria's desired state. It NEVER modifies
//! SynapsCLI core (see `docs/contract.md` §5 / plan §4 HARD STOPs).

pub mod config;
pub mod desktop;
pub mod error;
pub mod fsmon;
pub mod hmac;
pub mod ids;
pub mod os;
pub mod paths;
pub mod pria_client;
pub mod runtime;
pub mod sessions;
pub mod supervisor;
pub mod synaps;
pub mod versions;

pub mod api;

#[cfg(any(test, feature = "test-fakes"))]
pub mod test_support;
