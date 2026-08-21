//! Per-session turn gate (F6.2 — the delivery half of the W3.8 race).
//!
//! Live finding (2026-08-21, staging sess_BxJ8NnCUOoVU / fj-63df5428): the
//! send route writes prompts straight to the SynapsCLI stdin with zero turn
//! awareness, and SynapsCLI silently DROPS prompt messages that arrive
//! mid-turn. Pria's W3.8 dispatcher sends the work-start brief ~50ms after
//! set_task, so the set_task turn is always still streaming when the brief
//! lands — the brief is always dropped, the job heartbeats forever, and no
//! result is ever minted. The F6.1 `skip_ends` fence (src/fleet.rs) counted
//! turns perfectly; DELIVERY is the hole this module closes.
//!
//! The gate is per-session state: `busy` from the moment a TURN (fleet
//! directive or prompt — control frames are not turns, the E3 ruling) is
//! written to stdin until that turn's `agent_end` arrives on the stdout
//! relay. A turn-send that arrives while busy is BUFFERED (bounded FIFO,
//! cap [`PENDING_CAP`]); each `agent_end` flushes exactly one buffered
//! prompt as the next turn. A full queue REFUSES the send with the existing
//! stdin-unavailable error class so Pria's checked delivery fails closed —
//! never a silent drop.
//!
//! Load-bearing consequence (the F6.2e leg): classification and fleet
//! notification (`FleetBindings::bind` / `mark_running`) move from HTTP
//! receipt to the moment the bytes are WRITTEN to stdin — direct-write time
//! for an idle session, flush time for a dequeued one. Receipt-time
//! `mark_running` under buffering breaks the F6.1 skip count on the
//! redispatch-onto-busy-session leg (a gen-2 set_task buffered behind a
//! streaming gen-1 turn would let the wrong turn's end mint). The fleet
//! `ack` for a directive queued behind a live turn is therefore deferred to
//! the flush — acceptable: the job row sits `dispatching`, the sweeper pumps
//! only `queued` rows, and adopt requeues `dispatching` on restart.
//!
//! BORN-RED SCAFFOLD NOTE: at the fence commit this module is a
//! behavior-preserving pass-through — it exposes the seam shape the fence
//! rows drive (`busy` / `pending_len` / `on_agent_end` / `teardown`) with
//! today's semantics (no busy tracking, no queue; `on_agent_end` only
//! forwards to the F6.1 fleet state machine) so the rows fail for the RIGHT
//! reason: the mid-turn write is observed, not a compile error.

use std::sync::Arc;

use crate::fleet::FleetBindings;
use crate::sessions::SessionStore;

/// Bounded per-session buffer of turns awaiting an idle CLI (brief: cap 4).
pub const PENDING_CAP: usize = 4;

/// Per-session turn gate shared on `AppState.gate` (mirrors the
/// `FleetBindings` shape). Owns the busy/pending state; the ONE stdin write
/// path stays `SessionProcess::send` — the gate only serializes access to it.
pub struct TurnGate {
    #[allow(dead_code)] // consumed by the flush path in the fix commit
    fleet: Arc<FleetBindings>,
    #[allow(dead_code)] // consumed by the flush path in the fix commit
    sessions: Arc<SessionStore>,
}

impl TurnGate {
    pub fn new(fleet: Arc<FleetBindings>, sessions: Arc<SessionStore>) -> Self {
        Self { fleet, sessions }
    }

    /// Is a turn currently streaming on this session (a prompt was written to
    /// stdin and its `agent_end` has not yet arrived)?
    pub fn busy(&self, _session_id: &str) -> bool {
        false
    }

    /// How many turn-sends are buffered behind the streaming turn.
    pub fn pending_len(&self, _session_id: &str) -> usize {
        0
    }

    /// An `agent_end` frame arrived on the session's stdout relay: drive the
    /// F6.1 fleet state machine first (burn/mint for the turn that just
    /// ended), then flush exactly one buffered prompt as the next turn.
    pub async fn on_agent_end(&self, session_id: &str) {
        self.fleet.on_agent_end(session_id).await;
    }

    /// Session teardown (stop/remove/stdout EOF): drop the gate state —
    /// pending queue cleared, no posthumous flush. Fleet teardown callbacks
    /// are untouched (they live on `FleetBindings`).
    pub fn teardown(&self, _session_id: &str) {}
}
