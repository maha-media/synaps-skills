//! App-service supervisor (VM-Sites §6 D1 "Dev process lifecycle").
//!
//! A trusted in-guest supervisor for managed dev/release processes:
//!
//! * identity = `{serviceId, generation}` (plus the VM incarnation Pria owns);
//!   PID/port alone never identify a service;
//! * each child runs in its own session/process group (`setsid`) with a
//!   private loopback port injected as `PORT`/`HOST`, dropped to the owning
//!   session's Linux identity when the agent is root;
//! * readiness is an HTTP probe (`2xx`/`3xx`) with a bounded timeout;
//! * stdout/stderr are captured line-wise into a bounded ring ([`logs`]) and
//!   batched to Pria (`app-log`) best-effort;
//! * exits, readiness verdicts and stops are reported to Pria (`app-service`)
//!   best-effort with a short bounded retry — callback failure never blocks
//!   or alters the process lifecycle;
//! * stop = `SIGTERM` to the whole group, `SIGKILL` after the configured
//!   grace (same escalation as [`crate::desktop::container`]).
//!
//! State machine: `starting → ready | failed`, `ready → exited | failed`,
//! `{starting, ready} → stopping → stopped`. `exited`/`failed`/`stopped` are
//! terminal; a new start of the same `serviceId` bumps the generation.

pub mod build_cgroup;
pub mod build_sandbox;
pub mod dependency_bundle;
pub mod logs;
pub mod ports;
pub mod retained;
pub mod seal;
pub mod skill_pack;
pub mod source_build;
pub mod validate;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, watch};

use crate::config::AppServicesConfig;
use crate::error::{ErrorCode, GuestAgentError};
use crate::pria_client::{AppLogPayload, AppServiceEventPayload, PriaCallbackClient};
use logs::{now_ts, LogEntry, LogPage, LogRing, MAX_LINE_BYTES};
use ports::{pid_alive, port_is_free, PortAllocator, PortError};

/// Host every service binds to (never a routable interface).
pub const SERVICE_HOST: &str = "127.0.0.1";

/// Bounded retry schedule for `app-service` callbacks.
const EVENT_RETRY_BACKOFF: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_millis(1000),
    Duration::from_millis(3000),
];

/// Hard cap on retained (incl. terminal) records; oldest terminal ones are
/// pruned beyond it.
const MAX_RECORDS: usize = 256;

/// Readiness probe cadence + per-probe timeout.
const READINESS_INTERVAL: Duration = Duration::from_millis(250);
const READINESS_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Extra wait after SIGKILL before giving up on observing the exit.
const KILL_SETTLE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceState {
    Starting,
    Ready,
    Exited,
    Failed,
    Stopping,
    Stopped,
}

impl ServiceState {
    pub fn as_str(self) -> &'static str {
        match self {
            ServiceState::Starting => "starting",
            ServiceState::Ready => "ready",
            ServiceState::Exited => "exited",
            ServiceState::Failed => "failed",
            ServiceState::Stopping => "stopping",
            ServiceState::Stopped => "stopped",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            ServiceState::Exited | ServiceState::Failed | ServiceState::Stopped
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceKind {
    Dev,
    Release,
}

/// The Linux identity a service child is dropped to (root agents only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunAs {
    pub uid: u32,
    pub gid: u32,
    pub groups: Vec<u32>,
}

/// A fully validated start request (built by [`crate::api::services`]).
#[derive(Debug, Clone)]
pub struct StartSpec {
    pub service_id: String,
    pub kind: ServiceKind,
    pub session_id: String,
    /// Canonical, root-checked working directory.
    pub workdir: PathBuf,
    /// Absolute executable resolved from the allowlist.
    pub executable: PathBuf,
    /// Arguments (may carry `${PORT}`/`${HOST}` placeholders).
    pub args: Vec<String>,
    /// Allowlist-filtered environment (PORT/HOST are overwritten).
    pub env: BTreeMap<String, String>,
    pub readiness_path: String,
    pub readiness_timeout: Duration,
    pub max_log_bytes: usize,
    pub max_runtime: Duration,
    pub run_as: Option<RunAs>,
}

/// Public, serialisable view of a service record.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSnapshot {
    pub service_id: String,
    pub kind: ServiceKind,
    pub generation: u64,
    pub state: ServiceState,
    pub port: u16,
    pub pid: u32,
    /// Exit code once terminal; signal deaths are `128 + signal`.
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
    /// RFC 3339 time of the last state transition.
    pub since: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug)]
