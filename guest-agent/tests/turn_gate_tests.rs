//! F6.2 born-RED fence — the per-session turn gate — plus the F6.3
//! binding-conflict law at the send surface.
//!
//! LIVE FINDING (2026-08-21 01:34-01:50Z, board "F6.2 GAP", staging
//! sess_BxJ8NnCUOoVU / fj-63df5428): the guest `send` route writes prompts
//! STRAIGHT to the SynapsCLI stdin with zero turn awareness, and SynapsCLI
//! silently DROPS prompt messages that arrive mid-turn. Pria's W3.8
//! dispatcher sends the work-start brief ~50ms after set_task, while the
//! set_task turn is still streaming → the brief is always dropped → the job
//! heartbeats forever and never completes (fj-63df5428 sat 16 min after
//! exactly ONE metered agent_end; a manual prompt to the then-idle session
//! minted `result` in 10s). The F6.1 skip fence counted turns perfectly;
//! DELIVERY is the hole. The same hole silently eats user chat sends against
//! a busy session — a pre-existing product bug.
//!
//! The fence demands (implementation is NOT here):
//!   * Per-session busy state from the moment a TURN is written to stdin
//!     until that turn's `agent_end`. Turn-sends while busy are BUFFERED
//!     (bounded FIFO, cap 4); each `agent_end` flushes exactly one. A full
//!     queue REFUSES the send with the existing stdin-unavailable error class
//!     (`session_not_found`) — never a silent drop.
//!   * CLASSIFY AT THE WRITE POINT: fleet notification (`bind` /
//!     `mark_running`) fires when the bytes are WRITTEN — direct-write time
//!     for an idle session, flush time for a dequeued one — keeping the F6.1
//!     skip count aligned with the turn that actually runs next. The ack for
//!     a directive queued behind a live turn is deferred to the flush.
//!   * ControlFrames (set_model) write through immediately, busy or not:
//!     never queued, never busy-marking, never burning skip (E3).
//!   * Teardown (close/cancel/EOF) drops the gate state: queue cleared, no
//!     posthumous flush; fleet teardown callbacks untouched.
//!   * F6.3 at this surface: a foreign-handle set_task against a session with
//!     a live binding is refused with HTTP 409 `binding_conflict`, never
//!     written to stdin, never acked, and disturbs neither the live binding
//!     nor the buffered-prompt queue.
//!
//! Idioms mirror tests/fleet_envelope_tests.rs exactly (test_support::
//! test_env, FakePriaClient recorder, FakeLauncher/FakeProcess.sent, tower
//! oneshot, byte-real field-ordered envelopes). `agent_end` is driven through
//! `AppState.gate.on_agent_end` — the composed seam the stdout relay calls
//! (fleet state machine first, then the gate flush); the relay itself is not
//! drivable under FakeLauncher (see the F4 SEAM HONESTY NOTE).

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use tower::ServiceExt;

use pria_guest_agent::api::build_router;
use pria_guest_agent::fleet::FleetDirective;
use pria_guest_agent::os::{FakeUserManager, UserRecord};
use pria_guest_agent::pria_client::fake::FakePriaClient;
use pria_guest_agent::synaps::launcher::FakeLauncher;
use pria_guest_agent::test_support::{test_env, TestEnv};

// ── helpers (mirroring tests/fleet_envelope_tests.rs) ────────────────────────

fn post(uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn test_uid() -> u32 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata("/proc/self")
        .map(|m| m.uid())
        .expect("read /proc/self for caller uid")
}

fn test_username() -> String {
    format!("pria_u_{}", test_uid())
}

fn active_user_os() -> Arc<FakeUserManager> {
    Arc::new(FakeUserManager::default().with_user(UserRecord {
        username: test_username(),
        uid: test_uid(),
        gid: test_uid(),
        active: true,
    }))
}

