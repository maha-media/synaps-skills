//! Fleet callback bindings (W3.7-G — guest half of F6).
//!
//! The Pria host dispatches fleet tasks by sending W3.7-P wire text into a
//! session (`set_task <slug>@<version>` / `digest sha256:<hex>` / optional
//! `fleet <handleId> <generation>`). The guest agent observes that text at the
//! send choke point (`src/api/sessions.rs::send`), binds `{handle_id,
//! generation}` to the session, and reports task lifecycle back to Pria via
//! signed `fleet_callback` POSTs (`/internal/agentic-vm/fleet-callback`):
//!
//!   * `ack` — emitted immediately when a valid fleet directive binds.
//!   * `heartbeat` — per-binding tokio loop (mirroring
//!     `supervisor::spawn_heartbeat_loop`) on `fleet.heartbeat_interval_seconds`
//!     until the binding clears or is replaced.
//!   * `result` — `{ok:true}` when the running turn's `agent_end` arrives;
//!     `{ok:false, error:{code:"session_exited"}}` when the session's stdout
//!     hits EOF while still bound.
//!
//! State machine: `Acked` (the set_task turn's own `agent_end` is IGNORED) →
//! the next send marks `Running` → `agent_end` while `Running` emits the
//! result and clears. Rebinding replaces the old binding entirely — the old
//! handle never emits again. Detection never blocks or rewrites forwarding.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::pria_client::PriaCallbackClient;

/// A parsed `fleet <handleId> <generation>` directive from a set_task message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FleetDirective {
    pub handle_id: String,
    pub generation: u64,
}

/// Parse a fleet directive out of W3.7-P set_task wire text.
///
/// Returns `Some` only when the FIRST line starts with `set_task ` and a later
/// line matches `^fleet (fj-[a-z0-9][a-z0-9-]*) ([1-9][0-9]*)$` exactly.
/// Anything else — bad handle charset, non-positive generation, a fleet line
/// outside a set_task message — is `None` (fail-open passthrough, fail-closed
/// binding).
pub fn parse_fleet_directive(input: &str) -> Option<FleetDirective> {
    let mut lines = input.lines();
    if !lines.next()?.starts_with("set_task ") {
        return None;
    }
    lines.find_map(parse_fleet_line)
}

/// Parse a single `fleet <handleId> <generation>` line (full-line match).
fn parse_fleet_line(line: &str) -> Option<FleetDirective> {
    let rest = line.strip_prefix("fleet ")?;
    let (handle, generation) = rest.split_once(' ')?;
    if generation.contains(' ') || !valid_handle(handle) {
        return None;
    }
    Some(FleetDirective {
        handle_id: handle.to_string(),
        generation: valid_generation(generation)?,
    })
}

/// `^fj-[a-z0-9][a-z0-9-]*$`
fn valid_handle(handle: &str) -> bool {
    let Some(rest) = handle.strip_prefix("fj-") else {
        return false;
    };
    let mut chars = rest.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `^[1-9][0-9]*$` → the parsed positive integer.
fn valid_generation(generation: &str) -> Option<u64> {
    if !matches!(generation.as_bytes().first(), Some(b'1'..=b'9'))
        || !generation.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    generation.parse().ok()
}

/// Binding lifecycle: `Acked` until the brief send arrives, then `Running`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Acked,
    Running,
}

/// One live fleet binding on a session.
struct Binding {
    directive: FleetDirective,
    phase: Phase,
    /// Per-binding heartbeat task; aborted when the binding clears/replaces.
    heartbeat: tokio::task::JoinHandle<()>,
}

/// The per-VM store of session → fleet binding, shared on `AppState.fleet`.
pub struct FleetBindings {
    pria: Arc<dyn PriaCallbackClient>,
    heartbeat_interval: Duration,
    bindings: Mutex<HashMap<String, Binding>>,
}

impl FleetBindings {
    pub fn new(pria: Arc<dyn PriaCallbackClient>, heartbeat_interval: Duration) -> Self {
        Self {
            pria,
            heartbeat_interval,
            bindings: Mutex::new(HashMap::new()),
        }
    }