pub enum ServiceError {
    NotFound,
    GenerationStale { live: u64 },
    Busy,
    LimitExceeded(String),
    StartFailed(String),
    Io(String),
}

impl From<PortError> for ServiceError {
    fn from(e: PortError) -> Self {
        match e {
            PortError::Exhausted => ServiceError::LimitExceeded(e.to_string()),
            PortError::Io(m) => ServiceError::Io(m),
        }
    }
}

impl From<ServiceError> for GuestAgentError {
    fn from(e: ServiceError) -> Self {
        match e {
            ServiceError::NotFound => {
                GuestAgentError::new(ErrorCode::ServiceNotFound, "service not found")
            }
            ServiceError::GenerationStale { live } => GuestAgentError::new(
                ErrorCode::ServiceGenerationStale,
                format!("generation mismatch: live generation is {live}"),
            ),
            ServiceError::Busy => GuestAgentError::new(
                ErrorCode::ServiceBusy,
                "service is stopping; retry once it has settled",
            ),
            ServiceError::LimitExceeded(m) => {
                GuestAgentError::new(ErrorCode::ServiceLimitExceeded, m)
            }
            ServiceError::StartFailed(m) => GuestAgentError::new(ErrorCode::ServiceStartFailed, m),
            ServiceError::Io(m) => GuestAgentError::internal(m),
        }
    }
}

struct Status {
    state: ServiceState,
    exit_code: Option<i32>,
    signal: Option<i32>,
    since: String,
    detail: Option<String>,
}

/// One supervised service generation.
pub struct ServiceEntry {
    pub service_id: String,
    pub kind: ServiceKind,
    pub generation: u64,
    pub port: u16,
    pub pid: u32,
    pub session_id: String,
    /// Immutable base from the authenticated owning start intent; never proxy input.
    pub(crate) revision_base: String,
    pub started_at: String,
    status: Mutex<Status>,
    logs: Mutex<LogRing>,
    /// `false` while running, `true` once the OS wait returned (after the
    /// final state was recorded).
    exit_rx: watch::Receiver<bool>,
    exit_tx: Mutex<Option<watch::Sender<bool>>>,
    /// Mirrors `status.state` for async waiters (start fast-path).
    state_tx: watch::Sender<ServiceState>,
}

impl ServiceEntry {
    pub fn state(&self) -> ServiceState {
        self.status.lock().unwrap().state
    }

    pub fn snapshot(&self) -> ServiceSnapshot {
        let st = self.status.lock().unwrap();
        ServiceSnapshot {
            service_id: self.service_id.clone(),
            kind: self.kind,
            generation: self.generation,
            state: st.state,
            port: self.port,
            pid: self.pid,
            exit_code: st.exit_code,
            signal: st.signal,
            since: st.since.clone(),
            started_at: self.started_at.clone(),
            detail: st.detail.clone(),
        }
    }

    pub fn logs(&self, cursor: Option<u64>, limit: usize) -> LogPage {
        self.logs.lock().unwrap().read(cursor, limit)
    }

    /// Record a transition. Returns `false` when the current state is already
    /// terminal (terminal states are sticky; only exit details are filled in).
    fn transition(&self, to: ServiceState, detail: Option<String>) -> bool {
        let mut st = self.status.lock().unwrap();
        if st.state.is_terminal() || st.state == to {
            return false;
        }
        st.state = to;
        st.since = now_ts();
        if detail.is_some() {
            st.detail = detail;
        }
        let _ = self.state_tx.send(to);
        true
    }

    fn record_exit(&self, exit_code: Option<i32>, signal: Option<i32>) {
        let mut st = self.status.lock().unwrap();
        st.exit_code = exit_code;
        st.signal = signal;
    }
}

