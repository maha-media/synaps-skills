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
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::fleet_git;
use crate::pria_client::{GitFetch, GitPush, PriaCallbackClient};
use crate::sessions::SessionStore;

/// A parsed `fleet <handleId> <generation>` directive from a set_task message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FleetDirective {
    pub handle_id: String,
    pub generation: u64,
    /// F7 (R-F7-1/2): the OPTIONAL workspace binding. `Some(slug)` ⇒ the guest
    /// clones the workspace and is granted guest-local write; `None` ⇒ today's
    /// workspace-less F6 behavior (no clone, no steer, no push). Fail-closed:
    /// a malformed `ws:` token voids the WHOLE directive (no binding), never a
    /// workspace-less binding smuggled out of a bad token.
    pub workspace: Option<String>,
}

impl FleetDirective {
    /// The bound workspace slug, if any (accessor so fences read intent, not
    /// the field layout).
    pub fn workspace_slug(&self) -> Option<String> {
        self.workspace.clone()
    }
}

/// Parse a fleet directive out of W3.7-P set_task wire text.
///
/// Returns `Some` only when the FIRST line starts with `set_task ` and a later
/// line matches `^fleet (fj-[a-z0-9][a-z0-9-]*) ([1-9][0-9]*)( ws:<slug>)?$`
/// exactly. Anything else — bad handle charset, non-positive generation, a
/// malformed/absent-but-dangling `ws:` token, a fleet line outside a set_task
/// message — is `None` (fail-open passthrough, fail-closed binding).
pub fn parse_fleet_directive(input: &str) -> Option<FleetDirective> {
    let mut lines = input.lines();
    if !lines.next()?.starts_with("set_task ") {
        return None;
    }
    lines.find_map(parse_fleet_line)
}

/// Parse a single `fleet <handleId> <generation>[ ws:<slug>]` line (full-line
/// match). The ws token, when present, must be EXACTLY `ws:<valid-slug>` and
/// the ONLY trailing token — anything else fails the whole line closed.
fn parse_fleet_line(line: &str) -> Option<FleetDirective> {
    let rest = line.strip_prefix("fleet ")?;
    let (handle, tail) = rest.split_once(' ')?;
    if !valid_handle(handle) {
        return None;
    }
    // `tail` is either `<generation>` (3-token) or `<generation> ws:<slug>`
    // (4-token). A generation containing a space MUST be followed by exactly
    // one well-formed ws token, else the line is malformed.
    let (generation, workspace) = match tail.split_once(' ') {
        None => (tail, None),
        Some((gen, ws)) => (gen, Some(parse_ws_token(ws)?)),
    };
    Some(FleetDirective {
        handle_id: handle.to_string(),
        generation: valid_generation(generation)?,
        workspace,
    })
}

/// Parse the OPTIONAL `ws:<slug>` token (full-token match). The slug is
/// server-controlled; the charset is a byte-twin of Pria's utils
/// WORKSPACE_SLUG_RE `^[a-z0-9][a-z0-9_-]*$`. Anything else is `None` → the
/// caller fails the directive closed.
fn parse_ws_token(token: &str) -> Option<String> {
    let slug = token.strip_prefix("ws:")?;
    if valid_workspace_slug(slug) {
        Some(slug.to_string())
    } else {
        None
    }
}

/// `^[a-z0-9][a-z0-9_-]*$` — byte-twin of Pria's WORKSPACE_SLUG_RE.
fn valid_workspace_slug(slug: &str) -> bool {
    let mut chars = slug.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
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
    /// F7-S: the staged hidden steer text for a workspace-bound binding.
    /// Set at bind (after the clone materializes); consumed EXACTLY ONCE by
    /// `pending_steer` — the TurnGate is the only caller, right after the
    /// successful `bind()` in `notify_and_write`, and it queues the text into
    /// its own pending FIFO (the ONE stdin writer law: FleetBindings never
    /// writes to a process).
    steer: Option<String>,
    /// F7-S: the materialized workspace (the clone under
    /// `<session_dir>/worktree`). `None` ⇒ a workspace-less binding
    /// (absent ws token, refused fetch, or a clone failure): no steer, no
    /// push, honest F6 result.
    workspace: Option<WsState>,
    /// Per-binding heartbeat task; aborted when the binding clears/replaces.
    heartbeat: tokio::task::JoinHandle<()>,
}