fn start_body(env: &TestEnv) -> serde_json::Value {
    let ws = env.efs_root.join("instances/inst_456/workspace");
    let sd = env.efs_root.join("sessions/sess_abc");
    json!({
        "account_id": "acct_123", "instance_id": "inst_456", "user_id": "user_789",
        "session_id": "sess_abc", "vm_id": "vm_456",
        "linux_username": test_username(), "uid": test_uid(), "gid": test_uid(),
        "workspace_dir": ws.to_string_lossy(), "session_dir": sd.to_string_lossy(),
        "roles": ["agent_operator"], "transport": {"kind": "pria-agent-websocket"},
        "request_id": "req_1"
    })
}

async fn started() -> (axum::Router, Arc<FakeLauncher>, Arc<FakePriaClient>, TestEnv) {
    let pria = Arc::new(FakePriaClient::default());
    let launcher = Arc::new(FakeLauncher::default());
    let env = test_env(pria.clone(), active_user_os(), launcher.clone());
    let router = build_router(env.state.clone());
    let resp = router
        .clone()
        .oneshot(post("/guest/v1/sessions/start", start_body(&env)))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "session start must succeed");
    (router, launcher, pria, env)
}

/// Send and return `(status, parsed body)` — rows that fence refusals need
/// the non-2xx path, unlike the envelope fence's always-OK helper.
async fn send_raw(router: &axum::Router, input: &str) -> (StatusCode, Value) {
    let resp = router
        .clone()
        .oneshot(post(
            "/guest/v1/sessions/sess_abc/send",
            json!({ "input": input }),
        ))
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    (status, body)
}

/// Send that must be ACCEPTED (written or buffered — both ack 200).
async fn send_ok(router: &axum::Router, input: &str) {
    let (status, body) = send_raw(router, input).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "send must be accepted (written or buffered): {body:?}"
    );
}

const DIGEST_HEX: &str = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

/// Handle A — the live staging shape.
const HANDLE_A: &str = "fj-cfb6b8b8-cb1f-48cd-bedb-0b6dbf8283d0";
/// Handle B — the foreign intruder of the F6.3 livelock.
const HANDLE_B: &str = "fj-8d7c1e71-2f4a-4a10-9d55-3f61c0a7b9e2";

fn fleet_wire(handle: &str, generation: &str) -> String {
    format!("set_task vault-curator@1\ndigest sha256:{DIGEST_HEX}\nfleet {handle} {generation}")
}

#[derive(Serialize)]
struct PromptEnvelope<'a> {
    r#type: &'a str,
    id: &'a str,
    message: &'a str,
    attachments: [(); 0],
}

#[derive(Serialize)]
struct SetModelEnvelope<'a> {
    r#type: &'a str,
    id: &'a str,
    model: &'a str,
}

fn prompt_envelope(message: &str) -> String {
    serde_json::to_string(&PromptEnvelope {
        r#type: "prompt",
        id: "p_0a1b2c3d4e5f",
        message,
        attachments: [],
    })
    .unwrap()
}

fn set_model_envelope(model: &str) -> String {
    serde_json::to_string(&SetModelEnvelope {
        r#type: "set_model",
        id: "m_0a1b2c3d",
        model,
    })
    .unwrap()
}

fn set_task_envelope(handle: &str, generation: &str) -> String {
    prompt_envelope(&fleet_wire(handle, generation))
}

fn fleet_cbs(pria: &FakePriaClient) -> Vec<Value> {
    pria.fleet_callbacks.lock().unwrap().clone()
}

fn results(pria: &FakePriaClient) -> Vec<Value> {
    fleet_cbs(pria)
        .into_iter()
        .filter(|c| c["kind"] == "result")
        .collect()
}

fn sent_inputs(launcher: &FakeLauncher) -> Vec<String> {
    launcher.launched.lock().unwrap()[0]
        .sent
        .lock()
        .unwrap()
        .clone()
}

// ── F6.2a — idle session: direct write, byte-verbatim, busy set ──────────────

