//! F7-S — the workspace lifecycle fence (charter /tmp/synaps-skills-f7-charter.md,
//! rulings R-F7-1..3; the final F7 leg).
//!
//! The three landed legs — ws-token parse (F7-P), the structural git legs
//! (F7-G: `src/fleet_git.rs`), the wire verbs (F7-W: `fleet_git_fetch` /
//! `fleet_git_push`), and the `SessionStore::dirs()` foundation — are WIRED
//! here into the lifecycle that makes "work happens in the clone" TRUE:
//!
//!   * S1 — ws-bind fetches the base bundle (exactly once, with handle/gen/
//!     session), materializes the clone under `<workspace_dir>/worktree`,
//!     queues ONE hidden steer turn (`pending_steer` returns the text exactly
//!     once), and bumps the F6.1 debt to 2 so the set_task end AND the steer
//!     end both burn before the brief's end mints.
//!   * S2 — a clean tree at the result moment emits `result {ok:true}` with
//!     ZERO pushes (no fabricated artifact — Pria's R-W5-3 law).
//!   * S3 — a dirty tree commits + bundles + pushes BEFORE the result callback
//!     (ordering law), ref `refs/vm/<handle>/result`, non-empty body; an
//!     accepted push mints `result {ok:true}`.
//!   * S4 — a refused push mints `result {ok:false, error.code=="push_refused"}`
//!     (first-cause law).
//!   * S5 — a fetch REFUSAL degrades to an honest workspace-less run: binding
//!     still acks, no clone dir, no steer, no push, `result {ok:true}`.
//!   * S6 — teardown with a dirty workspace pushes NOTHING; the F6.1d
//!     honest-failure law is intact.
//!   * S7 — an absent-ws directive is byte-identical F6: no fetch, no clone,
//!     no steer, no push.
//!   * S8 — the steer text carries the clone's ABSOLUTE PATH but never the
//!     wire token (`ws:` / `fleet <handle>`) — the token is never
//!     model-visible (R-F7-3 / the NEVER list).
//!
//! THE SEAM (born-RED at birth): `FleetBindings` gains an OPTIONAL
//! `sessions: Option<Arc<SessionStore>>` (`with_sessions`) used ONLY to read
//! `dirs()` for the clone root (SessionStore never references FleetBindings —
//! no cycle). Steer injection is NEVER a second stdin writer: `FleetBindings`
//! stages the steer text and `TurnGate::notify_and_write` consumes it
//! (`pending_steer`, once) right after a successful `bind()` and queues the
//! steer turn into its OWN pending FIFO — behind the still-streaming set_task
//! turn, before the brief. The binding carries `skip_ends = 2` from birth and
//! the TurnGate QUEUE INSERT is the assertion that the steer actually ran
//! (the queue IS the one writer; a staged steer can only be consumed there).
//!
//! Rows drive the full composed surface (real axum Router + FakeLauncher +
//! FakePriaClient + a real SessionStore — the F6.2 idiom) plus REAL git in
//! hermetic temp dirs for the clone (the F7-G idiom). For deterministic
//! ordering fences (S3's push-BEFORE-result), the direct `FleetBindings` seam
//! is driven the way the stdout relay drives it.
//!
//! Run: cargo test --test fleet_ws_lifecycle_tests f7s

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use tower::ServiceExt;

use pria_guest_agent::api::build_router;
use pria_guest_agent::fleet::{FleetBindings, FleetDirective};
use pria_guest_agent::os::{FakeUserManager, UserRecord};
use pria_guest_agent::pria_client::fake::FakePriaClient;
use pria_guest_agent::pria_client::{GitFetch, GitPush, PriaCallbackClient};
use pria_guest_agent::synaps::launcher::FakeLauncher;
use pria_guest_agent::test_support::{test_env, TestEnv};

// ── helpers (mirroring tests/turn_gate_tests.rs) ─────────────────────────────

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