/// F7-S: a live workspace clone on a binding (R-F7-1/2 — the ws binding IS
/// the write grant; the agent works this tree with its local fs tools).
#[derive(Debug, Clone)]
pub struct WsState {
    /// The clone root: `<session_dir>/worktree/` (jailed under the
    /// session scratch — never inside the agent's `workspace_dir` cwd).
    /// The leaf is deliberately NEUTRAL (not the handle id): the steer
    /// text names this absolute path, and the R-F7-3 NEVER law forbids
    /// the handle from being model-visible even via the path.
    pub work_dir: PathBuf,
    /// The oid the clone's HEAD was born at — the connectivity anchor for the
    /// thin result bundle (`<base>..HEAD`).
    pub base_oid: String,
}

/// The hidden steer text (R-F7-3): the agent is steered into the clone
/// STRUCTURALLY — the wire token (`ws:<slug>`, `fleet <handle>`, the handle
/// id) is NEVER model-visible; only the absolute path appears.
pub fn steer_prompt(work_dir: &std::path::Path) -> String {
    format!(
        "Change into and do ALL of your work inside the directory `{}`; \
         every file you create or edit must live under it.",
        work_dir.display()
    )
}

/// The per-VM store of session → fleet binding, shared on `AppState.fleet`.
pub struct FleetBindings {
    pria: Arc<dyn PriaCallbackClient>,
    heartbeat_interval: Duration,
    bindings: Mutex<HashMap<String, Binding>>,
    /// F7-S: the session table, read ONCE per ws-bind for `dirs()` (the clone
    /// root jail). Optional so unit fences that never bind a workspace need no
    /// store. This does NOT cycle: `SessionStore` never references
    /// `FleetBindings`, and the steer injection still rides the TurnGate —
    /// `FleetBindings` never writes to a process.
    sessions: Option<Arc<SessionStore>>,
}

/// Why a `bind()` was refused (F6.3 binding-conflict law).
///
/// Live root cause (staging, fj-8d7c1e71 gen 3→6 → attempts_exhausted):
/// Pria's session-reuse path can send a set_task for handle B into a session
/// carrying a LIVE binding for handle A. Unconditional replacement aborts A's
/// heartbeat — A starves, gets lease-reaped, steals the session back, and the
/// two handles livelock. `bind()` must refuse instead; the send path surfaces
/// the refusal as `binding_conflict` so Pria's checked set_task delivery fails
/// that dispatch leg closed (the row stays queued server-side).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindRefusal {
    /// A live binding for a DIFFERENT handle occupies the session. Nothing is
    /// disturbed: no replacement, no heartbeat abort, no ack for the intruder.
    Conflict { live_handle: String },
    /// Same handle, but generation did not move forward (stale directive —
    /// generations only step forward on requeue redispatch).
    StaleGeneration { current: u64 },
}

impl std::fmt::Display for BindRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BindRefusal::Conflict { live_handle } => {
                write!(f, "session carries a live binding for {live_handle}")
            }
            BindRefusal::StaleGeneration { current } => {
                write!(f, "stale directive: bound generation is already {current}")
            }
        }
    }
}

impl FleetBindings {
    pub fn new(pria: Arc<dyn PriaCallbackClient>, heartbeat_interval: Duration) -> Self {
        Self {
            pria,
            heartbeat_interval,
            bindings: Mutex::new(HashMap::new()),
            sessions: None,
        }
    }

    /// F7-S: attach the session table (construction-time wiring in main.rs /
    /// test_support). Used ONLY to read `dirs()` for the clone root.
    pub fn with_sessions(mut self, sessions: Arc<SessionStore>) -> Self {
        self.sessions = Some(sessions);
        self
    }

