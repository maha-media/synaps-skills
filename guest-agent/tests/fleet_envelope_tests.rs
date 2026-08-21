//! W3.7-G fence extension — fleet envelope sniff (LIVE staging finding, leg-4).
//!
//! STANDING LESSON (the "live-shaped fence" lesson): fences must feed the seam
//! what production actually delivers, not what the sim delivers. The original
//! fleet fence (tests/fleet_callback_tests.rs F1-F3) fed RAW W3.7-P wire text
//! into `SendRequest.input` — sim-shaped, never occurs live.
//!
//! FINDING (leg-4 staging): Pria does NOT deliver raw wire text in
//! `SendRequest.input`. The live body is `{"input": "<one JSON-RPC line>"}`
//! where the line is one of exactly two envelopes (pria-ui
//! routes/agents/agentChat.js `sendPromptToSession` + guestAgentClient.js):
//!
//!   prompt:    {"type":"prompt","id":"p_<12 lowercase hex>","message":"<wire text>","attachments":[]}
//!   set_model: {"type":"set_model","id":"m_<8 lowercase hex>","model":"<model id>"}
//!
//! The fleet wire text rides INSIDE `message`:
//!   `set_task vault-curator@1\ndigest sha256:<64hex>\nfleet fj-<uuid> 1`
//!
//! On live staging the union guest booted, the model received and echoed the
//! fleet line (transcript proof), but ZERO fleet callbacks were attempted —
//! `parse_fleet_directive` (called on the raw input at
//! src/api/sessions.rs::send) sees a first line of `{"type":"prompt"…` and
//! never matches.
//!
//! This fence demands (implementation is NOT here):
//!   * ENVELOPE SNIFF at the send choke point: when `input` parses as a JSON
//!     object with `type=="prompt"` and a string `message`, fleet detection
//!     runs against the EXTRACTED message; the process still receives the
//!     ENVELOPE string byte-identical (never the extracted message — the agent
//!     runtime consumes the envelope, not us).
//!   * RULING (E3, pinned): only `type=="prompt"` envelopes advance the
//!     Acked→Running state machine — control frames (set_model) are NOT turns.
//!     If a control frame marked Running, that frame's own turn-end would mint
//!     a `result` before the brief ever arrived. A set_model envelope also
//!     never binds, whatever fleet-looking text its `model` string carries.
//!   * FALL-THROUGH (E4): non-JSON, malformed-JSON, and unknown-type inputs
//!     take the EXISTING raw-text parse byte-identically — the original F1
//!     behavior must survive the change untouched.
//!
//! Test idioms mirror tests/fleet_callback_tests.rs exactly (test_support::
//! test_env, FakePriaClient recorder Vec, FakeLauncher/FakeProcess.sent, tower
//! ServiceExt oneshot against build_router). Envelopes are composed with
//! serde_json Serialize on field-ordered structs so key order and escaping are
//! byte-real (JS JSON.stringify insertion order: type,id,message,attachments).

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

// ── helpers (mirroring tests/fleet_callback_tests.rs) ────────────────────────

fn post(uri: &str, body: serde_json::Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// The uid these tests run as (mirrors tests/sessions_tests.rs): the start
/// handler chowns the per-UID Synaps socket dir and VERIFIES it retained that
/// owner, so a fictional fixture uid is unreachable without root.
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

/// Start `sess_abc` through the router and return (router, launcher, pria, env).
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

async fn send(router: &axum::Router, input: &str) {
    let resp = router
        .clone()
        .oneshot(post(
            "/guest/v1/sessions/sess_abc/send",
            json!({ "input": input }),
        ))
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "fleet parsing must never block forwarding"
    );
}

const DIGEST_HEX: &str = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

/// The exact live handle observed in the leg-4 staging transcript.
const LIVE_HANDLE: &str = "fj-cfb6b8b8-cb1f-48cd-bedb-0b6dbf8283d0";

/// W3.7-P three-line fleet dispatch wire text — as it appears INSIDE
/// `message` on live (slug from the staging transcript).
fn fleet_wire(handle: &str, generation: &str) -> String {
    format!("set_task vault-curator@1\ndigest sha256:{DIGEST_HEX}\nfleet {handle} {generation}")
}

// ── byte-real envelope composition ───────────────────────────────────────────
//
// Field-ordered Serialize structs, NOT the json! macro: serde_json Value maps
// sort keys alphabetically, but live JS JSON.stringify preserves insertion
// order (type,id,message,attachments). Struct serialization preserves field
// order and gives real escaping for the embedded newlines.

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

/// {"type":"prompt","id":"p_<12 lowercase hex>","message":…,"attachments":[]}
fn prompt_envelope(message: &str) -> String {
    serde_json::to_string(&PromptEnvelope {
        r#type: "prompt",
        id: "p_0a1b2c3d4e5f",
        message,
        attachments: [],
    })
    .unwrap()
}