/// The supervisor. Shared through `AppState.services`.
pub struct ServiceStore {
    pub retained: retained::RetainedStore,
    cfg: AppServicesConfig,
    pria: Arc<dyn PriaCallbackClient>,
    ports: PortAllocator,
    entries: Mutex<HashMap<String, Arc<ServiceEntry>>>,
    /// Serialises start/allocation so two concurrent starts of one id cannot
    /// both spawn.
    start_lock: tokio::sync::Mutex<()>,
    intent_lock: tokio::sync::Mutex<()>,
    is_root: bool,
}

impl ServiceStore {
    pub fn new(
        run_root: &std::path::Path,
        cfg: AppServicesConfig,
        pria: Arc<dyn PriaCallbackClient>,
    ) -> Self {
        let ports = PortAllocator::new(run_root, cfg.port_range_start, cfg.port_range_end);
        // SAFETY: geteuid has no failure modes or side effects.
        let is_root = unsafe { libc::geteuid() } == 0;
        Self {
            retained: retained::RetainedStore::new(cfg.retained_root.clone()),
            cfg,
            pria,
            ports,
            entries: Mutex::new(HashMap::new()),
            start_lock: tokio::sync::Mutex::new(()),
            intent_lock: tokio::sync::Mutex::new(()),
            is_root,
        }
    }

    pub fn config(&self) -> &AppServicesConfig {
        &self.cfg
    }

    /// Whether the agent runs as root (and must drop privileges per service).
    pub fn is_root(&self) -> bool {
        self.is_root
    }

