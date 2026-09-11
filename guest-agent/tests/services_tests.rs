//! VM-Sites app-service handler tests (`/guest/v1/services/*`,
//! `/guest/v1/artifacts/seal`): real child processes on 127.0.0.1 only,
//! hermetic temp roots, `FakePriaClient` callback recorder.
//!
//! Children are `python3` (HTTP server / scripted probes) and `sleep`; both
//! are added to the test allowlist (the production default does not carry
//! `sleep`).

use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use pria_guest_agent::api::{build_router, AppState};
use pria_guest_agent::hmac::HmacVerifier;
use pria_guest_agent::os::FakeUserManager;
use pria_guest_agent::pria_client::fake::FakePriaClient;
use pria_guest_agent::pria_client::OutboundSigner;
use pria_guest_agent::services::ports::state_file_path;
use pria_guest_agent::services::ServiceStore;
use pria_guest_agent::synaps::launcher::FakeLauncher;
use pria_guest_agent::test_support::test_env;

const SECRET: &[u8] = b"services-test-secret";

/// Each test gets its own 10-port slice so parallel tests never race on a
/// loopback port (the allocator's bind probe cannot see a sibling test's
/// not-yet-bound choice). The slices sit below the Linux ephemeral range
/// (32768–60999) so kernel-assigned ports elsewhere can never collide.
static NEXT_RANGE: AtomicU16 = AtomicU16::new(24200);

struct Env {
    state: AppState,
    pria: Arc<FakePriaClient>,
    workdir: std::path::PathBuf,
    run_root: std::path::PathBuf,
    efs_root: std::path::PathBuf,
    port_start: u16,
    port_end: u16,
}

fn make_env(customise: impl FnOnce(&mut pria_guest_agent::config::AppServicesConfig)) -> Env {
    let pria = Arc::new(FakePriaClient::default());
    let env = test_env(
        pria.clone(),
        Arc::new(FakeUserManager::default()),
        Arc::new(FakeLauncher::default()),
    );
    let mut state = env.state;
    let mut cfg = (*state.config).clone();
    let port_start = NEXT_RANGE.fetch_add(10, Ordering::SeqCst);
    let port_end = port_start + 9;
    cfg.app_services.port_range_start = port_start;
    cfg.app_services.port_range_end = port_end;
    cfg.app_services
        .command_allowlist
        .extend(["sleep".to_string(), "python3".to_string()]);
    cfg.app_services.workspace_root = Some(env.efs_root.join("instances/inst_1/work/proj"));
    cfg.app_services.stop_grace_ms = 300;
    cfg.app_services.start_wait_ms = 2000;
    cfg.app_services.log_batch_interval_ms = 100;
    customise(&mut cfg.app_services);
    state.services = Arc::new(ServiceStore::new(
        &env.run_root,
        cfg.app_services.clone(),
        pria.clone(),
    ));
    state.config = Arc::new(cfg);
    let workdir = env.efs_root.join("instances/inst_1/work/proj");
    std::fs::create_dir_all(&workdir).unwrap();
    Env {
        state,
        pria,
        workdir,
        run_root: env.run_root,
        efs_root: env.efs_root,
        port_start,
        port_end,
    }
}

fn post(uri: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn get(uri: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

async fn call(state: &AppState, req: Request<Body>) -> (StatusCode, Value) {
    let resp = build_router(state.clone()).oneshot(req).await.unwrap();
    let st = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into()))
    };
    (st, v)
}

fn start_body(env: &Env, id: &str, command: Vec<&str>, readiness_timeout_ms: u64) -> Value {
    json!({
        "serviceId": id,
        "kind": "dev",
        "sessionId": "sess_svc_1",
        "workdir": env.workdir.to_string_lossy(),
        "command": command,
        "env": {"NODE_ENV": "development"},
        "readiness": {"path": "/", "timeoutMs": readiness_timeout_ms},
        "limits": {}
    })
}

fn http_server_cmd() -> Vec<&'static str> {
    vec![
        "python3",
        "-m",
        "http.server",
        "--bind",
        "127.0.0.1",
        "${PORT}",
    ]
}

async fn wait_state(state: &AppState, id: &str, wanted: &[&str], timeout: Duration) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        let (st, v) = call(state, get(&format!("/guest/v1/services/{id}/status"))).await;
        assert_eq!(st, StatusCode::OK, "status body: {v}");
        let s = v["state"].as_str().unwrap_or("");
        if wanted.contains(&s) {
            return v;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {wanted:?}; last status {v}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn wait_log_line(state: &AppState, id: &str, needle: &str, timeout: Duration) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        let (st, v) = call(
            state,
            get(&format!("/guest/v1/services/{id}/logs?limit=500")),
        )
        .await;
        assert_eq!(st, StatusCode::OK, "logs body: {v}");
        if let Some(e) = v["entries"].as_array().and_then(|a| {
            a.iter()
                .find(|e| e["line"].as_str().unwrap_or("").contains(needle))
        }) {
            return e.clone();
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for log line {needle:?}; last page {v}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// True once `pid` no longer exists (or is a reaped-pending zombie).
fn process_gone(pid: u64) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/status")) {
        Err(_) => true,
        Ok(s) => s
            .lines()
            .any(|l| l.starts_with("State:") && l.contains('Z')),
    }
}