/// {"type":"set_model","id":"m_<8 lowercase hex>","model":…}
fn set_model_envelope(model: &str) -> String {
    serde_json::to_string(&SetModelEnvelope {
        r#type: "set_model",
        id: "m_0a1b2c3d",
        model,
    })
    .unwrap()
}

/// Snapshot of the sanctioned recorder Vec (mirrors `session_events` idiom).
fn fleet_cbs(pria: &FakePriaClient) -> Vec<Value> {
    pria.fleet_callbacks.lock().unwrap().clone()
}

/// The full input text the FakeProcess received for launch `idx` — passthrough
/// must be byte-identical (the ENVELOPE, never the extracted message).
fn sent_inputs(launcher: &FakeLauncher, idx: usize) -> Vec<String> {
    launcher.launched.lock().unwrap()[idx]
        .sent
        .lock()
        .unwrap()
        .clone()
}

// ── E1: prompt envelope binds + acks, envelope forwarded byte-identical ──────

/// Fences the LIVE gap: fleet detection must run against the prompt envelope's
/// EXTRACTED `message`, not the raw input (whose first line is
/// `{"type":"prompt"…` and never matches `set_task `). Exactly one `ack` under
/// the live handle/generation; the process receives the ENVELOPE string
/// byte-identical — never the extracted message.
#[tokio::test]
async fn e1_prompt_envelope_with_fleet_message_acks_and_forwards_envelope_unchanged() {
    let (router, launcher, pria, env) = started().await;
    let wire = fleet_wire(LIVE_HANDLE, "1");
    let envelope = prompt_envelope(&wire);
    // Sanity on the fixture itself: byte-real escaping, single line, live shape.
    assert!(envelope.starts_with(r#"{"type":"prompt","id":"p_0a1b2c3d4e5f","message":"set_task vault-curator@1\ndigest sha256:"#));
    assert!(!envelope.contains('\n'), "the envelope is ONE JSON line");

    send(&router, &envelope).await;

    let cbs = fleet_cbs(&pria);
    assert_eq!(
        cbs.len(),
        1,
        "exactly one fleet callback (the ack) for the live envelope shape — \
         zero here is the leg-4 staging failure: {cbs:?}"
    );
    assert_eq!(cbs[0]["kind"], "ack");
    assert_eq!(cbs[0]["session_id"], "sess_abc");
    assert_eq!(cbs[0]["handle_id"], LIVE_HANDLE);
    assert_eq!(cbs[0]["generation"], 1);
    let b = env.state.fleet.binding("sess_abc").expect("bound");
    assert_eq!(b.handle_id, LIVE_HANDLE);
    assert_eq!(b.generation, 1);

    // The ENVELOPE goes to the process byte-identical — the agent runtime
    // consumes the envelope; extraction is for detection only.
    assert_eq!(sent_inputs(&launcher, 0), vec![envelope]);
}

// ── E2a: prompt envelope without a fleet line ────────────────────────────────

/// A prompt envelope whose message carries no fleet line: zero callbacks, no
/// binding, envelope forwarded unchanged. (Guard rail — expected born-green:
/// HEAD emits nothing for ANY envelope; this row pins that the fix must not
/// over-match ordinary prompts.)
#[tokio::test]
async fn e2a_prompt_envelope_without_fleet_line_emits_nothing_and_forwards_unchanged() {
    let (router, launcher, pria, env) = started().await;
    let plain = prompt_envelope("please summarise the workspace README");
    let two_line = prompt_envelope(&format!(
        "set_task vault-curator@1\ndigest sha256:{DIGEST_HEX}"
    ));
    send(&router, &plain).await;
    // F6.2: turns are sequential — the first turn ends before the next send
    // (the gate would otherwise buffer it; delivery timing, not detection).
    env.state.gate.on_agent_end("sess_abc").await;
    send(&router, &two_line).await;

    assert!(
        fleet_cbs(&pria).is_empty(),
        "non-fleet prompt envelopes must emit no fleet callbacks"
    );
    assert!(env.state.fleet.binding("sess_abc").is_none());
    assert_eq!(sent_inputs(&launcher, 0), vec![plain, two_line]);
}

// ── E2b: the F4 choreography driven end-to-end via envelopes ─────────────────

/// Acked (via E1-style envelope; its set_task turn's own agent_end IGNORED) →
/// a second prompt envelope (the brief) marks Running → agent_end emits
/// exactly one `result {ok:true}` and clears. Same seam note as F4: the stdout
/// relay is not drivable under FakeLauncher, so agent_end is driven through
/// `TurnGate::on_agent_end` — the composed seam the relay calls per agent_end
/// frame since F6.2 (fleet state machine first, then the gate flush).
#[tokio::test]
async fn e2b_envelope_brief_marks_running_then_agent_end_mints_result_ok() {
    let (router, _launcher, pria, env) = started().await;
    send(&router, &prompt_envelope(&fleet_wire(LIVE_HANDLE, "1"))).await;
    assert_eq!(
        fleet_cbs(&pria).len(),
        1,
        "ack for the envelope-borne fleet task (the leg-4 gap)"
    );

    // The set_task turn's own agent_end must be IGNORED (state: Acked).
    env.state.gate.on_agent_end("sess_abc").await;
    assert_eq!(fleet_cbs(&pria).len(), 1, "set_task turn end is ignored");

    // The brief — ALSO an envelope on live — marks Running; no callback.
    send(&router, &prompt_envelope("curate the vault as briefed")).await;
    assert_eq!(fleet_cbs(&pria).len(), 1, "the brief emits nothing");

    env.state.gate.on_agent_end("sess_abc").await;
    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs.len(), 2, "exactly one result after the running turn");
    assert_eq!(cbs[1]["kind"], "result");
    assert_eq!(cbs[1]["handle_id"], LIVE_HANDLE);
    assert_eq!(cbs[1]["generation"], 1);
    assert_eq!(cbs[1]["payload"]["ok"], true);
    assert!(env.state.fleet.binding("sess_abc").is_none(), "cleared");
}

// ── E3: control frames are not turns ─────────────────────────────────────────

/// RULING (pinned): only `type=="prompt"` envelopes advance Acked→Running —
/// control frames (set_model) are NOT turns. Premature Running would let a
/// control frame's turn-end mint a `result` before the brief.
///
/// Prove: ack → set_model envelope → agent_end → NO result (still Acked; the
/// set_task turn's own end law holds across the control frame). Then the real
/// brief + agent_end mints exactly one result.
///
/// SEAM HONESTY: the binding is created through the `FleetBindings::bind` seam
/// (the F7/T3 idiom), NOT via an E1 envelope send — otherwise this row would
/// go red for E1's detection reason instead of isolating the ruling. At HEAD
/// the send handler calls `mark_running` for EVERY non-fleet send
/// (src/api/sessions.rs:491), so the set_model frame advances the machine and
/// this row is born-RED for the ruling's own reason.
#[tokio::test]
async fn e3_set_model_envelope_does_not_advance_acked_to_running() {
    let (router, _launcher, pria, env) = started().await;
    env.state
        .fleet
        .bind(
            "sess_abc",
            FleetDirective {
                handle_id: LIVE_HANDLE.into(),
                generation: 1,
            },
        )
        .await
        .expect("bind on a fresh session accepted");
    assert_eq!(fleet_cbs(&pria).len(), 1, "bind acks");

    // Control frame while Acked, then the set_task turn's own agent_end.
    send(&router, &set_model_envelope("claude-sonnet-4-5")).await;
    env.state.fleet.on_agent_end("sess_abc").await;
    let cbs = fleet_cbs(&pria);
    assert_eq!(
        cbs.len(),
        1,
        "RULING violated: a set_model control frame advanced Acked→Running and \
         its turn-end minted a premature result: {cbs:?}"
    );
    assert!(
        env.state.fleet.binding("sess_abc").is_some(),
        "still bound (still Acked)"
    );

    // The REAL brief then completes normally — exactly one result, ok:true.
    send(&router, &prompt_envelope("curate the vault as briefed")).await;
    env.state.fleet.on_agent_end("sess_abc").await;
    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs.len(), 2, "one result, after the real brief only");
    assert_eq!(cbs[1]["kind"], "result");
    assert_eq!(cbs[1]["payload"]["ok"], true);
}

