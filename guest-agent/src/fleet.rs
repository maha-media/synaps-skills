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
//! State machine: `Acked` → the next non-fleet send marks `Running`, with a
//! turn-end debt (`skip_ends`, born 1 at bind) burning the set_task turn's own
//! `agent_end` in EITHER phase — prompts are FIFO, so the brief can mark
//! `Running` while the set_task turn is still streaming (W3.8) and its end
//! must never mint the brief's result (SD invariant 5). `agent_end` while
//! `Running` past the debt emits the result and clears. Rebinding replaces
//! the old binding entirely (fresh debt) — the old handle never emits again.
//! Teardown is never debt-gated. Detection never blocks or rewrites
//! forwarding.

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

/// How the send choke point should treat one `SendRequest.input`.
///
/// Live inputs are single-line JSON-RPC envelopes (`{"type":"prompt",…}` /
/// `{"type":"set_model",…}`) with the W3.7-P wire text riding INSIDE a prompt
/// envelope's `message` — the leg-4 staging finding. Classification is for
/// fleet detection and the Acked→Running state machine ONLY; the ORIGINAL
/// input is always forwarded to the process unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendClass {
    /// A fleet set_task directive (envelope-borne or raw text): bind + ack.
    FleetDirective(FleetDirective),
    /// A non-fleet prompt turn (envelope-borne or raw text): mark Running.
    PromptTurn,
    /// A control frame (e.g. set_model) — NOT a turn (the E3 ruling): neither
    /// binds nor advances Acked→Running.
    ControlFrame,
}