    /// Bind a fleet directive to a session: replaces any existing binding
    /// (aborting its heartbeat — the old handle never emits again), emits the
    /// `ack` callback, and starts the per-binding heartbeat loop.
    pub async fn bind(&self, session_id: &str, directive: FleetDirective) {
        let heartbeat = spawn_binding_heartbeat(
            self.pria.clone(),
            self.heartbeat_interval,
            session_id.to_string(),
            directive.clone(),
        );
        let replaced = self.bindings.lock().unwrap().insert(
            session_id.to_string(),
            Binding {
                directive: directive.clone(),
                phase: Phase::Acked,
                heartbeat,
            },
        );
        if let Some(old) = replaced {
            old.heartbeat.abort();
        }
        self.emit(session_id, &directive, "ack", json!({})).await;
    }

    /// The send handler observed a non-fleet send: an `Acked` binding becomes
    /// `Running` (the dispatched task's brief). No-op otherwise.
    pub fn mark_running(&self, session_id: &str) {
        if let Some(binding) = self.bindings.lock().unwrap().get_mut(session_id) {
            if binding.phase == Phase::Acked {
                binding.phase = Phase::Running;
            }
        }
    }

    /// The current directive bound to a session, if any.
    pub fn binding(&self, session_id: &str) -> Option<FleetDirective> {
        self.bindings
            .lock()
            .unwrap()
            .get(session_id)
            .map(|b| b.directive.clone())
    }

    /// An `agent_end` frame arrived on the session's stdout relay. While
    /// `Running` this is the task's completion: emit `result {ok:true}` and
    /// clear. While `Acked` it is the set_task turn's own end — ignored. On an
    /// unbound session it is silent.
    pub async fn on_agent_end(&self, session_id: &str) {
        let cleared = {
            let mut bindings = self.bindings.lock().unwrap();
            match bindings.get(session_id) {
                Some(b) if b.phase == Phase::Running => bindings.remove(session_id),
                _ => None,
            }
        };
        if let Some(binding) = cleared {
            binding.heartbeat.abort();
            self.emit(session_id, &binding.directive, "result", json!({ "ok": true }))
                .await;
        }
    }

    /// The session's stdout hit EOF (process death). While bound — in either
    /// phase — emit `result {ok:false, error:{code:"session_exited"}}` and
    /// clear. On an unbound session it is silent.
    pub async fn on_session_eof(&self, session_id: &str) {
        let cleared = self.bindings.lock().unwrap().remove(session_id);
        if let Some(binding) = cleared {
            binding.heartbeat.abort();
            self.emit(
                session_id,
                &binding.directive,
                "result",
                json!({ "ok": false, "error": { "code": "session_exited" } }),
            )
            .await;
        }
    }

    async fn emit(&self, session_id: &str, directive: &FleetDirective, kind: &str, payload: Value) {
        if let Err(e) = self
            .pria
            .fleet_callback(
                session_id,
                &directive.handle_id,
                directive.generation,
                kind,
                payload,
            )
            .await
        {
            tracing::warn!(error = %e, session_id, kind, "fleet callback failed");
        }
    }
}

/// Spawn the per-binding heartbeat task (mirroring
/// `supervisor::spawn_heartbeat_loop`). The first heartbeat fires one full
/// interval AFTER the bind — the `ack` already announced liveness — and the
/// loop runs until the owning binding aborts the handle.
fn spawn_binding_heartbeat(
    pria: Arc<dyn PriaCallbackClient>,
    interval: Duration,
    session_id: String,
    directive: FleetDirective,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // Consume the interval's immediate first tick: the ack covers t=0.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(e) = pria
                .fleet_callback(
                    &session_id,
                    &directive.handle_id,
                    directive.generation,
                    "heartbeat",
                    json!({}),
                )
                .await
            {
                tracing::warn!(error = %e, session_id, "fleet heartbeat callback failed");
            }
        }
    })
}