/// A set_model envelope whose `model` string carries fleet-looking text never
/// binds — only prompt envelopes' `message` (or raw-text fall-through) is
/// fleet-sniffed. Forwarded unchanged.
#[tokio::test]
async fn e3_set_model_envelope_with_fleet_looking_model_never_binds() {
    let (router, launcher, pria, env) = started().await;
    let sneaky = set_model_envelope(&fleet_wire("fj-sneaky", "1"));
    send(&router, &sneaky).await;

    assert!(
        fleet_cbs(&pria).is_empty(),
        "set_model is a control frame — its model string is never fleet-sniffed"
    );
    assert!(env.state.fleet.binding("sess_abc").is_none());
    assert_eq!(sent_inputs(&launcher, 0), vec![sneaky]);
}

// ── E4: fall-through — the raw-text parse must survive untouched ─────────────

/// Raw three-line set_task text (the original F1 shape) still binds + acks and
/// forwards byte-identical — the envelope sniff is ADDITIVE, never replacing
/// the raw parse. (Guard rail — expected born-green at HEAD.)
#[tokio::test]
async fn e4_raw_three_line_set_task_text_still_binds_and_acks_unchanged() {
    let (router, launcher, pria, env) = started().await;
    let raw = fleet_wire("fj-raw-alpha", "7");
    send(&router, &raw).await;

    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs.len(), 1, "raw wire text still acks (F1 must survive)");
    assert_eq!(cbs[0]["kind"], "ack");
    assert_eq!(cbs[0]["handle_id"], "fj-raw-alpha");
    assert_eq!(cbs[0]["generation"], 7);
    assert!(env.state.fleet.binding("sess_abc").is_some());
    assert_eq!(sent_inputs(&launcher, 0), vec![raw]);
}