/// A prompt against an idle session writes to stdin immediately and
/// byte-verbatim (today's bytes, today's timing) AND marks the session busy.
#[tokio::test]
async fn f6_2a_idle_session_prompt_writes_immediately_and_marks_busy() {
    let (router, launcher, _pria, env) = started().await;
    let p = prompt_envelope("hello there");
    send_ok(&router, &p).await;

    assert_eq!(sent_inputs(&launcher), vec![p], "byte-verbatim direct write");
    assert!(
        env.state.gate.busy("sess_abc"),
        "a written prompt turn must mark the session busy until its agent_end"
    );
    assert_eq!(env.state.gate.pending_len("sess_abc"), 0);
}

// ── F6.2b — THE RED ROW: the W3.8 sequence, delivery half ────────────────────

/// set_task written (ack at write) → brief arrives MID-TURN → NOT written
/// (this is the live silent drop) but buffered → set_task turn's agent_end
/// burns the F6.1 skip AND flushes the brief exactly once → the brief turn's
/// agent_end mints `result {ok:true}` exactly once.
#[tokio::test]
async fn f6_2b_brief_sent_mid_turn_is_buffered_then_flushed_exactly_once() {
    let (router, launcher, pria, env) = started().await;
    let st = set_task_envelope(HANDLE_A, "1");
    let brief = prompt_envelope("curate the vault as briefed");

    send_ok(&router, &st).await;
    assert_eq!(sent_inputs(&launcher), vec![st.clone()], "set_task written");
    assert_eq!(fleet_cbs(&pria).len(), 1, "ack at write time");

    // The brief lands while the set_task turn streams. TODAY it is written
    // mid-turn and the CLI silently drops it — the job never completes.
    send_ok(&router, &brief).await;
    assert_eq!(
        sent_inputs(&launcher),
        vec![st.clone()],
        "the brief must NOT be written mid-turn (the CLI drops it silently)"
    );
    assert!(env.state.gate.busy("sess_abc"), "set_task turn streaming");
    assert_eq!(env.state.gate.pending_len("sess_abc"), 1, "brief buffered");

    // The set_task turn ends: skip burned (no result), brief flushed — once.
    env.state.gate.on_agent_end("sess_abc").await;
    assert!(
        results(&pria).is_empty(),
        "the set_task turn's end must never mint (F6.1 law intact under the gate)"
    );
    assert_eq!(
        sent_inputs(&launcher),
        vec![st, brief],
        "the brief is written EXACTLY ONCE, after the set_task turn's end"
    );
    assert!(env.state.gate.busy("sess_abc"), "the brief turn now streams");
    assert_eq!(env.state.gate.pending_len("sess_abc"), 0);

    // The brief turn ends: exactly one result, ok:true, handle A.
    env.state.gate.on_agent_end("sess_abc").await;
    let rs = results(&pria);
    assert_eq!(rs.len(), 1, "exactly one minted result: {rs:?}");
    assert_eq!(rs[0]["handle_id"], HANDLE_A);
    assert_eq!(rs[0]["payload"]["ok"], true);
    assert!(env.state.fleet.binding("sess_abc").is_none(), "cleared");
    assert!(!env.state.gate.busy("sess_abc"), "idle after the flush drained");
}

// ── F6.2c — ControlFrames write through, are never turns ─────────────────────