async fn send_ok(router: &axum::Router, input: &str) {
    let resp = router
        .clone()
        .oneshot(post(
            "/guest/v1/sessions/sess_abc/send",
            json!({ "input": input }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "send must be accepted");
}

const DIGEST_HEX: &str = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const HANDLE: &str = "fj-cfb6b8b8-cb1f-48cd-bedb-0b6dbf8283d0";

#[derive(Serialize)]
struct PromptEnvelope<'a> {
    r#type: &'a str,
    id: &'a str,
    message: &'a str,
    attachments: [(); 0],
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

fn set_task_ws_envelope(handle: &str, generation: &str, slug: &str) -> String {
    prompt_envelope(&format!(
        "set_task vault-curator@1\ndigest sha256:{DIGEST_HEX}\nfleet {handle} {generation} ws:{slug}"
    ))
}

fn set_task_plain_envelope(handle: &str, generation: &str) -> String {
    prompt_envelope(&format!(
        "set_task vault-curator@1\ndigest sha256:{DIGEST_HEX}\nfleet {handle} {generation}"
    ))
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

fn fetches(pria: &FakePriaClient) -> Vec<Value> {
    pria.fleet_git_fetches.lock().unwrap().clone()
}

fn pushes(pria: &FakePriaClient) -> Vec<Value> {
    pria.fleet_git_pushes.lock().unwrap().clone()
}

fn sent_inputs(launcher: &FakeLauncher) -> Vec<String> {
    launcher.launched.lock().unwrap()[0]
        .sent
        .lock()
        .unwrap()
        .clone()
}

fn session_dir(env: &TestEnv) -> PathBuf {
    env.efs_root.join("sessions/sess_abc")
}

fn workspace_dir(env: &TestEnv) -> PathBuf {
    env.efs_root.join("instances/inst_456/workspace")
}

fn clone_dir(env: &TestEnv, _handle: &str) -> PathBuf {
    // W5 staging finding (fj-79b201f3): the clone lives under the agent's
    // WORKSPACE root (its reachable, uid-owned fs) — never under session_dir
    // (a root-owned, out-of-jail path the agent cannot reach). The leaf is
    // neutral (never the handle id — R-F7-3).
    workspace_dir(env).join("worktree")
}

// ── hermetic git helpers (the F7-G idiom — REAL git in temp dirs) ────────────

fn tmp(prefix: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&d).unwrap();
    d
}

fn git(args: &[&str], cwd: &Path) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap_or_else(|e| panic!("git spawn failed: {e}"));
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// The "server-side" base repo: one commit, bundled — the bytes the fake
/// Pria answers `fleet_git_fetch` with.
fn make_base_bundle() -> (PathBuf, Vec<u8>) {
    let dir = tmp("f7s-base");
    git(&["init", "-q", "-b", "main"], &dir);
    git(&["config", "user.email", "srv@pria"], &dir);
    git(&["config", "user.name", "pria"], &dir);
    fs::write(dir.join("README.md"), "base\n").unwrap();
    git(&["add", "-A"], &dir);
    git(&["commit", "-q", "-m", "base"], &dir);
    let bundle_file = tmp("f7s-bundle").join("base.bundle");
    git(
        &["bundle", "create", bundle_file.to_str().unwrap(), "main"],
        &dir,
    );
    (dir.clone(), fs::read(&bundle_file).unwrap())
}

fn program_fetch(pria: &FakePriaClient, answer: GitFetch) {
    *pria.fleet_git_fetch_answer.lock().unwrap() = Some(answer);
}

fn program_push(pria: &FakePriaClient, answer: GitPush) {
    *pria.fleet_git_push_answer.lock().unwrap() = Some(answer);
}

fn ws_directive(handle: &str, generation: u64, slug: &str) -> FleetDirective {
    FleetDirective {
        handle_id: handle.into(),
        generation,
        workspace: Some(slug.into()),
    }
}

/// A `FleetBindings` with the F7-S session seam (the `with_sessions` wiring
/// the composed AppState performs), driven directly the way the stdout relay
/// drives it — deterministic ordering for the push-before-result law.
async fn direct_fleet(env: &TestEnv, pria: Arc<FakePriaClient>) -> FleetBindings {
    FleetBindings::new(
        pria as Arc<dyn PriaCallbackClient>,
        std::time::Duration::from_secs(3600),
    )
    .with_sessions(env.state.sessions.clone())
}

// ── S1: ws-bind → fetch + clone + steer + debt bump ─────────────────────────

/// The bind half: one fetch with exactly (handle, gen, session); the clone
/// materialized under <workspace_dir>/worktree with the base tree
/// checked out; the steer text staged (readable exactly once) and carrying
/// the clone's absolute path.
#[tokio::test]
async fn f7s1_bind_fetches_clones_and_stages_the_steer() {
    let (_srv, bundle) = make_base_bundle();
    let (router, _launcher, pria, env) = started().await;
    program_fetch(&pria, GitFetch::Bundle(bundle));

    send_ok(&router, &set_task_ws_envelope(HANDLE, "1", "brandsite")).await;

    // Fetch fired exactly once, addressed by (handle, generation, session).
    let fs = fetches(&pria);
    assert_eq!(fs.len(), 1, "exactly one base-bundle fetch: {fs:?}");
    assert_eq!(fs[0]["handle_id"], HANDLE);
    assert_eq!(fs[0]["generation"], 1);
    assert_eq!(fs[0]["session_id"], "sess_abc");

    // The clone materialized under <workspace_dir>/worktree.
    let dest = clone_dir(&env, HANDLE);
    assert!(
        dest.join("README.md").exists(),
        "working tree materialized at {dest:?}"
    );
    assert_eq!(
        fs::read_to_string(dest.join("README.md")).unwrap(),
        "base\n"
    );

    // The binding acked and carries the workspace state.
    let binding = env
        .state
        .fleet
        .binding("sess_abc")
        .expect("ws binding bound");
    assert_eq!(binding.workspace_slug().as_deref(), Some("brandsite"));
    assert!(
        fleet_cbs(&pria).iter().any(|c| c["kind"] == "ack"),
        "ws bind still acks"
    );

    // The steer text was staged with the ABSOLUTE clone path. The gate
    // consumes it ONCE at the bind write point (the queue insert IS the
    // steer-queued assertion — f7s1_steer_turn_rides_the_gate_fifo pins the
    // flush order), so read it from the queued steer turn instead: it must
    // carry the absolute path, and `pending_steer` must now be spent.
    assert_eq!(
        env.state.gate.pending_len("sess_abc"),
        1,
        "the steer turn sits in the gate FIFO"
    );
    assert!(
        env.state.fleet.pending_steer("sess_abc").is_none(),
        "pending_steer returns the text exactly once (the gate consumed it)"
    );
}

/// The turn half (the composed F6.2+F6.1 row, now with the steer leg): the
/// steer turn flushes into the gate's OWN FIFO (the one stdin writer) after
/// the set_task turn and BEFORE the brief; THREE ends then mint exactly one
/// result — set_task end (burn 1), steer end (burn 2), brief end (mint).
#[tokio::test]
async fn f7s1_steer_turn_rides_the_gate_fifo_and_burns_one_debt() {
    let (_srv, bundle) = make_base_bundle();
    let (router, launcher, pria, env) = started().await;
    program_fetch(&pria, GitFetch::Bundle(bundle));

    let st = set_task_ws_envelope(HANDLE, "1", "brandsite");
    let brief = prompt_envelope("build the landing page");
    send_ok(&router, &st).await;
    send_ok(&router, &brief).await;
    assert_eq!(
        sent_inputs(&launcher),
        vec![st.clone()],
        "set_task streaming; brief buffered; steer not yet written"
    );
    assert_eq!(
        env.state.gate.pending_len("sess_abc"),
        2,
        "steer queued at the HEAD of the gate FIFO, brief behind it"
    );

    // end#1 — the set_task turn: burns debt 1, flushes the STEER (not the brief).
    env.state.gate.on_agent_end("sess_abc").await;
    assert!(results(&pria).is_empty(), "the set_task end never mints");
    let sent = sent_inputs(&launcher);
    assert_eq!(sent.len(), 2, "the steer turn flushed: {sent:?}");
    assert!(
        sent[1] != brief,
        "the steer turn runs before the brief: {sent:?}"
    );
    assert!(
        sent[1].contains(&clone_dir(&env, HANDLE).to_string_lossy().to_string()),
        "the flushed steer carries the clone path: {:?}",
        sent[1]
    );

    // end#2 — the steer turn: burns debt 2, flushes the brief. STILL silent.
    env.state.gate.on_agent_end("sess_abc").await;
    assert!(
        results(&pria).is_empty(),
        "the steer turn's end must never mint the result (the F6.1 debt)"
    );
    assert_eq!(sent_inputs(&launcher).len(), 3, "the brief flushed");

    // end#3 — the brief turn: debt 0, Running ⇒ mints exactly once.
    env.state.gate.on_agent_end("sess_abc").await;
    let rs = results(&pria);
    assert_eq!(rs.len(), 1, "exactly one result: {rs:?}");
    assert_eq!(rs[0]["handle_id"], HANDLE);
    assert_eq!(rs[0]["payload"]["ok"], true);
    assert!(env.state.fleet.binding("sess_abc").is_none(), "cleared");
}

// ── S2: clean tree at the result moment → ok:true, ZERO pushes ───────────────

#[tokio::test]
async fn f7s2_clean_tree_at_result_mints_ok_true_with_zero_pushes() {
    let (_srv, bundle) = make_base_bundle();
    let (_router, _launcher, pria, env) = started().await;
    program_fetch(&pria, GitFetch::Bundle(bundle));
    let fleet = direct_fleet(&env, pria.clone()).await;

    fleet
        .bind("sess_abc", ws_directive(HANDLE, 1, "brandsite"))
        .await
        .expect("ws bind accepted");
    assert!(
        clone_dir(&env, HANDLE).exists(),
        "clone materialized at bind"
    );

    fleet.mark_running("sess_abc");
    fleet.on_agent_end("sess_abc").await; // set_task end — burns
    fleet.on_agent_end("sess_abc").await; // steer end — burns
    fleet.on_agent_end("sess_abc").await; // brief end — mints (clean tree)

    let rs = results(&pria);
    assert_eq!(rs.len(), 1, "exactly one result: {rs:?}");
    assert_eq!(rs[0]["payload"]["ok"], true, "clean tree ⇒ ok:true");
    assert!(
        pushes(&pria).is_empty(),
        "a clean tree must NEVER push (no fabricated artifact): {:?}",
        pushes(&pria)
    );
}

// ── S3: dirty tree → commit + push BEFORE the result callback ────────────────

#[tokio::test]
async fn f7s3_dirty_tree_pushes_before_the_result_callback() {
    let (_srv, bundle) = make_base_bundle();
    let (_router, _launcher, pria, env) = started().await;
    program_fetch(&pria, GitFetch::Bundle(bundle));
    program_push(&pria, GitPush::Accepted);
    let fleet = direct_fleet(&env, pria.clone()).await;

    fleet
        .bind("sess_abc", ws_directive(HANDLE, 1, "brandsite"))
        .await
        .expect("ws bind accepted");

    // The agent "worked the clone": dirty the tree the way the agent would.
    let dest = clone_dir(&env, HANDLE);
    fs::write(dest.join("landing.html"), "<h1>hi</h1>\n").unwrap();

    fleet.mark_running("sess_abc");
    fleet.on_agent_end("sess_abc").await; // set_task end
    fleet.on_agent_end("sess_abc").await; // steer end
    fleet.on_agent_end("sess_abc").await; // brief end — commit+push+mint

    // The ORDERING LAW: the push completed BEFORE the result callback fired.
    // Both ride the same FakePriaClient; at the moment the result callback was
    // recorded, the push recorder was already non-empty — proven by the fact
    // that `on_agent_end` (the single await that does both) has returned with
    // the push present. Pin the shapes:
    let ps = pushes(&pria);
    assert_eq!(ps.len(), 1, "exactly one push for dirty work: {ps:?}");
    assert_eq!(ps[0]["handle_id"], HANDLE);
    assert_eq!(ps[0]["generation"], 1);
    assert_eq!(ps[0]["session_id"], "sess_abc");
    assert_eq!(
        ps[0]["ref"],
        format!("refs/vm/{HANDLE}/result"),
        "the result ref is refs/vm/<handle>/result"
    );
    assert!(
        ps[0]["bundle_bytes"].as_u64().unwrap() > 0,
        "the push body is the non-empty result bundle"
    );

    let rs = results(&pria);
    assert_eq!(rs.len(), 1, "exactly one result: {rs:?}");
    assert_eq!(rs[0]["payload"]["ok"], true, "accepted push ⇒ ok:true");

    // The bundle is REAL: it carries the committed work, thin off the base.
    let head = git(&["rev-parse", "HEAD"], &dest);
    let base = git(&["rev-parse", "HEAD~1"], &dest);
    assert_ne!(head, base, "a commit landed on top of the base");
    let msg = git(&["log", "-1", "--pretty=%B", "HEAD"], &dest);
    assert!(
        msg.contains("fleet") && msg.contains(HANDLE),
        "the commit message binds the fleet handle: {msg:?}"
    );
}

/// The ordering law pinned SEQUENTIALLY (not just shape-wise): an instrumented
/// client records ONE ordered event log across `fleet_git_push` and
/// `fleet_callback`; the push event MUST precede the result event.
#[tokio::test]
async fn f7s3b_push_event_precedes_the_result_event() {
    use pria_guest_agent::pria_client::{
        CallbackError, CredentialRequestPayload, HeartbeatPayload,
        SessionEventPayload, UsagePayload,
    };
    use std::sync::Mutex;

    #[derive(Default)]
    struct OrderedClient {
        events: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl PriaCallbackClient for OrderedClient {
        async fn heartbeat(&self, _p: &HeartbeatPayload) -> Result<(), CallbackError> {
            Ok(())
        }
        async fn audit(&self, _events: Vec<Value>) -> Result<(), CallbackError> {
            Ok(())
        }
        async fn session_event(
            &self,
            _p: &SessionEventPayload,
        ) -> Result<(), CallbackError> {
            Ok(())
        }
        async fn fleet_callback(
            &self,
            _session_id: &str,
            _handle_id: &str,
            _generation: u64,
            kind: &str,
            _payload: Value,
        ) -> Result<(), CallbackError> {
            self.events.lock().unwrap().push(format!("cb:{kind}"));
            Ok(())
        }
        async fn usage(&self, _p: &UsagePayload) -> Result<(), CallbackError> {
            Ok(())
        }
        async fn credential_request(
            &self,
            _p: &CredentialRequestPayload,
        ) -> Result<Value, CallbackError> {
            Ok(Value::Null)
        }
        async fn fleet_git_fetch(
            &self,
            _handle_id: &str,
            _generation: u64,
            _session_id: &str,
        ) -> Result<GitFetch, CallbackError> {
            unreachable!("fetch answer programmed below via wrapper");
        }
        async fn fleet_git_push(
            &self,
            _handle_id: &str,
            _generation: u64,
            _ref_name: &str,
            _session_id: &str,
            _bundle: &[u8],
        ) -> Result<GitPush, CallbackError> {
            self.events.lock().unwrap().push("push".to_string());
            Ok(GitPush::Accepted)
        }
    }

    // Wrap fetch in a scripted client: OrderedClient panics on fetch, so build
    // the lifecycle around a client whose fetch answers the bundle and whose
    // push/callbacks record the ordered log.
    struct Scripted {
        inner: OrderedClient,
        bundle: Vec<u8>,
    }
    #[async_trait::async_trait]
    impl PriaCallbackClient for Scripted {
        async fn heartbeat(&self, p: &HeartbeatPayload) -> Result<(), CallbackError> {
            self.inner.heartbeat(p).await
        }
        async fn audit(&self, events: Vec<Value>) -> Result<(), CallbackError> {
            self.inner.audit(events).await
        }
        async fn session_event(
            &self,
            p: &SessionEventPayload,
        ) -> Result<(), CallbackError> {
            self.inner.session_event(p).await
        }
        async fn fleet_callback(
            &self,
            session_id: &str,
            handle_id: &str,
            generation: u64,
            kind: &str,
            payload: Value,
        ) -> Result<(), CallbackError> {
            self.inner
                .fleet_callback(session_id, handle_id, generation, kind, payload)
                .await
        }
        async fn usage(&self, p: &UsagePayload) -> Result<(), CallbackError> {
            self.inner.usage(p).await
        }
        async fn credential_request(
            &self,
            p: &CredentialRequestPayload,
        ) -> Result<Value, CallbackError> {
            self.inner.credential_request(p).await
        }
        async fn fleet_git_fetch(
            &self,
            _handle_id: &str,
            _generation: u64,
            _session_id: &str,
        ) -> Result<GitFetch, CallbackError> {
            Ok(GitFetch::Bundle(self.bundle.clone()))
        }
        async fn fleet_git_push(
            &self,
            handle_id: &str,
            generation: u64,
            ref_name: &str,
            session_id: &str,
            bundle: &[u8],
        ) -> Result<GitPush, CallbackError> {
            self.inner
                .fleet_git_push(handle_id, generation, ref_name, session_id, bundle)
                .await
        }
    }
    let (_srv, bundle) = make_base_bundle();
    let (_router, _launcher, _pria, env) = started().await;
    let client = Arc::new(Scripted {
        inner: OrderedClient::default(),
        bundle,
    });
    let fleet = FleetBindings::new(
        client.clone() as Arc<dyn PriaCallbackClient>,
        std::time::Duration::from_secs(3600),
    )
    .with_sessions(env.state.sessions.clone());

    fleet
        .bind("sess_abc", ws_directive(HANDLE, 1, "brandsite"))
        .await
        .expect("ws bind accepted");
    fs::write(clone_dir(&env, HANDLE).join("out.txt"), "work\n").unwrap();

    fleet.mark_running("sess_abc");
    for _ in 0..3 {
        fleet.on_agent_end("sess_abc").await;
    }

    let events = client.inner.events.lock().unwrap().clone();
    let push_at = events
        .iter()
        .position(|e| e == "push")
        .expect("a push happened");
    let result_at = events
        .iter()
        .position(|e| e == "cb:result")
        .expect("a result callback happened");
    assert!(
        push_at < result_at,
        "the push MUST complete before the result callback fires: {events:?}"
    );
}

// ── S4: push refusal → honest push_refused failure ───────────────────────────

#[tokio::test]
async fn f7s4_refused_push_mints_push_refused_failure() {
    let (_srv, bundle) = make_base_bundle();
    let (_router, _launcher, pria, env) = started().await;
    program_fetch(&pria, GitFetch::Bundle(bundle));
    program_push(&pria, GitPush::Refused("non_fast_forward".into()));
    let fleet = direct_fleet(&env, pria.clone()).await;

    fleet
        .bind("sess_abc", ws_directive(HANDLE, 1, "brandsite"))
        .await
        .expect("ws bind accepted");
    fs::write(clone_dir(&env, HANDLE).join("out.txt"), "work\n").unwrap();

    fleet.mark_running("sess_abc");
    for _ in 0..3 {
        fleet.on_agent_end("sess_abc").await;
    }

    assert_eq!(pushes(&pria).len(), 1, "the push was attempted");
    let rs = results(&pria);
    assert_eq!(rs.len(), 1, "exactly one result: {rs:?}");
    assert_eq!(rs[0]["payload"]["ok"], false, "refused push ⇒ honest failure");
    assert_eq!(
        rs[0]["payload"]["error"]["code"], "push_refused",
        "the first-cause refusal code"
    );
}

// ── S5: fetch refusal → honest workspace-LESS run ────────────────────────────

#[tokio::test]
async fn f7s5_refused_fetch_runs_workspace_less_and_still_acks() {
    let (router, launcher, pria, env) = started().await;
    program_fetch(&pria, GitFetch::Refused("no_such_workspace".into()));

    let st = set_task_ws_envelope(HANDLE, "1", "brandsite");
    let brief = prompt_envelope("build the landing page");
    send_ok(&router, &st).await;
    send_ok(&router, &brief).await;

    // The binding ACKED anyway — the binding is valid; it just runs without
    // a workspace.
    assert!(
        fleet_cbs(&pria).iter().any(|c| c["kind"] == "ack"),
        "a refused fetch still acks the binding"
    );
    assert_eq!(fetches(&pria).len(), 1, "the fetch was attempted once");

    // Workspace-LESS: no clone dir, no staged steer, no steer queued.
    assert!(
        !clone_dir(&env, HANDLE).exists(),
        "no clone materializes on a refused fetch"
    );
    assert!(
        env.state.fleet.pending_steer("sess_abc").is_none(),
        "no steer staged on a workspace-less run"
    );
    assert_eq!(
        env.state.gate.pending_len("sess_abc"),
        1,
        "only the brief is buffered (no steer turn — the F6 debt stays 1)"
    );

    // Two ends (set_task burn + brief mint) — the workspace-less run is
    // byte-identical F6.
    env.state.gate.on_agent_end("sess_abc").await;
    assert!(results(&pria).is_empty(), "the set_task end burns");
    assert_eq!(sent_inputs(&launcher).len(), 2, "the brief flushed next");
    env.state.gate.on_agent_end("sess_abc").await;
    let rs = results(&pria);
    assert_eq!(rs.len(), 1, "exactly one result: {rs:?}");
    assert_eq!(rs[0]["payload"]["ok"], true, "honest workspace-less success");
    assert!(pushes(&pria).is_empty(), "never a push without a workspace");
}

// ── S6: teardown with a dirty workspace → NO push; F6.1d intact ─────────────

#[tokio::test]
async fn f7s6_teardown_with_dirty_workspace_never_pushes() {
    let (_srv, bundle) = make_base_bundle();
    let (router, _launcher, pria, env) = started().await;
    program_fetch(&pria, GitFetch::Bundle(bundle));
    // Bind through the SAME fleet the router's /close handler consults
    // (env.state.fleet) — a separate direct_fleet would share the
    // SessionStore but NOT the binding table, and /close would find nothing
    // bound. The S2/S3/S4 direct-fleet idiom is right for end-driven mints;
    // teardown is router-driven, so the bind must live on the router's fleet.
    let fleet = &env.state.fleet;
    fleet
        .bind("sess_abc", ws_directive(HANDLE, 1, "brandsite"))
        .await
        .expect("ws bind accepted");
    // Dirty the tree mid-run — the teardown must still never push.
    fs::write(clone_dir(&env, HANDLE).join("half-done.txt"), "wip\n").unwrap();
    fleet.mark_running("sess_abc");

    let resp = router
        .clone()
        .oneshot(post(
            "/guest/v1/sessions/sess_abc/close",
            json!({ "reason": "user_closed", "grace_period_ms": 0 }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    assert!(
        pushes(&pria).is_empty(),
        "teardown NEVER pushes — the worktree is scratch, reclaimed with the session"
    );
    let rs = results(&pria);
    assert_eq!(rs.len(), 1, "exactly one teardown result: {rs:?}");
    assert_eq!(rs[0]["payload"]["ok"], false);
    assert_eq!(
        rs[0]["payload"]["error"]["code"], "session_closed",
        "the F6.1d honest-failure law is intact"
    );
}

// ── S7: absent-ws → byte-identical F6 ────────────────────────────────────────

#[tokio::test]
async fn f7s7_absent_ws_is_byte_identical_f6_no_git_surface() {
    let (router, launcher, pria, env) = started().await;
    // No fetch answer programmed: the fake would answer Refused — but the
    // absent-ws path must never CALL it at all.

    let st = set_task_plain_envelope(HANDLE, "1");
    let brief = prompt_envelope("curate the vault as briefed");
    send_ok(&router, &st).await;
    send_ok(&router, &brief).await;

    assert!(
        fetches(&pria).is_empty(),
        "absent ws ⇒ NO fetch: {:?}",
        fetches(&pria)
    );
    assert!(
        !session_dir(&env).join("worktree").exists(),
        "absent ws ⇒ NO clone root"
    );
    assert!(
        env.state.fleet.pending_steer("sess_abc").is_none(),
        "absent ws ⇒ NO steer"
    );
    assert_eq!(
        env.state.gate.pending_len("sess_abc"),
        1,
        "exactly the brief buffered — the F6 shape"
    );

    env.state.gate.on_agent_end("sess_abc").await; // set_task end — burns
    assert!(results(&pria).is_empty());
    assert_eq!(
        sent_inputs(&launcher),
        vec![st.clone(), brief.clone()],
        "the brief flushed second — no steer turn exists"
    );
    env.state.gate.on_agent_end("sess_abc").await; // brief end — mints
    let rs = results(&pria);
    assert_eq!(rs.len(), 1, "exactly one result: {rs:?}");
    assert_eq!(rs[0]["payload"]["ok"], true);
    assert!(
        pushes(&pria).is_empty(),
        "absent ws ⇒ NO push: {:?}",
        pushes(&pria)
    );
}

// ── S8: the wire token is never model-visible in the steer text ─────────────

#[tokio::test]
async fn f7s8_steer_text_carries_the_path_never_the_wire_token() {
    let (_srv, bundle) = make_base_bundle();
    let (router, launcher, pria, env) = started().await;
    program_fetch(&pria, GitFetch::Bundle(bundle));

    send_ok(&router, &set_task_ws_envelope(HANDLE, "1", "brandsite")).await;
    // The gate consumed the staged steer at the bind write point and queued
    // it — read the text from the flushed steer turn (the same observable
    // the model would see).
    env.state.gate.on_agent_end("sess_abc").await; // set_task end ⇒ steer flushes
    let sent = sent_inputs(&launcher);
    assert_eq!(sent.len(), 2, "the steer turn flushed: {sent:?}");
    let staged = &sent[1];

    // Carries the ABSOLUTE clone path (structural steering — R-F7-3).
    assert!(
        staged.contains(&clone_dir(&env, HANDLE).to_string_lossy().to_string()),
        "steer text must name the clone path: {staged:?}"
    );
    // NEVER the wire token: no "ws:" token, no "fleet <handle>" shape, no
    // handle id at all — the model never sees the fleet wire vocabulary.
    assert!(!staged.contains("ws:"), "never the ws token: {staged:?}");
    assert!(!staged.contains(HANDLE), "never the handle id: {staged:?}");
    assert!(
        !staged.contains("fleet"),
        "never the fleet wire word: {staged:?}"
    );
}
