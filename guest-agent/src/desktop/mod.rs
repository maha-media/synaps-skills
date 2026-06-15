//! Desktop / KasmVNC lifecycle management (spec §5.4, §8.2).
//!
//! This module handles per-user desktop session allocation and lifecycle:
//!
//! * **`ports`** — persisted display/port allocator (spec §17.3 "port allocator
//!   persistence"). Allocations survive guest-agent restart to prevent collisions.
//! * **`kasmvnc`** — env-file writer + `systemctl` start/stop/status
//!   abstractions with a unit-testable fake backend (spec §14).
//!
//! The HTTP handlers live in [`crate::api::desktop`].

pub mod kasmvnc;
pub mod ports;