    /// F7-S: the staged hidden steer text for a session's binding, returned
    /// EXACTLY ONCE (consumed) — the TurnGate calls this right after a
    /// successful `bind()` and queues the text into its own pending FIFO.
    /// `None` ⇒ no steer (workspace-less / already consumed / unbound).
    pub fn pending_steer(&self, session_id: &str) -> Option<String> {
        self.bindings
            .lock()
            .unwrap()
            .get_mut(session_id)
            .and_then(|b| b.steer.take())
    }

    /// Bind a fleet directive to a session, subject to the F6.3 conflict law:
    /// a SAME-handle rebind with a forward-stepping generation replaces the
    /// binding (aborting its heartbeat, fresh debt — the requeue-redispatch
    /// leg); a same-handle bind at `generation <= current` is refused as
    /// stale; a FOREIGN-handle bind while any binding is live is refused
    /// outright (no replacement, no heartbeat abort, no ack — the fj-8d7c1e71
    /// livelock). A cleared session accepts any handle fresh.
    ///
    /// F7-S: when the directive carries a `ws:<slug>` binding, the acceptance
    /// then performs the workspace lifecycle BEFORE the ack: fetch the base
    /// bundle, materialize the clone under `<session_dir>/worktree`,
    /// stage the hidden steer text, and owe TWO ends (the set_task turn's AND
    /// the steer turn's). A refused fetch / failed clone degrades to an
    /// honest workspace-LESS binding (no clone, no steer, no push — the ack
    /// still fires). An absent-ws directive is byte-identical F6. The F6.3
    /// insert-then-ack ordering is preserved: refusals never fetch, never
    /// clone, never ack.
    pub async fn bind(
        &self,
        session_id: &str,
        directive: FleetDirective,
    ) -> Result<(), BindRefusal> {
        // Spawn the heartbeat BEFORE taking the lock (spawning inside the
        // critical section would hold the map across a runtime call); an
        // aborted-on-refusal task never ticks — the first beat is one full
        // interval out. Option-wrapped so only the insert arm consumes it.
        let mut heartbeat = Some(spawn_binding_heartbeat(
            self.pria.clone(),
            self.heartbeat_interval,
            session_id.to_string(),
            directive.clone(),
        ));
        let accepted = {
            let mut bindings = self.bindings.lock().unwrap();
            match bindings.get(session_id) {
                // Decide and insert under ONE lock so a concurrent bind can
                // never interleave between the conflict check and the insert.
                Some(live) if live.directive.handle_id != directive.handle_id => {
                    Err(BindRefusal::Conflict {
                        live_handle: live.directive.handle_id.clone(),
                    })
                }
                Some(live) if directive.generation <= live.directive.generation => {
                    Err(BindRefusal::StaleGeneration {
                        current: live.directive.generation,
                    })
                }
                _ => Ok(bindings.remove(session_id)),
            }
        };
        let replaced = match accepted {
            Ok(replaced) => replaced,
            Err(refusal) => {
                // Refusals disturb NOTHING that lives: only the intruder's
                // own never-ticked heartbeat dies; no ack is emitted, and the
                // workspace legs below never run (fail-closed).
                if let Some(h) = heartbeat {
                    h.abort();
                }
                return Err(refusal);
            }
        };

        // F7-S: the workspace legs (fetch + clone + steer staging), AFTER the
        // F6.3 acceptance. Fetch-before-insert keeps the F6.3 law observing
        // the OLD binding for the whole fetch window; the `pending_steer`
        // race hole is impossible because the steer can only be staged after
        // this insert lands.
        let (skip_ends, steer, workspace) = match self
            .bind_workspace(session_id, &directive)
            .await
        {
            Some(ws) => (2, Some(steer_prompt(&ws.work_dir)), Some(ws)),
            None => (1, None, None),
        };
        {
            let mut bindings = self.bindings.lock().unwrap();
            bindings.insert(
                session_id.to_string(),
                Binding {
                    directive: directive.clone(),
                    phase: Phase::Acked,
                    // The directive turn's own future end, plus the hidden
                    // steer turn's end when a workspace bound (F7-S: its
                    // agent_end must never mint the result).
                    skip_ends,
                    steer,
                    workspace,
                    heartbeat: heartbeat.take().expect("heartbeat consumed once"),
                },
            );
        }
        if let Some(old) = replaced {
            old.heartbeat.abort();
        }
        self.emit(session_id, &directive, "ack", json!({})).await;
        Ok(())
    }