/// set_model writes through immediately — idle (no busy mark) AND mid-turn
/// (never queued) — and never burns skip: the set_task turn's end after a
/// mid-turn set_model still only burns the debt, and the brief still mints
/// exactly once (no count drift, no preamble starvation).
#[tokio::test]
async fn f6_2c_set_model_writes_through_mid_turn_never_queues_never_counts() {
    let (router, launcher, pria, env) = started().await;
    let sm1 = set_model_envelope("claude-sonnet-4-6");
    let st = set_task_envelope(HANDLE_A, "1");
    let sm2 = set_model_envelope("claude-opus-4-2");
    let brief = prompt_envelope("curate the vault as briefed");

    // Idle: control frame writes through and does NOT mark busy.
    send_ok(&router, &sm1).await;
    assert_eq!(sent_inputs(&launcher), vec![sm1.clone()]);
    assert!(!env.state.gate.busy("sess_abc"), "a control frame is not a turn");

    // Turn starts; a mid-turn control frame still writes through immediately.
    send_ok(&router, &st).await;
    assert!(env.state.gate.busy("sess_abc"));
    send_ok(&router, &sm2).await;
    assert_eq!(
        sent_inputs(&launcher),
        vec![sm1.clone(), st.clone(), sm2.clone()],
        "set_model preambles must not queue behind turns (the CLI accepts \
         control frames mid-turn)"
    );
    assert_eq!(env.state.gate.pending_len("sess_abc"), 0, "never queued");

    // The set_task turn's end: burns the debt, flushes nothing, clears busy.
    env.state.gate.on_agent_end("sess_abc").await;
    assert!(results(&pria).is_empty(), "no mint — debt burned, not drifted");
    assert!(!env.state.gate.busy("sess_abc"), "no phantom flush");
    assert_eq!(sent_inputs(&launcher).len(), 3, "nothing new written");

    // The brief then runs and mints exactly once — the control frames never
    // entered the turn count.
    send_ok(&router, &brief).await;
    env.state.gate.on_agent_end("sess_abc").await;
    let rs = results(&pria);
    assert_eq!(rs.len(), 1, "exactly one result: {rs:?}");
    assert_eq!(rs[0]["payload"]["ok"], true);
}

// ── F6.2d — bounded queue, fail-closed refusal ───────────────────────────────

/// Four turns buffer behind a streaming turn; the FIFTH is refused with the
/// existing stdin-unavailable error class (`session_not_found`) so Pria's
/// checked delivery fails closed — nothing is silently dropped. The queue
/// then drains strictly FIFO.
#[tokio::test]
async fn f6_2d_fifth_buffered_turn_refused_queue_drains_fifo() {
    let (router, launcher, _pria, env) = started().await;
    let st = set_task_envelope(HANDLE_A, "1");
    send_ok(&router, &st).await;

    let prompts: Vec<String> = (1..=4)
        .map(|i| prompt_envelope(&format!("buffered turn {i}")))
        .collect();
    for p in &prompts {
        send_ok(&router, p).await;
    }
    assert_eq!(env.state.gate.pending_len("sess_abc"), 4, "queue at cap");
    assert_eq!(sent_inputs(&launcher), vec![st.clone()], "none written yet");

    // The fifth: refused loudly, with the class the stdin-unavailable path
    // already uses — Pria's checked delivery sees not-ok, the row requeues.
    let fifth = prompt_envelope("one too many");
    let (status, body) = send_raw(&router, &fifth).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "full queue must refuse with the existing stdin-unavailable class, \
         not silently drop: {body:?}"
    );
    assert_eq!(body["error"]["code"], "session_not_found");
    assert_eq!(env.state.gate.pending_len("sess_abc"), 4, "cap held");
    assert_eq!(sent_inputs(&launcher), vec![st.clone()], "fifth never written");

    // Drain: one flush per agent_end, strictly FIFO.
    for _ in 0..4 {
        env.state.gate.on_agent_end("sess_abc").await;
    }
    let mut expect = vec![st];
    expect.extend(prompts);
    assert_eq!(sent_inputs(&launcher), expect, "FIFO flush order");
    assert_eq!(env.state.gate.pending_len("sess_abc"), 0);
}

// ── F6.2e — redispatch-onto-busy: classify/notify at the WRITE point ─────────

