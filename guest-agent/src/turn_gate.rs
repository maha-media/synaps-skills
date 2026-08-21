//! Per-session turn gate (F6.2 — the delivery half of the W3.8 race) and the
//! send-surface half of the F6.3 binding-conflict law.
//!
//! Live finding (2026-08-21, staging sess_BxJ8NnCUOoVU / fj-63df5428): the
//! send route wrote prompts straight to the SynapsCLI stdin with zero turn
//! awareness, and SynapsCLI silently DROPS prompt messages that arrive
//! mid-turn. Pria's W3.8 dispatcher sends the work-start brief ~50ms after
//! set_task, so the set_task turn is always still streaming when the brief
//! lands — the brief was always dropped, the job heartbeated forever, and no
//! result was ever minted. The F6.1 `skip_ends` fence (src/fleet.rs) counted
//! turns perfectly; DELIVERY was the hole this module closes.
//!
//! The gate is per-session state: `busy` from the moment a TURN (fleet
//! directive or prompt — control frames are not turns, the E3 ruling) is
//! written to stdin until that turn's `agent_end` arrives on the stdout
//! relay. A turn-send that arrives while busy is BUFFERED (bounded FIFO, cap
//! [`PENDING_CAP`]); each `agent_end` flushes exactly one buffered prompt as
//! the next turn. A full queue REFUSES the send with the existing
//! stdin-unavailable error class so Pria's checked delivery fails closed —
//! never a silent drop.
//!
//! Load-bearing consequence (the F6.2e leg): classification and fleet
//! notification (`FleetBindings::bind` / `mark_running`) fire when the bytes
//! are WRITTEN to stdin — direct-write time for an idle session, flush time
//! for a dequeued one. Receipt-time `mark_running` under buffering breaks the
//! F6.1 skip count on the redispatch-onto-busy-session leg (a gen-2 set_task
//! buffered behind a streaming gen-1 turn would let the wrong turn's end
//! mint). The fleet `ack` for a directive queued behind a live turn is
//! therefore deferred to the flush — acceptable: the job row sits
//! `dispatching`, the sweeper pumps only `queued` rows, and adopt requeues
//! `dispatching` on restart.
//!
//! F6.3 at this surface: a directive that the binding-conflict law would
//! refuse is failed CLOSED at HTTP receipt — even when the session is busy —
//! so Pria's checked set_task delivery sees not-ok and the row stays queued
//! server-side. A doomed directive never occupies a queue slot to die
//! silently at flush. The flush path still re-checks (`bind()` is the one
//! authority): a directive queued before a racing bind is dropped at flush
//! without ever reaching stdin (an unbound set_task turn must not run) and
//! the drain continues FIFO.
//!
//! Fail-open discipline: a poisoned gate lock falls back to the direct write
//! (today's exact behavior) — a refused send exists ONLY for the full-queue
//! and binding-conflict rows.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::fleet::{classify_send, BindRefusal, FleetBindings, SendClass};
use crate::sessions::SessionStore;
use crate::synaps::launcher::{LaunchError, SessionProcess};

/// Bounded per-session buffer of turns awaiting an idle CLI (brief: cap 4).
pub const PENDING_CAP: usize = 4;

/// Per-session busy/pending state.
#[derive(Default)]
struct GateEntry {
    /// A turn was written to stdin and its `agent_end` has not yet arrived.
    busy: bool,
    /// Turn-sends buffered behind the streaming turn, FIFO, byte-verbatim.
    pending: VecDeque<String>,
}

/// How an accepted send was delivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendOutcome {
    /// Written to stdin immediately (idle session, or a control frame).
    Written,
    /// Buffered behind the streaming turn; a later `agent_end` flushes it.
    Queued,
}

/// Why a send was refused (both map to fail-closed HTTP errors — Pria's
/// checked delivery must never see a silent drop).
#[derive(Debug)]
pub enum SubmitError {
    /// The bounded pending queue is at [`PENDING_CAP`].
    QueueFull,
    /// The F6.3 binding-conflict law refused the directive.
    Binding(BindRefusal),
    /// The one stdin write path failed (today's stdin-unavailable class).
    Write(LaunchError),
}

/// Per-session turn gate shared on `AppState.gate` (mirrors the
/// `FleetBindings` shape). Owns the busy/pending state; the ONE stdin write
/// path stays `SessionProcess::send` — the gate only serializes access to it.
pub struct TurnGate {
    fleet: Arc<FleetBindings>,
    /// Process lookup for the flush path: the relay only knows the session
    /// id, and the flush must go through the same single write path.
    sessions: Arc<SessionStore>,
    entries: Mutex<HashMap<String, GateEntry>>,
}