/// Classify one send input at the choke point.
///
/// * JSON object with `type=="prompt"` and a string `message` → fleet
///   detection runs against the EXTRACTED message; without a directive it is
///   an ordinary prompt turn.
/// * JSON object with any other `type` string → a control frame: control
///   frames are not turns and are never fleet-sniffed (the E3 ruling — a
///   control frame marking Running would let its own turn-end mint a `result`
///   before the brief).
/// * Everything else (non-JSON, malformed JSON, non-object, no `type`) falls
///   through to the original raw-text behavior byte-identically.
pub fn classify_send(input: &str) -> SendClass {
    if let Ok(Value::Object(envelope)) = serde_json::from_str::<Value>(input) {
        if let Some(kind) = envelope.get("type").and_then(Value::as_str) {
            if kind == "prompt" {
                if let Some(message) = envelope.get("message").and_then(Value::as_str) {
                    return match parse_fleet_directive(message) {
                        Some(directive) => SendClass::FleetDirective(directive),
                        None => SendClass::PromptTurn,
                    };
                }
            }
            return SendClass::ControlFrame;
        }
    }
    match parse_fleet_directive(input) {
        Some(directive) => SendClass::FleetDirective(directive),
        None => SendClass::PromptTurn,
    }
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
    /// Outstanding turn-end debt: `agent_end`s that belong to turns OPENED AT
    /// OR BEFORE the bind and must never mint this binding's result. `bind()`
    /// initializes it to 1 — the directive turn's own future end. Turn-COUNT
    /// correlation is the law here: `agent_end` carries no prompt id (SynapsCLI
    /// contract), prompts are strictly sequential, every prompt turn ends with
    /// exactly one `agent_end`, and control frames are not turns (the E3
    /// ruling) and emit none. Without this fence, a brief sent while the
    /// set_task turn is still streaming lets that turn's own end mint
    /// `result {ok:true}` for work that never started — a fabricated success
    /// (SD invariant 5 violation) — and leaves the brief as a zombie turn.
    /// NOT consulted by teardown (`on_session_eof` / `on_session_closed`):
    /// process death is process death, both phases.
    skip_ends: u32,
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
                // The directive turn's own future end. A REPLACED binding's
                // burned count never leaks: the new binding starts fresh.
                skip_ends: 1,
                heartbeat,
            },
        );
        if let Some(old) = replaced {
            old.heartbeat.abort();
        }
        self.emit(session_id, &directive, "ack", json!({})).await;
    }

    /// The send handler observed a non-fleet send: an `Acked` binding becomes
    /// `Running` (the dispatched task's brief). Phase flip ONLY — any
    /// outstanding `skip_ends` debt carries over (the set_task turn may still
    /// be streaming when the brief lands; its end is burned, not minted).
    /// No-op otherwise.
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

    /// An `agent_end` frame arrived on the session's stdout relay. Correlation
    /// is turn-count based (see `Binding::skip_ends`): an end still owed to
    /// the directive turn burns the debt and is ignored IN EITHER PHASE —
    /// while `Acked` this is today's ignore, now counted; while `Running` it
    /// is the still-open set_task turn closing AFTER the brief send (the W3.8
    /// FIFO race — that end must never mint the brief's result, SD invariant
    /// 5). Only `Running` with the debt at zero is the task's completion:
    /// emit `result {ok:true}` and clear. `Acked` with the debt at zero (a
    /// spurious extra end before any brief — brief-less old-Pria lineage) is
    /// ignored and the binding stays, heartbeats and all. On an unbound
    /// session it is silent.
    pub async fn on_agent_end(&self, session_id: &str) {
        let cleared = {
            let mut bindings = self.bindings.lock().unwrap();
            match bindings.get_mut(session_id) {
                Some(b) if b.skip_ends > 0 => {
                    b.skip_ends = b.skip_ends.saturating_sub(1);
                    None
                }
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

    /// The session was torn down via `close`/`cancel` (review 9 finding 1).
    /// While bound — in either phase — emit
    /// `result {ok:false, error:{code:"session_closed"}}` EXACTLY ONCE and
    /// clear (aborting the heartbeat loop). On an unbound session it is
    /// silent: teardown is not a turn outcome for sessions that never carried
    /// a fleet task, and repeated teardown finds nothing bound.
    pub async fn on_session_closed(&self, session_id: &str) {
        let cleared = self.bindings.lock().unwrap().remove(session_id);
        if let Some(binding) = cleared {
            binding.heartbeat.abort();
            self.emit(
                session_id,
                &binding.directive,
                "result",
                json!({ "ok": false, "error": { "code": "session_closed" } }),
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

// ── F6.1 turn-count fence (born-RED) ─────────────────────────────────────────
//
// Live + code finding (2026-08-21): Pria's W3.8 slice sends the work-start
// brief IMMEDIATELY after set_task. The CLI processes prompts FIFO, so the
// brief send can mark `Running` while the set_task turn is STILL STREAMING —
// the set_task turn's own `agent_end` then arrives first, while `Running`,
// and mints `result {ok:true}` for work that never started (a fabricated
// success — SD invariant 5 violation), leaving the brief as a zombie turn.
//
// `agent_end` carries no prompt id (SynapsCLI contract — out of scope), so
// correlation is turn-COUNT based: prompts are strictly sequential, every
// prompt turn ends with exactly one `agent_end`, and control frames
// (`set_model`) are not turns and emit none (the E3 ruling). Hence the
// `skip_ends` fence pinned below: `bind()` owes exactly one future end (the
// directive turn's own), and only an end past that debt may mint. Teardown
// (`on_session_eof` / `on_session_closed`) is NOT gated — process death is
// process death, both phases.
#[cfg(test)]
mod f6_1_turn_fence {
    use super::*;
    use crate::pria_client::fake::FakePriaClient;

    fn directive(handle: &str, generation: u64) -> FleetDirective {
        FleetDirective {
            handle_id: handle.into(),
            generation,
        }
    }

    /// FleetBindings driven directly against the fake recorder (the seam the
    /// stdout relay calls — same as the tests/fleet_callback_tests.rs F4 row).
    /// The interval is effectively-never unless a row exercises heartbeats.
    fn fleet_with(interval: Duration) -> (Arc<FakePriaClient>, FleetBindings) {
        let pria = Arc::new(FakePriaClient::default());
        let fleet = FleetBindings::new(
            pria.clone() as Arc<dyn PriaCallbackClient>,
            interval,
        );
        (pria, fleet)
    }

    fn fleet() -> (Arc<FakePriaClient>, FleetBindings) {
        fleet_with(Duration::from_secs(3600))
    }

    fn cbs(pria: &FakePriaClient) -> Vec<Value> {
        pria.fleet_callbacks.lock().unwrap().clone()
    }

    fn results(pria: &FakePriaClient) -> Vec<Value> {
        cbs(pria)
            .into_iter()
            .filter(|c| c["kind"] == "result")
            .collect()
    }

    /// F6.1a — regression fence (the ordering that already works today, kept
    /// pinned): the set_task turn ends BEFORE the brief. The Acked-phase end
    /// burns the directive turn's debt; the next end after `mark_running` is
    /// the brief turn's and mints exactly one `result {ok:true}`.
    #[tokio::test]
    async fn f6_1a_end_before_brief_then_running_end_mints_exactly_once() {
        let (pria, fleet) = fleet();
        fleet.bind("sess_abc", directive("fj-alpha", 7)).await;

        // set_task turn's own end while Acked: counted, ignored.
        fleet.on_agent_end("sess_abc").await;
        assert!(results(&pria).is_empty(), "Acked end must not mint");

        fleet.mark_running("sess_abc");
        fleet.on_agent_end("sess_abc").await;
        let rs = results(&pria);
        assert_eq!(rs.len(), 1, "exactly one result: {rs:?}");
        assert_eq!(rs[0]["handle_id"], "fj-alpha");
        assert_eq!(rs[0]["generation"], 7);
        assert_eq!(rs[0]["payload"]["ok"], true);
        assert!(fleet.binding("sess_abc").is_none(), "cleared");
    }

    /// F6.1b — THE RED ROW. The brief send marks `Running` while the set_task
    /// turn is still streaming: the FIRST `agent_end` is the set_task turn's
    /// own (FIFO) and must mint NOTHING; only the SECOND — the brief turn —
    /// mints, exactly once. Today the first end mints a fabricated success
    /// (SD invariant 5 violation).
    #[tokio::test]
    async fn f6_1b_running_before_directive_turn_ends_first_end_mints_nothing() {
        let (pria, fleet) = fleet();
        fleet.bind("sess_abc", directive("fj-alpha", 7)).await;

        // Brief sent while the set_task turn is STILL open.
        fleet.mark_running("sess_abc");

        // end#1: the set_task turn closing — burns the debt, mints nothing.
        fleet.on_agent_end("sess_abc").await;
        assert!(
            results(&pria).is_empty(),
            "the set_task turn's end must never mint the brief's result: {:?}",
            cbs(&pria)
        );
        assert!(
            fleet.binding("sess_abc").is_some(),
            "binding must survive the directive turn's end"
        );

        // end#2: the brief turn — mints exactly once.
        fleet.on_agent_end("sess_abc").await;
        let rs = results(&pria);
        assert_eq!(rs.len(), 1, "exactly one result on the brief turn's end");
        assert_eq!(rs[0]["payload"]["ok"], true);
        assert_eq!(rs[0]["handle_id"], "fj-alpha");
        assert!(fleet.binding("sess_abc").is_none(), "cleared after mint");
    }

    /// F6.1c — brief-less lineage (old Pria, W3.8 not yet deployed): ends
    /// while Acked burn to zero and are ignored; the binding stays alive and
    /// heartbeats keep flowing until teardown — observable behavior
    /// byte-identical to today (backward compat: this image ships FIRST).
    #[tokio::test]
    async fn f6_1c_no_brief_two_ends_binding_alive_heartbeats_continue() {
        let (pria, fleet) = fleet_with(Duration::from_millis(10));
        fleet.bind("sess_abc", directive("fj-alpha", 7)).await;

        fleet.on_agent_end("sess_abc").await; // burns the debt
        fleet.on_agent_end("sess_abc").await; // spurious extra: ignored
        assert!(results(&pria).is_empty(), "no result without a brief turn");
        assert!(fleet.binding("sess_abc").is_some(), "binding alive");

        // Heartbeats must still be emitting AFTER both ends.
        let before = cbs(&pria).len();
        tokio::time::sleep(Duration::from_millis(120)).await;
        let after = cbs(&pria);
        assert!(
            after.iter().filter(|c| c["kind"] == "heartbeat").count() > 0
                && after.len() > before,
            "heartbeat loop must survive burned/spurious ends: {after:?}"
        );
        assert!(results(&pria).is_empty(), "still no result");
    }

    /// F6.1d — teardown is NOT gated on the skip fence: `Running` with the
    /// debt still pending, then `close`/`cancel` → exactly one
    /// `result {ok:false, error.code=="session_closed"}` and the binding
    /// clears. Process death is process death, both phases.
    #[tokio::test]
    async fn f6_1d_session_closed_with_skip_pending_mints_failure_immediately() {
        let (pria, fleet) = fleet();
        fleet.bind("sess_abc", directive("fj-alpha", 7)).await;
        fleet.mark_running("sess_abc"); // debt still pending

        fleet.on_session_closed("sess_abc").await;
        let rs = results(&pria);
        assert_eq!(rs.len(), 1, "exactly one teardown result: {rs:?}");
        assert_eq!(rs[0]["payload"]["ok"], false);
        assert_eq!(rs[0]["payload"]["error"]["code"], "session_closed");
        assert!(fleet.binding("sess_abc").is_none(), "cleared");

        // Post-clear ends/teardown are silent.
        fleet.on_agent_end("sess_abc").await;
        fleet.on_session_closed("sess_abc").await;
        assert_eq!(results(&pria).len(), 1);
    }

    /// F6.1e — rebind resets the debt: A's burned count must not leak into B.
    /// bind A → A's directive-turn end (Acked, burns A's debt) → rebind B
    /// (fresh debt of 1) → brief marks Running while B's directive turn is
    /// still open → the first end is B's directive turn (mints nothing), the
    /// second is B's brief turn (mints, under fj-b).
    #[tokio::test]
    async fn f6_1e_rebind_resets_skip_count_first_end_after_rebind_silent() {
        let (pria, fleet) = fleet();
        fleet.bind("sess_abc", directive("fj-a", 1)).await;
        fleet.on_agent_end("sess_abc").await; // burns A's debt

        fleet.bind("sess_abc", directive("fj-b", 2)).await; // fresh debt: 1
        fleet.mark_running("sess_abc");

        fleet.on_agent_end("sess_abc").await; // B's directive turn — silent
        assert!(
            results(&pria).is_empty(),
            "stale (burned) A-count must not let B's directive turn mint: {:?}",
            cbs(&pria)
        );

        fleet.on_agent_end("sess_abc").await; // B's brief turn — mints
        let rs = results(&pria);
        assert_eq!(rs.len(), 1, "exactly one result, for B: {rs:?}");
        assert_eq!(rs[0]["handle_id"], "fj-b");
        assert_eq!(rs[0]["generation"], 2);
        assert_eq!(rs[0]["payload"]["ok"], true);
    }
}