    /// F7-S: the bind-time workspace legs. `Some(WsState)` ⇒ the base bundle
    /// fetched and the clone materialized (workspace-bound); `None` ⇒ run
    /// workspace-LESS — absent ws token (byte-identical F6), a refused fetch
    /// (the typed delegate answer), or a clone failure. Never throws: the
    /// binding is valid either way; the workspace is the granted capability,
    /// not a precondition (R-F7-2 — absent capability fails CLOSED to the
    /// workspace-less run, mirroring Pria).
    async fn bind_workspace(&self, session_id: &str, directive: &FleetDirective) -> Option<WsState> {
        directive.workspace.as_ref()?;
        let (session_dir, _) = self.sessions.as_ref()?.dirs(session_id)?;
        let answer = self
            .pria
            .fleet_git_fetch(&directive.handle_id, directive.generation, session_id)
            .await;
        let bytes = match answer {
            Ok(GitFetch::Bundle(bytes)) => bytes,
            Ok(GitFetch::Refused(reason)) => {
                tracing::warn!(
                    session_id,
                    handle_id = %directive.handle_id,
                    reason,
                    "fleet git fetch refused — running workspace-less"
                );
                return None;
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    session_id,
                    "fleet git fetch failed — running workspace-less"
                );
                return None;
            }
        };
        // Clone root: `<session_dir>/worktree/` — the R-F7-3 law says the
        // wire token (the handle id included) is NEVER model-visible, and
        // the steer text names the clone's absolute path — so the on-disk
        // leaf must be neutral, not the handle. Two binds in one session
        // can't collide here: the F6.3 law keeps at most ONE live binding
        // per session (a same-handle rebind replaces the old workspace; a
        // foreign-handle bind is refused outright).
        let dest = session_dir.join("worktree");
        match fleet_git::clone_from_bundle(&bytes, &dest) {
            Ok(out) => Some(WsState {
                work_dir: out.work_dir,
                base_oid: out.base_oid,
            }),
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    session_id,
                    dest = %dest.display(),
                    "fleet workspace clone failed — running workspace-less"
                );
                None
            }
        }
    }

    /// Read-only preview of the F6.3 law for the send choke point: would this
    /// directive be refused right now? Used to fail a BUFFERED dispatch
    /// closed at HTTP receipt (a doomed directive must not occupy a queue
    /// slot and die silently at flush). `bind()` re-checks under its own lock
    /// — this is advisory, the law has one authority.
    pub fn bind_refusal(&self, session_id: &str, directive: &FleetDirective) -> Option<BindRefusal> {
        let bindings = self.bindings.lock().unwrap();
        match bindings.get(session_id) {
            Some(live) if live.directive.handle_id != directive.handle_id => {
                Some(BindRefusal::Conflict {
                    live_handle: live.directive.handle_id.clone(),
                })
            }
            Some(live) if directive.generation <= live.directive.generation => {
                Some(BindRefusal::StaleGeneration {
                    current: live.directive.generation,
                })
            }
            _ => None,
        }
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
            let payload = self.result_payload(session_id, &binding).await;
            self.emit(session_id, &binding.directive, "result", payload)
                .await;
        }
    }

    /// F7-S: the result payload for a minted completion. A workspace-LESS
    /// binding is byte-identical F6 (`{ok:true}`). A workspace-bound binding
    /// commits the agent's work IF the tree is dirty and pushes the thin
    /// result bundle BEFORE the result callback fires (the ordering law):
    ///   * clean tree ⇒ `{ok:true}`, ZERO push (no fabricated artifact —
    ///     Pria's R-W5-3 terminal law);
    ///   * push accepted ⇒ `{ok:true}`;
    ///   * push refused / bundle failure ⇒
    ///     `{ok:false, error:{code:"push_refused"}}` (first-cause law).
    async fn result_payload(&self, session_id: &str, binding: &Binding) -> Value {
        let Some(ws) = &binding.workspace else {
            return json!({ "ok": true });
        };
        let d = &binding.directive;
        // The task slug is not on the directive; the generic message binds
        // the fleet handle (server-side audit corroboration).
        let message = format!("fleet {}", d.handle_id);
        let committed = match fleet_git::commit_if_dirty(&ws.work_dir, &message) {
            Ok(committed) => committed,
            Err(e) => {
                tracing::warn!(error = %e, session_id, "fleet commit failed — treating as clean");
                None
            }
        };
        let Some(_oid) = committed else {
            return json!({ "ok": true }); // clean tree: no artifact, no push
        };
        let bundle = match fleet_git::make_result_bundle(&ws.work_dir, &ws.base_oid) {
            Ok(out) => out,
            Err(e) => {
                tracing::warn!(error = %e, session_id, "fleet result bundle failed");
                return json!({ "ok": false, "error": { "code": "push_refused" } });
            }
        };
        let ref_name = format!("refs/vm/{}/result", d.handle_id);
        match self
            .pria
            .fleet_git_push(d.handle_id.as_str(), d.generation, &ref_name, session_id, &bundle.bytes)
            .await
        {
            Ok(GitPush::Accepted) => json!({ "ok": true }),
            Ok(GitPush::Refused(reason)) => {
                tracing::warn!(session_id, reason, "fleet git push refused");
                json!({ "ok": false, "error": { "code": "push_refused" } })
            }
            Err(e) => {
                tracing::warn!(error = %e, session_id, "fleet git push failed");
                json!({ "ok": false, "error": { "code": "push_refused" } })
            }
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
            workspace: None,
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
        fleet
            .bind("sess_abc", directive("fj-alpha", 7))
            .await
            .expect("first bind accepted");

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
        fleet
            .bind("sess_abc", directive("fj-alpha", 7))
            .await
            .expect("first bind accepted");

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
        fleet
            .bind("sess_abc", directive("fj-alpha", 7))
            .await
            .expect("first bind accepted");

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
        fleet
            .bind("sess_abc", directive("fj-alpha", 7))
            .await
            .expect("first bind accepted");
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

    /// F6.1e — rebind resets the debt: gen 1's burned count must not leak
    /// into gen 2. bind gen 1 → its directive-turn end (Acked, burns the
    /// debt) → rebind gen 2 (fresh debt of 1) → brief marks Running while
    /// gen 2's directive turn is still open → the first end is gen 2's
    /// directive turn (mints nothing), the second is gen 2's brief turn
    /// (mints, under generation 2).
    ///
    /// LAW CHANGE NOTE (F6.3): this row originally proved the debt reset via
    /// a FOREIGN-handle rebind (fj-a → fj-b) — that leg is now REFUSED by
    /// the binding-conflict law (the fj-8d7c1e71 livelock; pinned by f6_3b/c
    /// and F6.3e/f). The property this row pins — a replaced binding's
    /// burned count never leaks into its replacement — survives at full
    /// strength on the one leg that remains legal: the same handle stepping
    /// its generation forward (requeue redispatch).
    #[tokio::test]
    async fn f6_1e_rebind_resets_skip_count_first_end_after_rebind_silent() {
        let (pria, fleet) = fleet();
        fleet
            .bind("sess_abc", directive("fj-a", 1))
            .await
            .expect("first bind accepted");
        fleet.on_agent_end("sess_abc").await; // burns gen 1's debt

        fleet
            .bind("sess_abc", directive("fj-a", 2))
            .await
            .expect("forward-generation rebind replaces"); // fresh debt: 1
        fleet.mark_running("sess_abc");

        fleet.on_agent_end("sess_abc").await; // gen 2's directive turn — silent
        assert!(
            results(&pria).is_empty(),
            "stale (burned) gen-1 count must not let gen 2's directive turn mint: {:?}",
            cbs(&pria)
        );

        fleet.on_agent_end("sess_abc").await; // gen 2's brief turn — mints
        let rs = results(&pria);
        assert_eq!(rs.len(), 1, "exactly one result, for gen 2: {rs:?}");
        assert_eq!(rs[0]["handle_id"], "fj-a");
        assert_eq!(rs[0]["generation"], 2);
        assert_eq!(rs[0]["payload"]["ok"], true);
    }
}

// ── F6.3 binding-conflict law (born-RED) ─────────────────────────────────────
//
// Live root cause (staging): Pria's session-reuse path sent a set_task for
// handle B into a session carrying a LIVE binding for handle A. `bind()`
// replaced unconditionally and aborted A's heartbeat — A starved, got
// lease-reaped, stole the session back, and the two handles livelocked
// (fj-8d7c1e71 churned gen 3→6 to attempts_exhausted). The law pinned here:
// same-handle FORWARD-generation rebind replaces (requeue redispatch);
// same-handle non-forward generation is refused as stale; a foreign handle is
// refused outright while any binding is live and disturbs NOTHING; a cleared
// binding (result emitted / teardown) frees the session for any handle.
#[cfg(test)]
mod f6_3_binding_conflict {
    use super::*;
    use crate::pria_client::fake::FakePriaClient;

    fn directive(handle: &str, generation: u64) -> FleetDirective {
        FleetDirective {
            handle_id: handle.into(),
            generation,
            workspace: None,
        }
    }

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

    /// F6.3a — same-handle FORWARD-generation rebind (requeue redispatch) is
    /// allowed and replaces: ack under the new generation, fresh skip debt
    /// (the F6.1e law re-proven through the accepted-rebind leg).
    #[tokio::test]
    async fn f6_3a_same_handle_forward_generation_rebind_replaces_with_fresh_debt() {
        let (pria, fleet) = fleet();
        fleet
            .bind("sess_abc", directive("fj-a", 1))
            .await
            .expect("first bind on a free session");
        fleet.on_agent_end("sess_abc").await; // burns gen-1's debt

        fleet
            .bind("sess_abc", directive("fj-a", 2))
            .await
            .expect("same handle, forward generation: allowed");
        let acks: Vec<Value> = cbs(&pria)
            .into_iter()
            .filter(|c| c["kind"] == "ack")
            .collect();
        assert_eq!(acks.len(), 2, "one ack per accepted bind");
        assert_eq!(acks[1]["generation"], 2);
        assert_eq!(fleet.binding("sess_abc").unwrap().generation, 2);

        // Fresh debt: the gen-2 directive turn's own end is silent; the brief
        // turn's end mints exactly once, under gen 2.
        fleet.mark_running("sess_abc");
        fleet.on_agent_end("sess_abc").await;
        assert!(results(&pria).is_empty(), "gen-2 directive turn end silent");
        fleet.on_agent_end("sess_abc").await;
        let rs = results(&pria);
        assert_eq!(rs.len(), 1, "exactly one result: {rs:?}");
        assert_eq!(rs[0]["generation"], 2);
        assert_eq!(rs[0]["payload"]["ok"], true);
    }

    /// F6.3b — same-handle bind at `generation <= current` is REFUSED as a
    /// stale directive: no ack, no replacement, and the live binding's
    /// phase/skip debt are undisturbed (it still completes exactly once).
    #[tokio::test]
    async fn f6_3b_same_handle_stale_or_equal_generation_refused_undisturbed() {
        let (pria, fleet) = fleet();
        fleet
            .bind("sess_abc", directive("fj-a", 3))
            .await
            .expect("bind on a free session");

        assert_eq!(
            fleet.bind("sess_abc", directive("fj-a", 3)).await,
            Err(BindRefusal::StaleGeneration { current: 3 }),
            "equal generation must be refused (stale redelivery)"
        );
        assert_eq!(
            fleet.bind("sess_abc", directive("fj-a", 2)).await,
            Err(BindRefusal::StaleGeneration { current: 3 }),
            "backward generation must be refused"
        );
        assert_eq!(
            cbs(&pria).len(),
            1,
            "refused binds must not ack: {:?}",
            cbs(&pria)
        );
        assert_eq!(fleet.binding("sess_abc").unwrap().generation, 3);

        // The refusals disturbed nothing: burn + brief + mint, exactly once.
        fleet.mark_running("sess_abc");
        fleet.on_agent_end("sess_abc").await; // directive turn's own end
        assert!(results(&pria).is_empty(), "debt survived the refusals");
        fleet.on_agent_end("sess_abc").await;
        let rs = results(&pria);
        assert_eq!(rs.len(), 1, "exactly one result: {rs:?}");
        assert_eq!(rs[0]["generation"], 3);
    }

    /// F6.3c — THE LIVELOCK ROW: a FOREIGN-handle bind while a live binding
    /// exists is REFUSED — no replacement, no heartbeat abort, no ack for the
    /// intruder. Today `bind()` replaces unconditionally and aborts A's
    /// heartbeat: A starves → lease-reaped → steals back → livelock
    /// (fj-8d7c1e71, gen 3→6, attempts_exhausted).
    #[tokio::test]
    async fn f6_3c_foreign_handle_bind_refused_binding_and_heartbeat_undisturbed() {
        let (pria, fleet) = fleet_with(Duration::from_millis(10));
        fleet
            .bind("sess_abc", directive("fj-a", 1))
            .await
            .expect("A binds a free session");

        assert_eq!(
            fleet.bind("sess_abc", directive("fj-b", 1)).await,
            Err(BindRefusal::Conflict {
                live_handle: "fj-a".into()
            }),
            "a foreign handle must never replace a live binding"
        );
        let b = fleet.binding("sess_abc").expect("A still bound");
        assert_eq!(b.handle_id, "fj-a", "A's binding survives");
        assert_eq!(
            cbs(&pria).iter().filter(|c| c["kind"] == "ack").count(),
            1,
            "the intruder must not be acked: {:?}",
            cbs(&pria)
        );

        // A's heartbeat loop must NOT have been aborted by the refusal.
        let before = cbs(&pria).len();
        tokio::time::sleep(Duration::from_millis(120)).await;
        let after = cbs(&pria);
        assert!(
            after.len() > before
                && after.iter().any(|c| {
                    c["kind"] == "heartbeat" && c["handle_id"] == "fj-a"
                }),
            "A's heartbeat must survive the refused foreign bind: {after:?}"
        );

        // A completes normally; fj-b never appears in any callback.
        fleet.mark_running("sess_abc");
        fleet.on_agent_end("sess_abc").await; // burn
        fleet.on_agent_end("sess_abc").await; // mint
        let rs = results(&pria);
        assert_eq!(rs.len(), 1, "exactly one result, A's: {rs:?}");
        assert_eq!(rs[0]["handle_id"], "fj-a");
        assert!(
            cbs(&pria).iter().all(|c| c["handle_id"] != "fj-b"),
            "fj-b must never emit anything: {:?}",
            cbs(&pria)
        );
    }

    /// F6.3d — a CLEARED binding frees the session: after a minted result (or
    /// teardown) any handle may bind fresh.
    #[tokio::test]
    async fn f6_3d_cleared_binding_frees_session_for_any_handle() {
        let (pria, fleet) = fleet();
        fleet
            .bind("sess_abc", directive("fj-a", 1))
            .await
            .expect("A binds a free session");
        fleet.mark_running("sess_abc");
        fleet.on_agent_end("sess_abc").await; // burn
        fleet.on_agent_end("sess_abc").await; // mint + clear
        assert!(fleet.binding("sess_abc").is_none(), "A cleared");

        fleet
            .bind("sess_abc", directive("fj-b", 1))
            .await
            .expect("a result-cleared session accepts any handle");
        assert_eq!(fleet.binding("sess_abc").unwrap().handle_id, "fj-b");

        // Teardown also frees.
        fleet.on_session_closed("sess_abc").await;
        fleet
            .bind("sess_abc", directive("fj-c", 9))
            .await
            .expect("a teardown-cleared session accepts any handle");
        assert_eq!(fleet.binding("sess_abc").unwrap().handle_id, "fj-c");
        assert_eq!(
            cbs(&pria).last().unwrap()["kind"],
            "ack",
            "fresh binds on a freed session ack normally"
        );
    }
}