impl TurnGate {
    pub fn new(fleet: Arc<FleetBindings>, sessions: Arc<SessionStore>) -> Self {
        Self {
            fleet,
            sessions,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Poison-tolerant lock: `None` means fall back to the direct write
    /// (fail-open — today's behavior), never a refused send.
    fn lock(&self) -> Option<MutexGuard<'_, HashMap<String, GateEntry>>> {
        self.entries.lock().ok()
    }

    /// Is a turn currently streaming on this session (a prompt was written to
    /// stdin and its `agent_end` has not yet arrived)?
    pub fn busy(&self, session_id: &str) -> bool {
        self.lock()
            .and_then(|map| map.get(session_id).map(|e| e.busy))
            .unwrap_or(false)
    }

    /// How many turn-sends are buffered behind the streaming turn.
    pub fn pending_len(&self, session_id: &str) -> usize {
        self.lock()
            .and_then(|map| map.get(session_id).map(|e| e.pending.len()))
            .unwrap_or(0)
    }

    /// The send choke point. Classifies the input, applies the turn gate and
    /// the F6.3 receipt check, and — for the direct-write path — performs the
    /// write-point fleet notification followed by the stdin write.
    pub async fn submit(
        &self,
        session_id: &str,
        input: &str,
        proc: Arc<dyn SessionProcess>,
    ) -> Result<SendOutcome, SubmitError> {
        let class = classify_send(input);
        // Control frames are not turns (E3): they write through immediately,
        // busy or not, and never mark busy — a set_model preamble queued
        // behind a turn would starve, and the CLI accepts them mid-turn.
        let is_turn = !matches!(class, SendClass::ControlFrame);

        // F6.3 receipt check: fail a doomed directive closed NOW, busy or
        // not — it must not occupy a queue slot and die silently at flush.
        if let SendClass::FleetDirective(ref directive) = class {
            if let Some(refusal) = self.fleet.bind_refusal(session_id, directive) {
                return Err(SubmitError::Binding(refusal));
            }
        }

        // Gate decision under the lock; all awaits happen after release.
        // A poisoned lock falls open to the direct write, mutating nothing.
        let marked_busy = match self.lock() {
            Some(mut map) => {
                let entry = map.entry(session_id.to_string()).or_default();
                if entry.busy && is_turn {
                    if entry.pending.len() >= PENDING_CAP {
                        return Err(SubmitError::QueueFull);
                    }
                    entry.pending.push_back(input.to_string());
                    return Ok(SendOutcome::Queued);
                }
                if is_turn {
                    entry.busy = true;
                }
                is_turn
            }
            None => false,
        };

        // Write point: fleet notification + the one stdin write.
        match self.notify_and_write(session_id, input, &class, proc).await {
            Ok(()) => Ok(SendOutcome::Written),
            Err(e) => {
                // The turn never started: un-mark busy so the session cannot
                // wedge behind a failed write.
                if marked_busy {
                    if let Some(mut map) = self.lock() {
                        if let Some(entry) = map.get_mut(session_id) {
                            entry.busy = false;
                        }
                    }
                }
                Err(e)
            }
        }
    }

    /// An `agent_end` frame arrived on the session's stdout relay: drive the
    /// F6.1 fleet state machine FIRST (burn/mint for the turn that just
    /// ended), then flush exactly one buffered prompt as the next turn —
    /// classifying it NOW, so `bind`'s fresh skip debt aligns with the turn
    /// that actually runs next (the F6.2e law). With nothing buffered, busy
    /// clears.
    pub async fn on_agent_end(&self, session_id: &str) {
        self.fleet.on_agent_end(session_id).await;
        loop {
            let next = match self.lock() {
                Some(mut map) => match map.get_mut(session_id) {
                    Some(entry) => match entry.pending.pop_front() {
                        some @ Some(_) => some, // stays busy: a turn follows
                        None => {
                            entry.busy = false;
                            None
                        }
                    },
                    None => None,
                },
                None => None,
            };
            let Some(input) = next else { return };

            // The session may have been removed between the end frame and
            // this flush: drop the state, never write posthumously.
            let Some(proc) = self.sessions.process(session_id) else {
                self.teardown(session_id);
                return;
            };
            let class = classify_send(&input);
            match self.notify_and_write(session_id, &input, &class, proc).await {
                Ok(()) => return, // exactly one flush per agent_end
                Err(SubmitError::Binding(refusal)) => {
                    // F6.3 flush-time re-check lost a race: a binding appeared
                    // after this directive was queued. Fail closed — drop it
                    // WITHOUT writing (an unbound set_task turn must not run;
                    // the job row sits `dispatching`, the lease reaper
                    // recovers it) and keep draining FIFO.
                    tracing::warn!(
                        session_id,
                        refusal = %refusal,
                        "dropping buffered fleet directive refused at flush"
                    );
                    continue;
                }
                Err(_) => {
                    // The stdin is gone mid-flush: the process is dying and
                    // the relay's EOF arm will fire. Drop the gate state now
                    // so nothing wedges busy behind a dead pipe.
                    tracing::warn!(session_id, "flush write failed; dropping gate state");
                    self.teardown(session_id);
                    return;
                }
            }
        }
    }

    /// Session teardown (stop/remove/stdout EOF): drop the gate state —
    /// pending queue cleared, no posthumous flush. Fleet teardown callbacks
    /// are untouched (they live on `FleetBindings`).
    pub fn teardown(&self, session_id: &str) {
        if let Some(mut map) = self.lock() {
            map.remove(session_id);
        }
    }

    /// The write point (shared by direct sends and flushes — one stdin
    /// owner): fleet notification for the bytes that are about to run, then
    /// the write itself.
    async fn notify_and_write(
        &self,
        session_id: &str,
        input: &str,
        class: &SendClass,
        proc: Arc<dyn SessionProcess>,
    ) -> Result<(), SubmitError> {
        match class {
            SendClass::FleetDirective(directive) => self
                .fleet
                .bind(session_id, directive.clone())
                .await
                .map_err(SubmitError::Binding)?,
            SendClass::PromptTurn => self.fleet.mark_running(session_id),
            SendClass::ControlFrame => {}
        }
        proc.send(input).await.map_err(SubmitError::Write)
    }
}