    /// Startup reconciliation of the persisted port state (see
    /// [`PortAllocator::rehydrate`]). Returns `(released, still_live)`.
    pub fn rehydrate(&self) -> (usize, usize) {
        match self.ports.rehydrate() {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "app-service port state rehydrate failed");
                (0, 0)
            }
        }
    }

    pub fn get(&self, service_id: &str) -> Option<Arc<ServiceEntry>> {
        self.entries.lock().unwrap().get(service_id).cloned()
    }

    pub fn status(&self, service_id: &str) -> Option<ServiceSnapshot> {
        self.get(service_id).map(|e| e.snapshot())
    }

    pub fn logs(&self, service_id: &str, cursor: Option<u64>, limit: usize) -> Option<LogPage> {
        self.get(service_id).map(|e| e.logs(cursor, limit))
    }

    /// All records (heartbeat/debug).
    pub fn list(&self) -> Vec<ServiceSnapshot> {
        self.entries
            .lock()
            .unwrap()
            .values()
            .map(|e| e.snapshot())
            .collect()
    }

    fn live_count(&self) -> usize {
        self.entries
            .lock()
            .unwrap()
            .values()
            .filter(|e| !e.state().is_terminal())
            .count()
    }

    fn prune_terminal(&self) {
        let mut map = self.entries.lock().unwrap();
        while map.len() >= MAX_RECORDS {
            let oldest = map
                .values()
                .filter(|e| e.state().is_terminal())
                .min_by_key(|e| e.status.lock().unwrap().since.clone())
                .map(|e| e.service_id.clone());
            match oldest {
                Some(id) => {
                    map.remove(&id);
                }
                None => break,
            }
        }
    }

    pub async fn start_durable(
        &self,
        spec: StartSpec,
        intent: &str,
    ) -> Result<ServiceSnapshot, ServiceError> {
        let _g = self.intent_lock.lock().await;
        let fresh = self
            .retained
            .claim_intent(&spec.service_id, intent)
            .map_err(ServiceError::StartFailed)?;
        if !fresh {
            return self.status(&spec.service_id).ok_or_else(|| {
                ServiceError::StartFailed(
                    "prior service intent unavailable after restart; refusing duplicate execution"
                        .into(),
                )
            });
        }
        self.start(spec).await
    }

    /// Start (or idempotently return) a service.
    pub async fn start(&self, spec: StartSpec) -> Result<ServiceSnapshot, ServiceError> {
        let _guard = self.start_lock.lock().await;

        if let Some(existing) = self.get(&spec.service_id) {
            match existing.state() {
                ServiceState::Starting | ServiceState::Ready => return Ok(existing.snapshot()),
                ServiceState::Stopping => return Err(ServiceError::Busy),
                _ => {}
            }
        }
        if self.live_count() >= self.cfg.max_services {
            return Err(ServiceError::LimitExceeded(format!(
                "max_services ({}) reached",
                self.cfg.max_services
            )));
        }
        if self.is_root && spec.run_as.is_none() {
            return Err(ServiceError::StartFailed(
                "refusing to run a service as root: no workload identity".into(),
            ));
        }

        // Supersede an orphan of the same id left by a previous agent
        // incarnation (setsid'd children outlive the agent). Only when the
        // recorded pid is alive AND its port is actually held.
        if let Ok(Some(slot)) = self.ports.slot(&spec.service_id) {
            if slot.active && self.get(&spec.service_id).is_none() {
                if let Some(pid) = slot.pid {
                    if pid_alive(pid) && !port_is_free(slot.port) {
                        tracing::warn!(
                            service_id = %spec.service_id,
                            pid,
                            port = slot.port,
                            "superseding orphaned app-service process group"
                        );
                        kill_group(pid, libc::SIGTERM);
                        tokio::time::sleep(Duration::from_millis(self.cfg.stop_grace_ms.min(2000)))
                            .await;
                        if pid_alive(pid) {
                            kill_group(pid, libc::SIGKILL);
                            tokio::time::sleep(Duration::from_millis(200)).await;
                        }
                    }
                }
            }
        }

        let alloc = self.ports.allocate(&spec.service_id)?;
        let port = alloc.port;
        let generation = alloc.generation;

        let mut child = match spawn_child(&spec, port) {
            Ok(c) => c,
            Err(e) => {
                let _ = self.ports.release(&spec.service_id);
                return Err(ServiceError::StartFailed(e));
            }
        };
        let pid = match child.id() {
            Some(p) => p,
            None => {
                let _ = self.ports.release(&spec.service_id);
                return Err(ServiceError::StartFailed(
                    "child exited before it could be tracked".into(),
                ));
            }
        };
        let _ = self.ports.set_pid(&spec.service_id, pid);

        let (exit_tx, exit_rx) = watch::channel(false);
        let (state_tx, _state_rx) = watch::channel(ServiceState::Starting);
        let started_at = now_ts();
        let entry = Arc::new(ServiceEntry {
            service_id: spec.service_id.clone(),
            kind: spec.kind,
            generation,
            port,
            pid,
            session_id: spec.session_id.clone(),
            revision_base: spec
                .env
                .get("REVISION_BASE")
                .cloned()
                .unwrap_or_else(|| "/".into()),
            started_at: started_at.clone(),
            status: Mutex::new(Status {
                state: ServiceState::Starting,
                exit_code: None,
                signal: None,
                since: started_at,
                detail: None,
            }),
            logs: Mutex::new(LogRing::new(
                spec.max_log_bytes.min(self.cfg.log_ring_max_bytes),
                self.cfg.log_ring_max_entries,
            )),
            exit_rx,
            exit_tx: Mutex::new(Some(exit_tx)),
            state_tx,
        });
        self.prune_terminal();
        self.entries
            .lock()
            .unwrap()
            .insert(spec.service_id.clone(), entry.clone());
        tracing::info!(
            service_id = %spec.service_id,
            generation,
            port,
            pid,
            kind = ?spec.kind,
            executable = %spec.executable.display(),
            "app-service spawned"
        );

        // ── log capture + batching ───────────────────────────────────────
        let (log_tx, log_rx) = mpsc::channel::<LogEntry>(4096);
        if let Some(out) = child.stdout.take() {
            tokio::spawn(pump_lines(out, "stdout", entry.clone(), log_tx.clone()));
        }
        if let Some(err) = child.stderr.take() {
            tokio::spawn(pump_lines(err, "stderr", entry.clone(), log_tx.clone()));
        }
        drop(log_tx);
        tokio::spawn(log_batcher(
            log_rx,
            self.pria.clone(),
            spec.session_id.clone(),
            spec.service_id.clone(),
            generation,
            self.cfg.log_batch_max_entries.max(1),
            Duration::from_millis(self.cfg.log_batch_interval_ms.max(50)),
        ));

        // ── exit watcher (owns the Child) ────────────────────────────────
        {
            let entry = entry.clone();
            let ports = self.ports.clone();
            let pria = self.pria.clone();
            tokio::spawn(async move {
                let status = child.wait().await;
                let (code, signal) = match status {
                    Ok(s) => {
                        use std::os::unix::process::ExitStatusExt;
                        (s.code(), s.signal())
                    }
                    Err(_) => (None, None),
                };
                let exit_code = code.or(signal.map(|s| 128 + s));
                entry.record_exit(exit_code, signal);
                let to = match entry.state() {
                    ServiceState::Stopping => ServiceState::Stopped,
                    ServiceState::Starting | ServiceState::Ready => {
                        if code == Some(0) {
                            ServiceState::Exited
                        } else {
                            ServiceState::Failed
                        }
                    }
                    terminal => terminal,
                };
                let detail = match (code, signal) {
                    (Some(c), _) => format!("exit code {c}"),
                    (None, Some(s)) => format!("killed by signal {s}"),
                    _ => "exit status unavailable".to_string(),
                };
                entry.transition(to, Some(detail));
                let final_state = entry.state();
                let _ = ports.release(&entry.service_id);
                tracing::info!(
                    service_id = %entry.service_id,
                    generation = entry.generation,
                    state = final_state.as_str(),
                    ?exit_code,
                    "app-service exited"
                );
                if let Some(tx) = entry.exit_tx.lock().unwrap().take() {
                    let _ = tx.send(true);
                }
                emit_event(
                    pria,
                    entry.session_id.clone(),
                    AppServiceEventPayload {
                        service_id: entry.service_id.clone(),
                        generation: entry.generation,
                        state: final_state.as_str().to_string(),
                        exit_code,
                        observed_at: now_ts(),
                        port: None,
                    },
                );
            });
        }

        // ── readiness probe ──────────────────────────────────────────────
        {
            let entry = entry.clone();
            let pria = self.pria.clone();
            let grace = Duration::from_millis(self.cfg.stop_grace_ms);
            let path = spec.readiness_path.clone();
            let timeout = spec.readiness_timeout;
            tokio::spawn(async move {
                readiness_loop(entry, pria, path, timeout, grace).await;
            });
        }

        // ── runtime ceiling ──────────────────────────────────────────────
        {
            let entry = entry.clone();
            let grace = Duration::from_millis(self.cfg.stop_grace_ms);
            let max_runtime = spec.max_runtime;
            tokio::spawn(async move {
                let mut exit_rx = entry.exit_rx.clone();
                if wait_exit(&mut exit_rx, max_runtime).await {
                    return;
                }
                if entry.transition(
                    ServiceState::Failed,
                    Some(format!("runtime limit {}s exceeded", max_runtime.as_secs())),
                ) {
                    tracing::warn!(
                        service_id = %entry.service_id,
                        generation = entry.generation,
                        "app-service runtime limit exceeded; killing group"
                    );
                    kill_group_graceful(entry.pid, grace, entry.exit_rx.clone()).await;
                }
            });
        }

        drop(_guard);

        // Fast path: give a quick server the chance to answer `ready` inline,
        // but never hold the caller past `start_wait_ms`.
        let mut state_rx = entry.state_tx.subscribe();
        let wait = Duration::from_millis(self.cfg.start_wait_ms);
        let _ = tokio::time::timeout(wait, async {
            while *state_rx.borrow_and_update() == ServiceState::Starting {
                if state_rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
        Ok(entry.snapshot())
    }

    /// Session teardown never reaches retained release bindings.
    pub async fn stop_session_dev(&self, session: &str) {
        let entries: Vec<_> = self
            .entries
            .lock()
            .unwrap()
            .values()
            .filter(|e| e.kind == ServiceKind::Dev && e.session_id == session)
            .cloned()
            .collect();
        for e in entries {
            let _ = self.stop(&e.service_id, e.generation).await;
        }
    }

    /// Generation-fenced stop. Idempotent for terminal records.
    pub async fn stop(
        &self,
        service_id: &str,
        generation: u64,
    ) -> Result<ServiceSnapshot, ServiceError> {
        let entry = self.get(service_id).ok_or(ServiceError::NotFound)?;
        if entry.generation != generation {
            return Err(ServiceError::GenerationStale {
                live: entry.generation,
            });
        }
        let already_terminal = {
            let st = entry.status.lock().unwrap();
            st.state.is_terminal()
        };
        if already_terminal {
            return Ok(entry.snapshot());
        }
        if entry.transition(ServiceState::Stopping, Some("stop requested".into())) {
            tracing::info!(
                service_id,
                generation,
                pid = entry.pid,
                "app-service stop requested"
            );
        }
        let grace = Duration::from_millis(self.cfg.stop_grace_ms);
        kill_group_graceful(entry.pid, grace, entry.exit_rx.clone()).await;
        Ok(entry.snapshot())
    }
}

// ── process helpers ──────────────────────────────────────────────────────────

/// Signal an entire process group (the child called `setsid`, so its pid is
/// the pgid). Best-effort: ESRCH after exit is fine. Same primitive as
/// `desktop::container::kill_group`.
pub fn kill_group(pid: u32, signal: libc::c_int) {
    // SAFETY: plain kill(2) on a pgid we created; no memory safety concerns.
    unsafe {
        libc::kill(-(pid as libc::pid_t), signal);
    }
}

/// Wait until the exit watch fires or `timeout` elapses. Returns `true` on exit.
async fn wait_exit(exit_rx: &mut watch::Receiver<bool>, timeout: Duration) -> bool {
    if *exit_rx.borrow() {
        return true;
    }
    match tokio::time::timeout(timeout, exit_rx.changed()).await {
        Ok(Ok(())) => *exit_rx.borrow(),
        Ok(Err(_)) => true, // sender dropped ⇒ watcher finished
        Err(_) => false,
    }
}

/// `SIGTERM` the group, escalate to `SIGKILL` after `grace`, then wait a
/// bounded settle window for the OS exit to be observed.
async fn kill_group_graceful(pid: u32, grace: Duration, mut exit_rx: watch::Receiver<bool>) {
    if *exit_rx.borrow() {
        return;
    }
    kill_group(pid, libc::SIGTERM);
    if wait_exit(&mut exit_rx, grace).await {
        return;
    }
    tracing::warn!(
        pid,
        "app-service ignored SIGTERM within grace; sending SIGKILL"
    );
    kill_group(pid, libc::SIGKILL);
    let _ = wait_exit(&mut exit_rx, KILL_SETTLE).await;
}

fn spawn_child(spec: &StartSpec, port: u16) -> Result<tokio::process::Child, String> {
    let mut cmd = tokio::process::Command::new(&spec.executable);
    for arg in &spec.args {
        cmd.arg(validate::substitute_arg(arg, port, SERVICE_HOST));
    }
    cmd.env_clear();
    // Baseline PATH/HOME so toolchains work even when the caller sends none;
    // the caller's allowlisted values win, PORT/HOST are always ours.
    let path = "/usr/local/bin:/usr/bin:/bin";
    let home = spec.workdir.to_string_lossy();
    cmd.env("PATH", path).env("HOME", home.as_ref());
    for (k, v) in &spec.env {
        if k != "PATH" && k != "HOME" {
            cmd.env(k, v);
        }
    }
    cmd.env("DEV_PORT", port.to_string())
        .env("PORT", port.to_string())
        .env("HOST", SERVICE_HOST)
        .current_dir(&spec.workdir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // The service must outlive any request-handler drop; stop() and the
        // exit watcher own termination explicitly.
        .kill_on_drop(false);
    {
        let run_as = spec.run_as.clone();
        let groups: Vec<libc::gid_t> = run_as
            .as_ref()
            .map(|ra| ra.groups.iter().map(|g| *g as libc::gid_t).collect())
            .unwrap_or_default();
        // SAFETY: pre_exec runs in the forked child before exec and only calls
        // async-signal-safe syscalls (setsid/setgroups/setgid/setuid) over an
        // owned, pre-allocated gid slice — no allocation, no locks. The drop
        // order setgroups → setgid → setuid mirrors `synaps::launcher`.
        unsafe {
            cmd.pre_exec(move || {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if let Some(ra) = &run_as {
                    if libc::setgroups(groups.len() as _, groups.as_ptr()) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::setgid(ra.gid as libc::gid_t) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::setuid(ra.uid as libc::uid_t) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                // Descendants cannot regain privileges via setuid executables.
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // Per-process bounds, not aggregate cgroup isolation. Avoid
                // RLIMIT_NPROC: it is UID-wide and can damage peer services.
                for (resource, value) in [
                    (libc::RLIMIT_CORE, 0),
                    (libc::RLIMIT_NOFILE, 1024),
                    (libc::RLIMIT_FSIZE, 256 * 1024 * 1024),
                ] {
                    let limit = libc::rlimit {
                        rlim_cur: value,
                        rlim_max: value,
                    };
                    if libc::setrlimit(resource, &limit) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
    }
    cmd.spawn()
        .map_err(|e| format!("spawn {}: {e}", spec.executable.display()))
}

/// Read a child stream, split into bounded lines, push each into the ring and
/// fan out to the batcher (`try_send`: a slow callback path never blocks the
/// reader).
async fn pump_lines<R>(
    mut reader: R,
    stream: &'static str,
    entry: Arc<ServiceEntry>,
    tx: mpsc::Sender<LogEntry>,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut chunk = [0u8; 4096];
    let mut partial: Vec<u8> = Vec::new();
    let mut discarding = false;
    let emit = |bytes: &[u8]| {
        let line = String::from_utf8_lossy(bytes).into_owned();
        let e = entry.logs.lock().unwrap().push(stream, line);
        let _ = tx.try_send(e);
    };
    loop {
        let n = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let mut start = 0;
        for (i, b) in chunk[..n].iter().enumerate() {
            if *b == b'\n' {
                if !discarding {
                    partial.extend_from_slice(&chunk[start..i]);
                    emit(&partial);
                }
                partial.clear();
                discarding = false;
                start = i + 1;
            }
        }
        if start < n && !discarding {
            partial.extend_from_slice(&chunk[start..n]);
            if partial.len() > MAX_LINE_BYTES {
                // Unterminated runaway line: emit what we have (cut by the
                // ring) and discard the remainder up to the next newline.
                emit(&partial);
                partial.clear();
                discarding = true;
            }
        }
    }
    if !partial.is_empty() && !discarding {
        emit(&partial);
    }
}

/// Batch log entries (≤ `max_entries` or `interval` since the first buffered
/// entry) into `app-log` callbacks. Flushes the tail on channel close.
async fn log_batcher(
    mut rx: mpsc::Receiver<LogEntry>,
    pria: Arc<dyn PriaCallbackClient>,
    session_id: String,
    service_id: String,
    generation: u64,
    max_entries: usize,
    interval: Duration,
) {
    let flush = |entries: Vec<LogEntry>| {
        let pria = pria.clone();
        let session_id = session_id.clone();
        let service_id = service_id.clone();
        async move {
            let payload = AppLogPayload {
                service_id,
                generation,
                entries,
            };
            if let Err(e) = pria.app_log(&session_id, &payload).await {
                tracing::debug!(error = %e, service_id = %payload.service_id, "app-log callback failed; batch dropped");
            }
        }
    };
    loop {
        let Some(first) = rx.recv().await else {
            return;
        };
        let mut batch = vec![first];
        let deadline = tokio::time::sleep(interval);
        tokio::pin!(deadline);
        let mut closed = false;
        while batch.len() < max_entries {
            tokio::select! {
                _ = &mut deadline => break,
                next = rx.recv() => match next {
                    Some(e) => batch.push(e),
                    None => { closed = true; break; }
                }
            }
        }
        flush(batch).await;
        if closed {
            return;
        }
    }
}

/// Poll `GET http://127.0.0.1:{port}{path}` until `2xx`/`3xx` (→ `ready`) or
/// the timeout (→ `failed` + group kill). Aborts silently when the process
/// exits first (the exit watcher owns that verdict).
async fn readiness_loop(
    entry: Arc<ServiceEntry>,
    pria: Arc<dyn PriaCallbackClient>,
    path: String,
    timeout: Duration,
    grace: Duration,
) {
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(READINESS_PROBE_TIMEOUT)
        .no_proxy()
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = %e, "readiness http client unavailable");
            entry.transition(
                ServiceState::Failed,
                Some("readiness client unavailable".into()),
            );
            kill_group_graceful(entry.pid, grace, entry.exit_rx.clone()).await;
            return;
        }
    };
    let url = format!("http://{SERVICE_HOST}:{}{}", entry.port, path);
    let deadline = tokio::time::Instant::now() + timeout;
    let mut exit_rx = entry.exit_rx.clone();
    loop {
        if entry.state() != ServiceState::Starting || *exit_rx.borrow() {
            return;
        }
        let probe = client.get(&url).send();
        let ready = tokio::select! {
            _ = exit_rx.changed() => return,
            res = probe => matches!(res, Ok(r) if r.status().is_success() || r.status().is_redirection()),
        };
        if ready {
            if entry.transition(
                ServiceState::Ready,
                Some("readiness probe succeeded".into()),
            ) {
                tracing::info!(
                    service_id = %entry.service_id,
                    generation = entry.generation,
                    port = entry.port,
                    "app-service ready"
                );
                emit_event(
                    pria,
                    entry.session_id.clone(),
                    AppServiceEventPayload {
                        service_id: entry.service_id.clone(),
                        generation: entry.generation,
                        state: ServiceState::Ready.as_str().to_string(),
                        exit_code: None,
                        observed_at: now_ts(),
                        port: Some(entry.port),
                    },
                );
            }
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            if entry.transition(
                ServiceState::Failed,
                Some(format!("readiness timeout after {}ms", timeout.as_millis())),
            ) {
                tracing::warn!(
                    service_id = %entry.service_id,
                    generation = entry.generation,
                    "app-service readiness timed out; killing group"
                );
                kill_group_graceful(entry.pid, grace, entry.exit_rx.clone()).await;
            }
            return;
        }
        tokio::select! {
            _ = exit_rx.changed() => return,
            _ = tokio::time::sleep(READINESS_INTERVAL) => {}
        }
    }
}

/// Fire-and-forget `app-service` callback with a short bounded retry.
fn emit_event(
    pria: Arc<dyn PriaCallbackClient>,
    session_id: String,
    payload: AppServiceEventPayload,
) {
    tokio::spawn(async move {
        for (attempt, backoff) in EVENT_RETRY_BACKOFF.iter().enumerate() {
            match pria.app_service_event(&session_id, &payload).await {
                Ok(()) => return,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        service_id = %payload.service_id,
                        generation = payload.generation,
                        state = %payload.state,
                        attempt,
                        "app-service callback failed"
                    );
                    tokio::time::sleep(*backoff).await;
                }
            }
        }
        if let Err(e) = pria.app_service_event(&session_id, &payload).await {
            tracing::error!(
                error = %e,
                service_id = %payload.service_id,
                generation = payload.generation,
                state = %payload.state,
                "app-service callback abandoned after retries"
            );
        }
    });
}

#[cfg(test)]
mod child_controls_tests {
    use super::*;

    #[tokio::test]
    async fn child_controls_are_local_and_home_does_not_inherit_agent_home() {
        let root = std::env::temp_dir().join(format!("child-controls-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let mut parent_limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut parent_limit) },
            0
        );
        let spec = StartSpec {
            service_id: "controls_test".into(), kind: ServiceKind::Dev,
            session_id: "test".into(), workdir: root.clone(),
            executable: "/usr/bin/python3".into(),
            args: vec!["-c".into(), "import os,json,resource; print(json.dumps({'home':os.environ['HOME'],'nofile':resource.getrlimit(resource.RLIMIT_NOFILE),'core':resource.getrlimit(resource.RLIMIT_CORE),'fsize':resource.getrlimit(resource.RLIMIT_FSIZE),'status':open('/proc/self/status').read()}))".into()],
            env: BTreeMap::new(), readiness_path: "/".into(),
            readiness_timeout: Duration::from_secs(1), max_log_bytes: 4096,
            max_runtime: Duration::from_secs(1), run_as: None,
        };
        let output = spawn_child(&spec, 12345)
            .unwrap()
            .wait_with_output()
            .await
            .unwrap();
        assert!(output.status.success());
        let data: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(data["home"], root.to_string_lossy().as_ref());
        assert_eq!(data["nofile"], serde_json::json!([1024, 1024]));
        assert_eq!(data["core"], serde_json::json!([0, 0]));
        assert_eq!(data["fsize"], serde_json::json!([268435456, 268435456]));
        assert!(data["status"].as_str().unwrap().contains("NoNewPrivs:\t1"));
        let mut after = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut after) },
            0
        );
        assert_eq!(
            (after.rlim_cur, after.rlim_max),
            (parent_limit.rlim_cur, parent_limit.rlim_max)
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