/// Malformed JSON, JSON of the wrong shape, and unknown-type envelopes fall
/// through to the raw-text parse: none of these are set_task text, so zero
/// callbacks, zero bindings, byte-identical passthrough. (Guard rail —
/// expected born-green at HEAD.)
#[tokio::test]
async fn e4_non_json_malformed_and_unknown_type_fall_through_to_raw_parse() {
    let (router, launcher, pria, env) = started().await;
    let inputs = vec![
        // Truncated JSON — must not panic or block forwarding.
        r#"{"type":"prompt","id":"p_0a1b2c3d4e5f","message":"trunca"#.to_string(),
        // Valid JSON, unknown type — not a prompt, not raw set_task text.
        r#"{"type":"mystery","id":"x_1","message":"set_task vault-curator@1"}"#.to_string(),
        // Valid JSON, no type at all.
        r#"{"message":"hello"}"#.to_string(),
        // JSON array — not an envelope object.
        r#"["prompt","fleet fj-alpha 1"]"#.to_string(),
        // Plain non-JSON prompt.
        "please summarise the workspace README".to_string(),
    ];
    for input in &inputs {
        send(&router, input).await;
        // F6.2: each (non-fleet ⇒ prompt-turn) input ends before the next
        // send, or the gate would buffer — delivery timing, not detection.
        env.state.gate.on_agent_end("sess_abc").await;
    }
    assert!(
        fleet_cbs(&pria).is_empty(),
        "fall-through inputs emit nothing"
    );
    assert!(env.state.fleet.binding("sess_abc").is_none());
    assert_eq!(sent_inputs(&launcher, 0), inputs);
}

// ── E5: envelope rebind ──────────────────────────────────────────────────────

/// A second E1-style prompt envelope with the SAME handle at a FORWARD
/// generation REPLACES the binding: ack under the new generation; the old
/// generation is silent ever after (the F5 law, proven through the live
/// envelope shape).
///
/// LAW CHANGE NOTE (F6.3): this row originally proved replacement with a
/// FOREIGN handle — that leg is now REFUSED by the binding-conflict law (the
/// fj-8d7c1e71 livelock; pinned by f6_3b/c and F6.3e/f). The replacement
/// contract this row pins survives on the one leg that remains legal: the
/// same handle stepping its generation forward (requeue redispatch).
#[tokio::test]
async fn e5_second_envelope_with_new_handle_replaces_binding_old_handle_silent() {
    let (router, _launcher, pria, env) = started().await;
    let handle = LIVE_HANDLE;
    send(&router, &prompt_envelope(&fleet_wire(handle, "1"))).await;
    // The gen-1 set_task turn ends before the redispatch arrives (F6.2:
    // turns are sequential; a mid-turn redispatch would buffer, not bind).
    env.state.gate.on_agent_end("sess_abc").await;
    send(&router, &prompt_envelope(&fleet_wire(handle, "2"))).await;

    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs.len(), 2, "one ack per envelope-borne set_task: {cbs:?}");
    assert_eq!(cbs[1]["kind"], "ack");
    assert_eq!(cbs[1]["handle_id"], handle);
    assert_eq!(cbs[1]["generation"], 2);
    let b = env.state.fleet.binding("sess_abc").expect("bound");
    assert_eq!(b.handle_id, handle);
    assert_eq!(b.generation, 2);

    // Drive the new binding to result — under gen 2, never gen 1.
    env.state.gate.on_agent_end("sess_abc").await;
    send(&router, &prompt_envelope("begin")).await;
    env.state.gate.on_agent_end("sess_abc").await;

    let cbs = fleet_cbs(&pria);
    assert_eq!(cbs.last().unwrap()["kind"], "result");
    assert_eq!(cbs.last().unwrap()["generation"], 2);
    assert!(
        cbs.iter()
            .all(|c| c["generation"] != 1 || c["kind"] == "ack"),
        "the old generation may only ever have its ack: {cbs:?}"
    );
}