/// The count-drift leg: a gen-2 set_task (same handle — requeue redispatch)
/// and its brief arrive while the gen-1 brief turn is still streaming. Both
/// buffer. The bind/ack for the gen-2 directive fires at its FLUSH, not at
/// HTTP receipt — receipt-time binding would let the streaming gen-1 turn's
/// end mint gen 2 prematurely. The gen-2 set_task turn's end burns its OWN
/// fresh skip; the gen-2 brief turn's end mints for gen 2 exactly once.
#[tokio::test]
async fn f6_2e_redispatch_onto_busy_session_binds_at_flush_not_receipt() {
    let (router, launcher, pria, env) = started().await;
    let st1 = set_task_envelope(HANDLE_A, "1");
    let brief1 = prompt_envelope("gen-1 brief");
    let st2 = set_task_envelope(HANDLE_A, "2");
    let brief2 = prompt_envelope("gen-2 brief");

    // Gen 1 runs normally: set_task written+acked, its turn ends (skip
    // burned), the brief written and streaming.
    send_ok(&router, &st1).await;
    env.state.gate.on_agent_end("sess_abc").await;
    send_ok(&router, &brief1).await;
    assert_eq!(fleet_cbs(&pria).len(), 1, "just gen-1's ack so far");

    // The redispatch lands mid-turn: BOTH buffer, NOTHING binds at receipt.
    send_ok(&router, &st2).await;
    assert_eq!(
        fleet_cbs(&pria).len(),
        1,
        "the gen-2 ack must be deferred to the FLUSH — receipt-time binding \
         is the premature-mint (count-drift) leg: {:?}",
        fleet_cbs(&pria)
    );
    assert!(env.state.gate.busy("sess_abc"), "gen-1 brief turn streaming");
    assert_eq!(
        env.state.fleet.binding("sess_abc").expect("gen 1 still bound").generation,
        1,
        "receipt of a buffered directive must not touch the live binding"
    );
    send_ok(&router, &brief2).await;
    assert_eq!(env.state.gate.pending_len("sess_abc"), 2);
    assert_eq!(sent_inputs(&launcher), vec![st1.clone(), brief1.clone()]);

    // end#1 — the gen-1 brief turn: mints gen 1, THEN flushes the gen-2
    // set_task, whose bind/ack fires now (fresh skip debt).
    env.state.gate.on_agent_end("sess_abc").await;
    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs.len(), 3, "gen-1 result + gen-2 ack at flush: {cbs:?}");
    assert_eq!(cbs[1]["kind"], "result");
    assert_eq!(cbs[1]["generation"], 1);
    assert_eq!(cbs[1]["payload"]["ok"], true);
    assert_eq!(cbs[2]["kind"], "ack");
    assert_eq!(cbs[2]["generation"], 2);
    assert_eq!(
        sent_inputs(&launcher),
        vec![st1.clone(), brief1.clone(), st2.clone()],
        "FIFO: the gen-2 set_task flushes first"
    );

    // end#2 — the gen-2 set_task turn: burns its OWN fresh skip (no mint),
    // flushes the gen-2 brief.
    env.state.gate.on_agent_end("sess_abc").await;
    assert_eq!(results(&pria).len(), 1, "gen-2 directive turn end is silent");
    assert_eq!(sent_inputs(&launcher), vec![st1, brief1, st2, brief2]);

    // end#3 — the gen-2 brief turn: mints for gen 2, exactly once.
    env.state.gate.on_agent_end("sess_abc").await;
    let rs = results(&pria);
    assert_eq!(rs.len(), 2, "exactly one result per generation: {rs:?}");
    assert_eq!(rs[1]["generation"], 2);
    assert_eq!(rs[1]["payload"]["ok"], true);
    assert!(env.state.fleet.binding("sess_abc").is_none(), "cleared");
}

// ── F6.2f — teardown with pending: no posthumous writes ──────────────────────