async fn wait_gone(pid: u64, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while !process_gone(pid) {
        assert!(Instant::now() < deadline, "pid {pid} still alive");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn events(env: &Env) -> Vec<Value> {
    env.pria
        .app_service_events
        .lock()
        .unwrap()
        .iter()
        .map(|(sid, p)| json!({ "sessionId": sid, "payload": serde_json::to_value(p).unwrap() }))
        .collect()
}

async fn wait_event(env: &Env, id: &str, state: &str, timeout: Duration) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(e) = events(env)
            .into_iter()
            .find(|e| e["payload"]["serviceId"] == id && e["payload"]["state"] == state)
        {
            return e;
        }
        assert!(
            Instant::now() < deadline,
            "no {state} event for {id}; events {:?}",
            events(env)
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn http_server_becomes_ready_with_allocated_port_and_reports_events() {
    let env = make_env(|_| {});
    let id = "svc_ready_01";
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, id, http_server_cmd(), 10_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    assert_eq!(v["serviceId"], id);
    assert_eq!(v["generation"], 1);
    assert_eq!(v["kind"], "dev");
    let port = v["port"].as_u64().unwrap() as u16;
    assert!(
        (env.port_start..=env.port_end).contains(&port),
        "port {port}"
    );
    assert!(matches!(
        v["state"].as_str(),
        Some("starting") | Some("ready")
    ));

    let status = wait_state(&env.state, id, &["ready"], Duration::from_secs(10)).await;
    assert_eq!(status["generation"], 1);
    assert_eq!(status["port"], port);
    assert!(status["pid"].as_u64().unwrap() > 0);
    assert!(status["exitCode"].is_null());
    assert!(!status["since"].as_str().unwrap().is_empty());

    // The server really answers on the private endpoint.
    let body = reqwest::get(format!("http://127.0.0.1:{port}/"))
        .await
        .unwrap()
        .status();
    assert!(body.is_success());

    // Signed callback: ready with port, session id in the signed header slot.
    let ev = wait_event(&env, id, "ready", Duration::from_secs(5)).await;
    assert_eq!(ev["sessionId"], "sess_svc_1");
    assert_eq!(ev["payload"]["generation"], 1);
    assert_eq!(ev["payload"]["port"], port);
    assert!(ev["payload"].get("exitCode").is_none());
    assert!(!ev["payload"]["observedAt"].as_str().unwrap().is_empty());

    // Port is persisted as owned while live.
    let raw = std::fs::read_to_string(state_file_path(&env.run_root)).unwrap();
    let persisted: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(persisted["services"][id]["port"], port);
    assert_eq!(persisted["services"][id]["active"], true);
    assert_eq!(persisted["services"][id]["pid"], status["pid"]);

    // Stop (fenced on the live generation) → stopped, port reclaimed.
    let (st, v) = call(
        &env.state,
        post(
            &format!("/guest/v1/services/{id}/stop"),
            json!({"generation": 1}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    assert_eq!(v["state"], "stopped");
    assert_eq!(v["generation"], 1);
    wait_gone(status["pid"].as_u64().unwrap(), Duration::from_secs(5)).await;
    let ev = wait_event(&env, id, "stopped", Duration::from_secs(5)).await;
    assert!(ev["payload"]["exitCode"].is_number());
    let raw = std::fs::read_to_string(state_file_path(&env.run_root)).unwrap();
    let persisted: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(persisted["services"][id]["active"], false);
    assert_eq!(persisted["services"][id]["generation"], 1);
}

#[tokio::test]
async fn readiness_timeout_marks_failed_and_kills_the_group() {
    let env = make_env(|_| {});
    let id = "svc_timeout_1";
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, id, vec!["sleep", "30"], 300),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    let pid = v["pid"].as_u64().unwrap();
    let status = wait_state(&env.state, id, &["failed"], Duration::from_secs(10)).await;
    assert!(
        status["detail"]
            .as_str()
            .unwrap()
            .contains("readiness timeout"),
        "detail: {}",
        status["detail"]
    );
    wait_gone(pid, Duration::from_secs(5)).await;
    let ev = wait_event(&env, id, "failed", Duration::from_secs(5)).await;
    // sleep dies on SIGTERM → shell-style 128+15.
    assert_eq!(ev["payload"]["exitCode"], 143);
    let status = wait_state(&env.state, id, &["failed"], Duration::from_secs(5)).await;
    assert_eq!(status["exitCode"], 143);
    assert_eq!(status["signal"], 15);
}

#[tokio::test]
async fn clean_exit_reports_exited_with_code_zero() {
    let env = make_env(|_| {});
    let id = "svc_exit0_01";
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, id, vec!["python3", "-c", "print('bye')"], 10_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    let status = wait_state(&env.state, id, &["exited"], Duration::from_secs(10)).await;
    assert_eq!(status["exitCode"], 0);
    let ev = wait_event(&env, id, "exited", Duration::from_secs(5)).await;
    assert_eq!(ev["payload"]["exitCode"], 0);
    // A failing command is `failed` with its code.
    let id2 = "svc_exit3_01";
    call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(
                &env,
                id2,
                vec!["python3", "-c", "import sys; sys.exit(3)"],
                10_000,
            ),
        ),
    )
    .await;
    let status = wait_state(&env.state, id2, &["failed"], Duration::from_secs(10)).await;
    assert_eq!(status["exitCode"], 3);
}

#[tokio::test]
async fn logs_ring_cursor_and_batched_callbacks() {
    let env = make_env(|_| {});
    let id = "svc_logs_0001";
    let script = "import sys\nfor i in range(50):\n    print(f'line {i}')\nprint('to-stderr', file=sys.stderr)\nsys.stdout.flush()\n";
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, id, vec!["python3", "-c", script], 10_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    wait_state(&env.state, id, &["exited"], Duration::from_secs(10)).await;
    // Readers drain after exit; wait for the last line to land.
    wait_log_line(&env.state, id, "to-stderr", Duration::from_secs(5)).await;

    let (st, page1) = call(
        &env.state,
        get(&format!("/guest/v1/services/{id}/logs?limit=10")),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let entries = page1["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 10);
    assert_eq!(entries[0]["seq"], 1);
    assert_eq!(entries[9]["seq"], 10);
    assert_eq!(page1["next"], "11");
    assert_eq!(page1["dropped"], 0);
    for e in entries {
        assert!(!e["ts"].as_str().unwrap().is_empty());
        assert!(matches!(
            e["stream"].as_str(),
            Some("stdout") | Some("stderr")
        ));
    }

    let (st, page2) = call(
        &env.state,
        get(&format!("/guest/v1/services/{id}/logs?cursor=11&limit=500")),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let rest = page2["entries"].as_array().unwrap();
    assert_eq!(rest.len(), 41, "50 stdout + 1 stderr − 10 already read");
    assert_eq!(rest[0]["seq"], 11);
    assert_eq!(page2["next"], "52");
    // Both streams are captured (python's piped stdout is block-buffered, so
    // the stderr line may land anywhere in the sequence).
    let all: Vec<Value> = entries.iter().chain(rest.iter()).cloned().collect();
    assert!(all
        .iter()
        .any(|e| e["stream"] == "stderr" && e["line"] == "to-stderr"));
    assert!(all
        .iter()
        .any(|e| e["stream"] == "stdout" && e["line"] == "line 49"));
    assert_eq!(all.iter().filter(|e| e["stream"] == "stdout").count(), 50);

    // Resume from the end: nothing new, cursor echoed.
    let (_, page3) = call(
        &env.state,
        get(&format!("/guest/v1/services/{id}/logs?cursor=52")),
    )
    .await;
    assert!(page3["entries"].as_array().unwrap().is_empty());
    assert_eq!(page3["next"], "52");

    // limit > 500 is clamped, bad cursor is a typed 400.
    let (st, _) = call(
        &env.state,
        get(&format!("/guest/v1/services/{id}/logs?limit=9999")),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let (st, v) = call(
        &env.state,
        get(&format!("/guest/v1/services/{id}/logs?cursor=abc")),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"]["code"], "invalid_request");
    for bad in ["limit=0", "limit=-1", "limit=abc"] {
        let (st, v) = call(
            &env.state,
            get(&format!("/guest/v1/services/{id}/logs?{bad}")),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{bad}");
        assert_eq!(v["error"]["code"], "invalid_request", "{bad}");
    }

    // Batched app-log callbacks carried every line exactly once.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let logs = env.pria.app_logs.lock().unwrap().clone();
        let total: usize = logs.iter().map(|(_, p)| p.entries.len()).sum();
        if total == 51 {
            for (sid, p) in logs.iter() {
                assert_eq!(sid, "sess_svc_1");
                assert_eq!(p.service_id, id);
                assert_eq!(p.generation, 1);
                assert!(p.entries.len() <= 200);
            }
            let mut seqs: Vec<u64> = logs
                .iter()
                .flat_map(|(_, p)| p.entries.iter().map(|e| e.seq))
                .collect();
            seqs.sort_unstable();
            assert_eq!(seqs, (1..=51).collect::<Vec<u64>>());
            break;
        }
        assert!(Instant::now() < deadline, "app-log batches incomplete");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn log_ring_evicts_by_limit_and_counts_dropped() {
    let env = make_env(|c| c.log_ring_max_entries = 20);
    let id = "svc_logs_drop1";
    let script = "for i in range(100):\n    print(f'l{i}')\n";
    call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, id, vec!["python3", "-c", script], 10_000),
        ),
    )
    .await;
    wait_state(&env.state, id, &["exited"], Duration::from_secs(10)).await;
    wait_log_line(&env.state, id, "l99", Duration::from_secs(5)).await;
    let (_, page) = call(&env.state, get(&format!("/guest/v1/services/{id}/logs"))).await;
    let entries = page["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 20);
    assert_eq!(entries[0]["seq"], 81);
    assert_eq!(page["dropped"], 80);
    // A cursor into the evicted past resumes at the oldest retained entry.
    let (_, page) = call(
        &env.state,
        get(&format!("/guest/v1/services/{id}/logs?cursor=5&limit=1")),
    )
    .await;
    assert_eq!(page["entries"][0]["seq"], 81);
}

#[tokio::test]
async fn stop_is_generation_fenced_and_idempotent() {
    let env = make_env(|_| {});
    let id = "svc_fence_001";
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, id, http_server_cmd(), 10_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    wait_state(&env.state, id, &["ready"], Duration::from_secs(10)).await;

    let (st, v) = call(
        &env.state,
        post(
            &format!("/guest/v1/services/{id}/stop"),
            json!({"generation": 2}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT, "body: {v}");
    assert_eq!(v["error"]["code"], "service_generation_stale");
    assert_eq!(v["error"]["retryable"], false);
    // Still running.
    let s = wait_state(&env.state, id, &["ready"], Duration::from_secs(1)).await;
    assert_eq!(s["state"], "ready");

    let (st, v) = call(
        &env.state,
        post(
            &format!("/guest/v1/services/{id}/stop"),
            json!({"generation": 1}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    assert_eq!(v["state"], "stopped");
    // Idempotent second stop.
    let (st, v) = call(
        &env.state,
        post(
            &format!("/guest/v1/services/{id}/stop"),
            json!({"generation": 1}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    assert_eq!(v["state"], "stopped");
    // Unknown id → 404.
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/svc_unknown_1/stop",
            json!({"generation": 1}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(v["error"]["code"], "service_not_found");
}

#[tokio::test]
async fn stop_escalates_sigterm_to_sigkill() {
    let env = make_env(|_| {});
    let id = "svc_sigkill_01";
    let script = "import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint('armed', flush=True)\ntime.sleep(60)\n";
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, id, vec!["python3", "-c", script], 30_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    let pid = v["pid"].as_u64().unwrap();
    wait_log_line(&env.state, id, "armed", Duration::from_secs(5)).await;

    let t0 = Instant::now();
    let (st, v) = call(
        &env.state,
        post(
            &format!("/guest/v1/services/{id}/stop"),
            json!({"generation": 1}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    assert_eq!(v["state"], "stopped");
    assert!(
        t0.elapsed() >= Duration::from_millis(250),
        "SIGKILL only after the grace window"
    );
    assert_eq!(v["exitCode"], 137, "128 + SIGKILL");
    assert_eq!(v["signal"], 9);
    wait_gone(pid, Duration::from_secs(5)).await;
}

#[tokio::test]
async fn stop_kills_the_whole_process_group() {
    let env = make_env(|_| {});
    let id = "svc_group_0001";
    let script = "import subprocess, time\np = subprocess.Popen(['sleep', '60'])\nprint('child', p.pid, flush=True)\ntime.sleep(60)\n";
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, id, vec!["python3", "-c", script], 30_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    let parent_pid = v["pid"].as_u64().unwrap();
    let line = wait_log_line(&env.state, id, "child ", Duration::from_secs(5)).await;
    let child_pid: u64 = line["line"]
        .as_str()
        .unwrap()
        .trim_start_matches("child ")
        .trim()
        .parse()
        .unwrap();
    assert!(!process_gone(child_pid));

    let (st, v) = call(
        &env.state,
        post(
            &format!("/guest/v1/services/{id}/stop"),
            json!({"generation": 1}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    wait_gone(parent_pid, Duration::from_secs(5)).await;
    wait_gone(child_pid, Duration::from_secs(5)).await;
}

#[tokio::test]
async fn restart_bumps_generation_and_live_start_is_idempotent() {
    let env = make_env(|_| {});
    let id = "svc_restart_01";
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, id, http_server_cmd(), 10_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    let port1 = v["port"].as_u64().unwrap();
    let pid1 = v["pid"].as_u64().unwrap();
    wait_state(&env.state, id, &["ready"], Duration::from_secs(10)).await;

    // Same id while live → the same record, nothing respawned.
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, id, http_server_cmd(), 10_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    assert_eq!(v["generation"], 1);
    assert_eq!(v["port"], port1);
    assert_eq!(v["pid"], pid1);
    assert_eq!(v["state"], "ready");

    let (st, _) = call(
        &env.state,
        post(
            &format!("/guest/v1/services/{id}/stop"),
            json!({"generation": 1}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    wait_gone(pid1, Duration::from_secs(5)).await;

    // Terminal → restart bumps the generation; the old generation is fenced.
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, id, http_server_cmd(), 10_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    assert_eq!(v["generation"], 2);
    assert_ne!(v["pid"], pid1);
    wait_state(&env.state, id, &["ready"], Duration::from_secs(10)).await;
    let (st, v) = call(
        &env.state,
        post(
            &format!("/guest/v1/services/{id}/stop"),
            json!({"generation": 1}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT, "body: {v}");
    let (st, v) = call(
        &env.state,
        post(
            &format!("/guest/v1/services/{id}/stop"),
            json!({"generation": 2}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    assert_eq!(v["state"], "stopped");
    // Generation is persisted for monotonicity across agent restarts.
    let raw = std::fs::read_to_string(state_file_path(&env.run_root)).unwrap();
    let persisted: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(persisted["services"][id]["generation"], 2);
}

#[tokio::test]
async fn runtime_limit_kills_the_service() {
    let env = make_env(|_| {});
    let id = "svc_runtime_01";
    let mut body = start_body(&env, id, vec!["sleep", "30"], 30_000);
    body["limits"] = json!({"maxRuntimeSec": 1});
    let (st, v) = call(&env.state, post("/guest/v1/services/start", body)).await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    let pid = v["pid"].as_u64().unwrap();
    let status = wait_state(&env.state, id, &["failed"], Duration::from_secs(10)).await;
    assert!(status["detail"].as_str().unwrap().contains("runtime limit"));
    wait_gone(pid, Duration::from_secs(5)).await;
}

#[tokio::test]
async fn max_services_cap_is_enforced() {
    let env = make_env(|c| c.max_services = 1);
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, "svc_cap_00001", vec!["sleep", "30"], 30_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, "svc_cap_00002", vec!["sleep", "30"], 30_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS, "body: {v}");
    assert_eq!(v["error"]["code"], "service_limit_exceeded");
    let (st, _) = call(
        &env.state,
        post(
            "/guest/v1/services/svc_cap_00001/stop",
            json!({"generation": 1}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    // Capacity frees up once the first is terminal.
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, "svc_cap_00002", vec!["sleep", "30"], 30_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    call(
        &env.state,
        post(
            "/guest/v1/services/svc_cap_00002/stop",
            json!({"generation": 1}),
        ),
    )
    .await;
}

#[tokio::test]
async fn callback_failures_never_block_the_lifecycle() {
    let env = make_env(|_| {});
    *env.pria.app_callback_failure.lock().unwrap() = Some(503);
    let id = "svc_cbfail_01";
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, id, http_server_cmd(), 10_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    wait_state(&env.state, id, &["ready"], Duration::from_secs(10)).await;
    let (st, v) = call(
        &env.state,
        post(
            &format!("/guest/v1/services/{id}/stop"),
            json!({"generation": 1}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    assert_eq!(v["state"], "stopped");
    // The failing callback was attempted (and will be retried in the
    // background) but never altered the lifecycle.
    assert!(!events(&env).is_empty());
}

// ── validation ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn env_is_allowlisted_and_placeholders_are_substituted() {
    let env = make_env(|_| {});
    let id = "svc_env_000001";
    let script = "import os, json\nprint(json.dumps({'keys': sorted(os.environ), 'PORT': os.environ.get('PORT'), 'HOST': os.environ.get('HOST'), 'argv_port': __import__('sys').argv[1]}), flush=True)\n";
    let mut body = start_body(&env, id, vec!["python3", "-c", script, "${PORT}"], 10_000);
    body["env"] = json!({
        "SECRET_TOKEN": "eyJ-should-not-leak",
        "AWS_SECRET_ACCESS_KEY": "no",
        "LD_PRELOAD": "/evil.so",
        "VITE_APP_FLAG": "1",
        "VITE_lower": "dropped",
        "NODE_ENV": "development",
        "REVISION_BASE": "/p/r/abc/",
        "CI": "true",
        "PORT": "1",
        "HOST": "0.0.0.0"
    });
    let (st, v) = call(&env.state, post("/guest/v1/services/start", body)).await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    let port = v["port"].as_u64().unwrap();
    wait_state(&env.state, id, &["exited"], Duration::from_secs(10)).await;
    let line = wait_log_line(&env.state, id, "keys", Duration::from_secs(5)).await;
    let seen: Value = serde_json::from_str(line["line"].as_str().unwrap()).unwrap();
    let keys: Vec<&str> = seen["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k.as_str().unwrap())
        .collect();
    for k in [
        "SECRET_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
        "LD_PRELOAD",
        "VITE_lower",
    ] {
        assert!(!keys.contains(&k), "{k} leaked: {keys:?}");
    }
    for k in [
        "PATH",
        "HOME",
        "NODE_ENV",
        "REVISION_BASE",
        "CI",
        "VITE_APP_FLAG",
        "PORT",
        "HOST",
    ] {
        assert!(keys.contains(&k), "{k} missing: {keys:?}");
    }
    // Only the allowlist reaches the child — nothing inherited from the agent.
    // (`LC_CTYPE` is python's own PEP 538 locale coercion, not inheritance.)
    let allowed = |k: &&str| {
        [
            "PATH",
            "HOME",
            "NODE_ENV",
            "REVISION_BASE",
            "CI",
            "PORT",
            "HOST",
            "LC_CTYPE",
            "DEV_PORT",
        ]
        .contains(k)
            || k.starts_with("VITE_")
    };
    assert!(keys.iter().all(allowed), "unexpected env keys: {keys:?}");
    // PORT/HOST are the supervisor's, never the caller's.
    assert_eq!(seen["PORT"], port.to_string());
    assert_eq!(seen["HOST"], "127.0.0.1");
    assert_eq!(
        seen["argv_port"],
        port.to_string(),
        "${{PORT}} placeholder substituted in argv"
    );
}

#[tokio::test]
async fn start_validation_matrix() {
    let env = make_env(|_| {});
    let ok = start_body(&env, "svc_valid_0001", vec!["sleep", "1"], 1000);

    let cases: Vec<(&str, Value)> = vec![
        ("short id", {
            let mut b = ok.clone();
            b["serviceId"] = json!("short");
            b
        }),
        ("id with dot", {
            let mut b = ok.clone();
            b["serviceId"] = json!("svc.with.dots");
            b
        }),
        ("id too long", {
            let mut b = ok.clone();
            b["serviceId"] = json!("x".repeat(65));
            b
        }),
        ("bad kind", {
            let mut b = ok.clone();
            b["kind"] = json!("prod");
            b
        }),
        ("empty session", {
            let mut b = ok.clone();
            b["sessionId"] = json!("");
            b
        }),
        ("workdir outside root", {
            let mut b = ok.clone();
            b["workdir"] = json!("/tmp");
            b
        }),
        ("workdir traversal", {
            let mut b = ok.clone();
            b["workdir"] = json!(format!("{}/../../../../tmp", env.workdir.display()));
            b
        }),
        ("workdir relative", {
            let mut b = ok.clone();
            b["workdir"] = json!("relative/dir");
            b
        }),
        ("workdir missing", {
            let mut b = ok.clone();
            b["workdir"] = json!(env.efs_root.join("nope").to_string_lossy());
            b
        }),
        ("command empty", {
            let mut b = ok.clone();
            b["command"] = json!([]);
            b
        }),
        ("command not allowlisted", {
            let mut b = ok.clone();
            b["command"] = json!(["bash", "-c", "id"]);
            b
        }),
        ("command absolute path", {
            let mut b = ok.clone();
            b["command"] = json!(["/bin/sleep", "1"]);
            b
        }),
        ("command relative path", {
            let mut b = ok.clone();
            b["command"] = json!(["./sleep", "1"]);
            b
        }),
        ("readiness path without slash", {
            let mut b = ok.clone();
            b["readiness"] = json!({"path": "health", "timeoutMs": 1000});
            b
        }),
        ("readiness path with space", {
            let mut b = ok.clone();
            b["readiness"] = json!({"path": "/a b", "timeoutMs": 1000});
            b
        }),
        ("readiness timeout zero", {
            let mut b = ok.clone();
            b["readiness"] = json!({"path": "/", "timeoutMs": 0});
            b
        }),
        ("env value with newline", {
            let mut b = ok.clone();
            b["env"] = json!({"NODE_ENV": "a\nb"});
            b
        }),
    ];
    for (name, body) in cases {
        let (st, v) = call(&env.state, post("/guest/v1/services/start", body)).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{name}: {v}");
        assert_eq!(v["error"]["code"], "invalid_request", "{name}: {v}");
    }

    // Symlink under the root pointing outside is refused even though the
    // lexical check passes.
    let outside = std::env::temp_dir().join(format!("ga-svc-outside-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&outside).unwrap();
    let link = env.workdir.join("escape");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    let mut b = ok.clone();
    b["workdir"] = json!(link.to_string_lossy());
    let (st, v) = call(&env.state, post("/guest/v1/services/start", b)).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "symlink escape: {v}");
    assert!(
        v["error"]["message"].as_str().unwrap().contains("symlink"),
        "{v}"
    );
    std::fs::remove_dir_all(&outside).ok();

    // Nothing was spawned: no record, no port owned.
    let (st, _) = call(&env.state, get("/guest/v1/services/svc_valid_0001/status")).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert!(!state_file_path(&env.run_root).exists());

    // Unknown id on the read routes → typed 404; malformed id → 400.
    let (st, v) = call(&env.state, get("/guest/v1/services/svc_unknown_1/logs")).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(v["error"]["code"], "service_not_found");
    let (st, _) = call(&env.state, get("/guest/v1/services/bad!id/status")).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

// ── artifacts/seal ───────────────────────────────────────────────────────────

fn build_dist(workdir: &std::path::Path) {
    let dist = workdir.join("dist");
    std::fs::create_dir_all(dist.join("assets")).unwrap();

    std::fs::write(
        dist.join("index.html"),
        "<!doctype html><div id=root></div>",
    )
    .unwrap();
    std::fs::write(dist.join("assets/index-abc123.js"), "export const x = 1;\n").unwrap();
    std::fs::write(dist.join("assets/index-abc123.css"), "body{margin:0}").unwrap();

    std::fs::write(workdir.join("secret.env"), "TOKEN=eyJ").unwrap();
}

#[tokio::test]
async fn seal_is_deterministic_sorted_and_bounded() {
    let env = make_env(|_| {});
    build_dist(&env.workdir);
    let body = json!({
        "workdir": env.workdir.to_string_lossy(),
        "sessionId": "sess_svc_1", "revisionId":"revision_1", "outputDir": "dist",
        "maxFiles": 100,
        "maxBytes": 1_000_000
    });
    let (st, m1) = call(&env.state, post("/guest/v1/artifacts/seal", body.clone())).await;
    assert_eq!(st, StatusCode::OK, "body: {m1}");
    let (st, m2) = call(&env.state, post("/guest/v1/artifacts/seal", body.clone())).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(m1, m2, "sealing is deterministic");
    let paths: Vec<&str> = m1["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        paths,
        vec![
            "assets/index-abc123.css",
            "assets/index-abc123.js",
            "index.html"
        ],
        "sorted, no dot-prefixed entries, no symlinks"
    );
    let css = &m1["files"][0];
    assert_eq!(css["size"], 14);
    assert_eq!(
        css["sha256"],
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(b"body{margin:0}"))
    );
    assert_eq!(m1["totalBytes"], 14 + 20 + 34);

    // Bounds → typed 413.
    let mut b = body.clone();
    b["maxFiles"] = json!(2);
    let (st, v) = call(&env.state, post("/guest/v1/artifacts/seal", b)).await;
    assert_eq!(st, StatusCode::PAYLOAD_TOO_LARGE, "body: {v}");
    assert_eq!(v["error"]["code"], "artifact_bounds_exceeded");
    let mut b = body.clone();
    b["maxBytes"] = json!(40);
    let (st, v) = call(&env.state, post("/guest/v1/artifacts/seal", b)).await;
    assert_eq!(st, StatusCode::PAYLOAD_TOO_LARGE, "body: {v}");

    // Request bounds above the configured ceiling are clamped, not honoured.
    let env2 = make_env(|c| c.seal_max_files = 2);
    build_dist(&env2.workdir);
    let (st, v) = call(
        &env2.state,
        post(
            "/guest/v1/artifacts/seal",
            json!({"workdir": env2.workdir.to_string_lossy(), "sessionId": "sess_svc_1", "revisionId":"revision_1", "outputDir": "dist", "maxFiles": 10_000, "maxBytes": 1_000_000}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::PAYLOAD_TOO_LARGE, "body: {v}");

    // Absolute outputDir inside workdir is fine; escapes are refused.
    let abs = env.workdir.join("dist");
    let (st, _) = call(
        &env.state,
        post(
            "/guest/v1/artifacts/seal",
            json!({"workdir": env.workdir.to_string_lossy(), "sessionId": "sess_svc_1", "revisionId":"revision_1", "outputDir": abs.to_string_lossy()}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    for bad_out in ["../", "dist/../..", "/etc", "missing", "dist/index.html"] {
        let (st, v) = call(
            &env.state,
            post(
                "/guest/v1/artifacts/seal",
                json!({"workdir": env.workdir.to_string_lossy(), "sessionId": "sess_svc_1", "revisionId":"revision_1", "outputDir": bad_out}),
            ),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{bad_out}: {v}");
    }
    // outputDir that is a symlink pointing outside the workdir.
    let outside = std::env::temp_dir().join(format!("ga-seal-outside-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, env.workdir.join("out-link")).unwrap();
    let (st, _) = call(
        &env.state,
        post(
            "/guest/v1/artifacts/seal",
            json!({"workdir": env.workdir.to_string_lossy(), "sessionId": "sess_svc_1", "revisionId":"revision_1", "outputDir": "out-link"}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    // Workdir itself must live under the workspace root.
    let (st, _) = call(
        &env.state,
        post(
            "/guest/v1/artifacts/seal",
            json!({"workdir": "/tmp", "sessionId": "sess_svc_1", "revisionId":"revision_1", "outputDir": "."}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    std::fs::remove_dir_all(&outside).ok();
}

// ── HMAC ─────────────────────────────────────────────────────────────────────

fn signed_env() -> Env {
    let mut env = make_env(|_| {});
    env.state.hmac = Arc::new(HmacVerifier::new(
        SECRET.to_vec(),
        "acct_123",
        "vm_456",
        300,
        300,
    ));
    env
}

fn signed(method: &str, path: &str, query: &str, body: Option<Value>) -> Request<Body> {
    let signer = OutboundSigner::new(SECRET.to_vec(), "key_1", "acct_123", "vm_456");
    let raw = body.map(|b| b.to_string().into_bytes()).unwrap_or_default();
    let headers = signer.sign_request(method, path, query, &raw, Some("sess_svc_1"));
    let uri = if query.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{query}")
    };
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    for (k, v) in &headers.headers {
        builder = builder.header(*k, v);
    }
    builder.body(Body::from(raw)).unwrap()
}

#[tokio::test]
async fn unsigned_and_badly_signed_service_requests_are_rejected() {
    let env = signed_env();
    let body = start_body(&env, "svc_hmac_00001", vec!["sleep", "30"], 30_000);

    // Unsigned POSTs / GETs → 401 before any validation or spawn.
    let (st, v) = call(&env.state, post("/guest/v1/services/start", body.clone())).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "{v}");
    assert_eq!(v["error"]["code"], "unauthorized_hmac_missing");
    let (st, _) = call(
        &env.state,
        post(
            "/guest/v1/services/svc_hmac_00001/stop",
            json!({"generation": 1}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let (st, _) = call(&env.state, get("/guest/v1/services/svc_hmac_00001/status")).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let (st, _) = call(
        &env.state,
        get("/guest/v1/services/svc_hmac_00001/logs?limit=5"),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let (st, _) = call(
        &env.state,
        post(
            "/guest/v1/artifacts/seal",
            json!({"workdir": "/x", "sessionId": "sess_svc_1", "revisionId":"revision_1", "outputDir": "dist"}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert!(
        !state_file_path(&env.run_root).exists(),
        "nothing allocated"
    );

    // Tampered signature → 401 invalid.
    let mut req = signed("GET", "/guest/v1/services/svc_hmac_00001/status", "", None);
    req.headers_mut()
        .insert("x-pria-signature", "00".repeat(32).parse().unwrap());
    let (st, v) = call(&env.state, req).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "unauthorized_hmac_invalid");

    // Query string is part of the canonical string: signing without it fails.
    let mut req = signed("GET", "/guest/v1/services/svc_hmac_00001/logs", "", None);
    *req.uri_mut() = "/guest/v1/services/svc_hmac_00001/logs?limit=5"
        .parse()
        .unwrap();
    let (st, _) = call(&env.state, req).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    // Properly signed GETs pass verification (404 = reached the handler).
    let (st, v) = call(
        &env.state,
        signed("GET", "/guest/v1/services/svc_hmac_00001/status", "", None),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND, "{v}");
    assert_eq!(v["error"]["code"], "service_not_found");
    let (st, v) = call(
        &env.state,
        signed(
            "GET",
            "/guest/v1/services/svc_hmac_00001/logs",
            "limit=5&cursor=1",
            None,
        ),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND, "{v}");

    // Properly signed start round-trip.
    let (st, v) = call(
        &env.state,
        signed("POST", "/guest/v1/services/start", "", Some(body)),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["generation"], 1);
    let (st, v) = call(
        &env.state,
        signed(
            "POST",
            "/guest/v1/services/svc_hmac_00001/stop",
            "",
            Some(json!({"generation": 1})),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["state"], "stopped");
}

// ── agent restart: persisted state + orphan supersede ────────────────────────

#[tokio::test]
async fn restart_rehydrates_state_and_supersedes_a_live_orphan() {
    let env = make_env(|_| {});
    let id = "svc_orphan_001";
    let port = env.port_start + 3;

    // A "previous agent incarnation" left this server running (setsid'd) and
    // persisted its slot as active at generation 3.
    let orphan = {
        use std::os::unix::process::CommandExt;
        let mut cmd = std::process::Command::new("python3");
        cmd.args([
            "-m",
            "http.server",
            "--bind",
            "127.0.0.1",
            &port.to_string(),
        ])
        .current_dir(&env.workdir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
        // SAFETY: setsid is async-signal-safe; mirrors the supervisor.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        cmd.spawn().unwrap()
    };
    let orphan_pid = orphan.id();
    // Wait until the orphan holds the port.
    let deadline = Instant::now() + Duration::from_secs(10);
    while std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
        assert!(Instant::now() < deadline, "orphan never bound {port}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let state_path = state_file_path(&env.run_root);
    std::fs::create_dir_all(state_path.parent().unwrap()).unwrap();
    std::fs::write(
        &state_path,
        json!({"services": {
            id: {"port": port, "generation": 3, "pid": orphan_pid, "active": true},
            "svc_dead_00001": {"port": port + 1, "generation": 1, "pid": 4_000_000, "active": true}
        }})
        .to_string(),
    )
    .unwrap();

    // Startup reconciliation: the dead slot is released, the live one kept.
    let (released, live) = env.state.services.rehydrate();
    assert_eq!((released, live), (1, 1));
    let persisted: Value =
        serde_json::from_str(&std::fs::read_to_string(&state_path).unwrap()).unwrap();
    assert_eq!(persisted["services"]["svc_dead_00001"]["active"], false);
    assert_eq!(persisted["services"][id]["active"], true);

    // Another id must not be handed the orphan's port.
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, "svc_other_0001", vec!["sleep", "30"], 30_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    assert_ne!(v["port"], port);
    call(
        &env.state,
        post(
            "/guest/v1/services/svc_other_0001/stop",
            json!({"generation": 1}),
        ),
    )
    .await;

    // Starting the orphan's id supersedes it: group killed, generation 4.
    let (st, v) = call(
        &env.state,
        post(
            "/guest/v1/services/start",
            start_body(&env, id, http_server_cmd(), 10_000),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    assert_eq!(v["generation"], 4);
    assert_ne!(v["pid"], orphan_pid);
    wait_gone(orphan_pid as u64, Duration::from_secs(5)).await;
    wait_state(&env.state, id, &["ready"], Duration::from_secs(10)).await;
    let (st, v) = call(
        &env.state,
        post(
            &format!("/guest/v1/services/{id}/stop"),
            json!({"generation": 4}),
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "body: {v}");
    assert_eq!(v["state"], "stopped");
    // Zombie hygiene for the test's own child.
    let mut orphan = orphan;
    let _ = orphan.wait();
}

#[tokio::test]
async fn retained_release_proxy_proof_and_lifetime() {
    let env = signed_env();
    build_dist(&env.workdir);
    pria_guest_agent::test_support::seed_fixture_session(&env.state, env.workdir.clone());
    let (status,receipt)=call(&env.state,signed("POST","/guest/v1/artifacts/seal","",Some(json!({"sessionId":"fixture","revisionId":"revision_proxy","workdir":env.workdir,"outputDir":"dist"})))).await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    let start = json!({"serviceId":"release_proxy_1","generation":1,"requestId":"intent1","kind":"release","sessionId":"fixture","workdir":"/not-opened","command":["static-serve"],"readiness":{"path":"/","timeoutMs":1000},"artifact":{"revisionId":"revision_proxy","artifactDigest":receipt["artifactDigest"],"files":3,"base":"/p/r/revision_proxy/","navigationPaths":["/about/team"]}});
    let (status, r) = call(
        &env.state,
        signed("POST", "/guest/v1/services/start", "", Some(start)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{r}");
    let mut dev = start_body(&env, "close_fixture_dev", http_server_cmd(), 10000);
    dev["sessionId"] = json!("fixture");
    let (status, r) = call(
        &env.state,
        signed("POST", "/guest/v1/services/start", "", Some(dev)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{r}");
    let (status, r) = call(
        &env.state,
        signed(
            "POST",
            "/guest/v1/sessions/fixture/close",
            "",
            Some(json!({})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{r}");
    assert!(!env.state.sessions.contains("fixture"));
    assert_eq!(
        env.state.services.get("close_fixture_dev").unwrap().state(),
        pria_guest_agent::services::ServiceState::Stopped
    );
    let original = std::fs::read(env.workdir.join("dist/index.html")).unwrap();
    std::fs::remove_dir_all(&env.workdir).unwrap();
    for (tail, generation, method, expected) in [
        ("", 1, "GET", 200),
        ("about/team", 1, "GET", 200),
        ("missing.js", 1, "GET", 404),
        ("", 2, "GET", 503),
        ("", 1, "HEAD", 200),
    ] {
        let path = format!("/guest/v1/services/release_proxy_1/proxy/{generation}/{tail}");
        let mut request = signed(method, &path, "z=2&a=1", None);
        request
            .headers_mut()
            .insert("accept", "text/html".parse().unwrap());
        let nonce = request.headers()["x-pria-nonce"]
            .to_str()
            .unwrap()
            .to_owned();
        let response = build_router(env.state.clone())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected);
        let proof = response.headers()["x-pria-service-proof"]
            .to_str()
            .unwrap()
            .to_owned();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            proof,
            env.state
                .hmac
                .service_proof(&nonce, "release_proxy_1", generation, expected, &body)
        );
        if expected == 200 && method == "GET" {
            assert_eq!(&body[..], &original);
        }
    }
    let (status,_)=call(&env.state,signed("POST","/guest/v1/services/release_proxy_1/adopt","",Some(json!({"generation":1,"revisionId":"revision_proxy","artifactDigest":receipt["artifactDigest"]})))).await;
    assert_eq!(status, StatusCode::OK);
    let run_root = env.run_root.clone();
    let cfg = env.state.config.app_services.clone();
    let pria = env.pria.clone();
    drop(env); // actual old supervisor ownership ends before replacement
    let new_store = ServiceStore::new(&run_root, cfg, pria);
    assert_eq!(
        new_store
            .retained
            .serve("release_proxy_1", 1, "")
            .unwrap()
            .2,
        original
    );
}

#[tokio::test]
async fn durable_dev_intent_retry_conflict_restart_unavailable() {
    let env = signed_env();
    let mut body = start_body(&env, "durable_dev_1", http_server_cmd(), 10000);
    body["generation"] = json!(1);
    body["requestId"] = json!("intent1");
    let (status, first) = call(
        &env.state,
        signed("POST", "/guest/v1/services/start", "", Some(body.clone())),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let (status, retry) = call(
        &env.state,
        signed("POST", "/guest/v1/services/start", "", Some(body.clone())),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(retry["pid"], first["pid"]);
    let mut conflict = body.clone();
    conflict["requestId"] = json!("different");
    let (status, _) = call(
        &env.state,
        signed("POST", "/guest/v1/services/start", "", Some(conflict)),
    )
    .await;
    assert_ne!(status, StatusCode::OK);
    let mut restarted = env.state.clone();
    restarted.services = Arc::new(ServiceStore::new(
        &env.run_root,
        env.state.config.app_services.clone(),
        env.pria.clone(),
    ));
    let (status, response) = call(
        &restarted,
        signed("POST", "/guest/v1/services/start", "", Some(body)),
    )
    .await;
    assert_ne!(status, StatusCode::OK, "{response}");
    env.state.services.stop("durable_dev_1", 1).await.unwrap();
}

#[tokio::test]
async fn managed_dev_http_policy_and_websocket101() {
    let env = signed_env();
    let script = r#"import os,http.server,hashlib,base64
class H(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  if not self.path.startswith(os.environ['REVISION_BASE']):
   self.send_response(302);self.send_header('Location',os.environ['REVISION_BASE']);self.end_headers()
  elif self.path==os.environ['REVISION_BASE']+'ws':
   self.send_response(101);self.send_header('Upgrade','websocket');self.send_header('Connection','Upgrade');self.send_header('Sec-WebSocket-Accept',base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode());self.end_headers();self.wfile.flush()
   import time;time.sleep(2)
  elif self.path==os.environ['REVISION_BASE']+'redirect':
   self.send_response(302);self.send_header('Location','http://169.254.169.254/');self.end_headers()
  elif self.path==os.environ['REVISION_BASE']+'cookie':
   self.send_response(200);self.send_header('Set-Cookie','bad=1');self.end_headers()
  else:
   self.send_response(200);self.end_headers();self.wfile.write(b'ok')
http.server.ThreadingHTTPServer(('127.0.0.1',int(os.environ['PORT'])),H).serve_forever()
"#;
    let mut body = start_body(
        &env,
        "dev_proxy_ws1",
        vec!["python3", "-u", "-c", script],
        10000,
    );
    body["env"] = json!({"REVISION_BASE":"/pid/d/v3d.eyJwcm9qZWN0SWQiOiJwaWQiLCJzZXJ2aWNlSWQiOiJkZXZfcHJveHlfd3MxIiwiZ2VuZXJhdGlvbiI6MX0.ABCdef0123456789_-ABCdef0123456789_-ABCdef01234/"});
    let (status, r) = call(
        &env.state,
        signed("POST", "/guest/v1/services/start", "", Some(body)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{r}");
    for tail in ["", "assets/app.js"] {
        let path = format!("/guest/v1/services/dev_proxy_ws1/proxy/1/{tail}");
        let response = build_router(env.state.clone())
            .oneshot(signed("GET", &path, "", None))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    for tail in ["redirect", "cookie"] {
        let path = format!("/guest/v1/services/dev_proxy_ws1/proxy/1/{tail}");
        let response = build_router(env.state.clone())
            .oneshot(signed("GET", &path, "", None))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(!response.headers().contains_key("location"));
        assert!(!response.headers().contains_key("set-cookie"));
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = build_router(env.state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let path = "/guest/v1/services/dev_proxy_ws1/proxy/1/ws";
    let request = signed("GET", path, "", None);
    let nonce = request.headers()["x-pria-nonce"].to_str().unwrap();
    let mut outgoing = reqwest::Client::new()
        .get(format!("http://{addr}{path}"))
        .headers(request.headers().clone())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==");
    outgoing = outgoing.header("sec-websocket-protocol", "vite-hmr");
    let response = outgoing.send().await.unwrap();
    assert_eq!(response.status().as_u16(), 101);
    assert_eq!(
        response.headers()["x-pria-service-proof"],
        env.state
            .hmac
            .service_proof(nonce, "dev_proxy_ws1", 1, 101, b"")
    );
    assert_eq!(
        response.headers()["sec-websocket-accept"],
        "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
    );
    drop(response);
    env.state.services.stop("dev_proxy_ws1", 1).await.unwrap();
    server.abort();
}

#[tokio::test]
async fn pack_attestation_requires_auth_and_proves_unavailable_body() {
    let env = signed_env();
    let path = "/guest/v1/app-builder/attestation";
    let req = signed("GET", path, "", None);
    let nonce = req
        .headers()
        .get("x-pria-nonce")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let response = build_router(env.state.clone()).oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let proof = response
        .headers()
        .get("x-pria-service-proof")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert!(body.len() < 4096);
    assert_eq!(
        proof,
        env.state
            .hmac
            .service_proof(&nonce, "app_builder_pack", 1, 503, &body)
    );
    assert_ne!(
        proof,
        env.state
            .hmac
            .service_proof("other", "app_builder_pack", 1, 503, &body)
    );
    let unsigned = Request::builder().uri(path).body(Body::empty()).unwrap();
    assert_eq!(
        build_router(env.state.clone())
            .oneshot(unsigned)
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[test]
fn attestation_proof_matches_node_cross_runtime_vector() {
    let verifier = HmacVerifier::new(
        b"attestation-vector-secret".to_vec(),
        "acct_123",
        "vm_123",
        300,
        300,
    );
    let body=br#"{"accountId":"acct_123","vmId":"vm_123","pack":{"name":"pria-app-builder","version":"1.0.0","profile":"node-vite","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#;
    assert_eq!(
        verifier.service_proof("attestation_nonce_123", "app_builder_pack", 1, 200, body),
        "971d8b952c65b373929905b5b10265395b0468ab12a1d257001f7b3571986ce6"
    );
}