/// Close with a non-empty queue: the queue is dropped (no zombie flush), the
/// fleet teardown callback is unchanged (exactly one session_closed result),
/// and a late agent_end writes nothing.
#[tokio::test]
async fn f6_2f_teardown_drops_pending_queue_no_posthumous_writes() {
    let (router, launcher, pria, env) = started().await;
    let st = set_task_envelope(HANDLE_A, "1");
    let brief = prompt_envelope("never to run");
    send_ok(&router, &st).await;
    send_ok(&router, &brief).await;
    assert_eq!(env.state.gate.pending_len("sess_abc"), 1, "brief buffered");

    let resp = router
        .clone()
        .oneshot(post(
            "/guest/v1/sessions/sess_abc/close",
            json!({ "reason": "user_closed", "grace_period_ms": 0 }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Fleet teardown callback untouched: exactly one session_closed result.
    let rs = results(&pria);
    assert_eq!(rs.len(), 1, "exactly one teardown result: {rs:?}");
    assert_eq!(rs[0]["payload"]["error"]["code"], "session_closed");

    // Gate state dropped: queue cleared, not busy, and a late agent_end
    // (the dying child's final frame) must not flush the dead brief.
    assert_eq!(env.state.gate.pending_len("sess_abc"), 0, "queue dropped");
    assert!(!env.state.gate.busy("sess_abc"));
    env.state.gate.on_agent_end("sess_abc").await;
    assert_eq!(
        sent_inputs(&launcher),
        vec![st],
        "no posthumous writes after teardown"
    );
    assert_eq!(results(&pria).len(), 1, "no further fleet emissions");
}

// ── F6.2g — agent_end with empty pending: busy clears cleanly ────────────────

/// No wedged-busy sessions: an agent_end with nothing buffered clears busy,
/// and the next send writes directly again.
#[tokio::test]
async fn f6_2g_agent_end_with_empty_queue_clears_busy_next_send_direct() {
    let (router, launcher, _pria, env) = started().await;
    let p1 = prompt_envelope("first turn");
    let p2 = prompt_envelope("second turn");

    send_ok(&router, &p1).await;
    assert!(env.state.gate.busy("sess_abc"));

    env.state.gate.on_agent_end("sess_abc").await;
    assert!(!env.state.gate.busy("sess_abc"), "busy clears on empty queue");

    send_ok(&router, &p2).await;
    assert_eq!(
        sent_inputs(&launcher),
        vec![p1, p2],
        "the next send after idle writes directly"
    );
    assert!(env.state.gate.busy("sess_abc"), "and marks busy again");
}

// ── F6.3e — foreign-handle set_task refused at the send surface ──────────────

/// A set_task for handle B against a session with a LIVE binding for handle A
/// must be refused with HTTP 409 `binding_conflict`: not written to stdin,
/// not acked, A's binding/heartbeat/debt untouched — A then completes
/// normally. Today B replaces A and the two handles livelock (fj-8d7c1e71).
#[tokio::test]
async fn f6_3e_foreign_set_task_refused_409_binding_conflict_a_completes() {
    let (router, launcher, pria, env) = started().await;
    let st_a = set_task_envelope(HANDLE_A, "1");
    let st_b = set_task_envelope(HANDLE_B, "1");
    let brief = prompt_envelope("curate the vault as briefed");

    send_ok(&router, &st_a).await;
    env.state.gate.on_agent_end("sess_abc").await; // A's set_task turn ends: idle, A live (Acked)

    let (status, body) = send_raw(&router, &st_b).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a foreign set_task against a live binding must fail the dispatch \
         leg closed: {body:?}"
    );
    assert_eq!(body["error"]["code"], "binding_conflict");
    assert_eq!(
        sent_inputs(&launcher),
        vec![st_a.clone()],
        "a refused directive must never reach the CLI stdin"
    );
    let b = env.state.fleet.binding("sess_abc").expect("A still bound");
    assert_eq!(b.handle_id, HANDLE_A, "A's binding undisturbed");
    assert_eq!(
        fleet_cbs(&pria).iter().filter(|c| c["kind"] == "ack").count(),
        1,
        "the intruder must not be acked"
    );

    // A completes exactly once — the refusal disturbed no state.
    send_ok(&router, &brief).await;
    env.state.gate.on_agent_end("sess_abc").await;
    let rs = results(&pria);
    assert_eq!(rs.len(), 1, "exactly one result, A's: {rs:?}");
    assert_eq!(rs[0]["handle_id"], HANDLE_A);
    assert_eq!(rs[0]["payload"]["ok"], true);
}

// ── F6.3f — refusal while busy: the buffered queue is unaffected ─────────────

/// A live binding for A with its brief already buffered behind the streaming
/// set_task turn: the foreign set_task B is refused AT RECEIPT (409, never
/// queued — a doomed directive must not occupy a queue slot and fail silently
/// at flush), the queue and A's choreography proceed untouched.
#[tokio::test]
async fn f6_3f_foreign_set_task_while_busy_refused_queue_unaffected() {
    let (router, launcher, pria, env) = started().await;
    let st_a = set_task_envelope(HANDLE_A, "1");
    let brief_a = prompt_envelope("A's brief");
    let st_b = set_task_envelope(HANDLE_B, "1");

    send_ok(&router, &st_a).await; // streaming
    send_ok(&router, &brief_a).await; // buffered
    assert_eq!(env.state.gate.pending_len("sess_abc"), 1);

    let (status, body) = send_raw(&router, &st_b).await;
    assert_eq!(status, StatusCode::CONFLICT, "refused at receipt: {body:?}");
    assert_eq!(body["error"]["code"], "binding_conflict");
    assert_eq!(
        env.state.gate.pending_len("sess_abc"),
        1,
        "the refused foreign directive must not touch the buffered queue"
    );
    assert_eq!(sent_inputs(&launcher), vec![st_a.clone()]);

    // A's choreography is intact: burn+flush, then mint — exactly once.
    env.state.gate.on_agent_end("sess_abc").await;
    assert_eq!(sent_inputs(&launcher), vec![st_a, brief_a], "brief flushed");
    env.state.gate.on_agent_end("sess_abc").await;
    let rs = results(&pria);
    assert_eq!(rs.len(), 1, "exactly one result, A's: {rs:?}");
    assert_eq!(rs[0]["handle_id"], HANDLE_A);
}

// ── F6.3g — flush-time refusal: fail closed, keep draining ───────────────────

/// The race the receipt check cannot cover: a directive was queued while the
/// session carried NO binding, and a binding appeared before its flush (SEAM
/// HONESTY: the binding is injected through `FleetBindings::bind` directly —
/// the E3/F7 idiom — because the send surface now refuses the racing bind at
/// receipt). At flush the bind is refused: the directive is DROPPED without
/// ever reaching stdin (an unbound set_task turn must not run), it is never
/// acked, and the flush continues FIFO to the next buffered turn — the gate
/// must not wedge.
#[tokio::test]
async fn f6_3g_flush_time_bind_refusal_drops_directive_and_keeps_draining() {
    let (router, launcher, pria, env) = started().await;
    let p1 = prompt_envelope("plain streaming turn");
    let st_b = set_task_envelope(HANDLE_B, "1");
    let p2 = prompt_envelope("queued behind the doomed directive");

    send_ok(&router, &p1).await; // streaming, NO binding yet
    send_ok(&router, &st_b).await; // queued (no live binding at receipt)
    send_ok(&router, &p2).await; // queued behind it
    assert_eq!(env.state.gate.pending_len("sess_abc"), 2);

    // The race: handle A binds while B sits in the queue.
    env.state
        .fleet
        .bind(
            "sess_abc",
            FleetDirective {
                handle_id: HANDLE_A.into(),
                generation: 1,
                workspace: None,
            },
        )
        .await
        .expect("A binds the free session");

    // p1's end: flush pops B → bind refused (A live) → B dropped, NOT
    // written; the flush continues to p2 in the same drain step.
    env.state.gate.on_agent_end("sess_abc").await;
    assert_eq!(
        sent_inputs(&launcher),
        vec![p1, p2],
        "the refused directive must never reach stdin; the next turn flushes"
    );
    assert_eq!(env.state.gate.pending_len("sess_abc"), 0);
    assert!(env.state.gate.busy("sess_abc"), "p2 streaming — not wedged");
    assert!(
        fleet_cbs(&pria)
            .iter()
            .all(|c| c["handle_id"] != HANDLE_B),
        "the dropped directive must never ack: {:?}",
        fleet_cbs(&pria)
    );
    let b = env.state.fleet.binding("sess_abc").expect("A still bound");
    assert_eq!(b.handle_id, HANDLE_A);
}
