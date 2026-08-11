//! Synaps process launcher (spec §6.4 step 4, §16.3) + HS-6 boundary tagger.
//!
//! The guest agent launches `synaps` directly and MAY set
//! `SYNAPS_SESSION_CONTEXT` on that parent process — but core ignores it
//! (HS-7), so the env var is best-effort and the context FILE is authoritative.
//!
//! Privilege drop: the process is started with the target uid/gid via
//! `CommandExt::{uid,gid}`. Launching as root is refused (spec §16.3 "never
//! start Synaps as root").
//!
//! HS-6: SynapsCLI `RpcEvent`s carry no account/session tagging
//! (`core/rpc_protocol.rs`). The guest agent tags them at the boundary (it knows
//! `session_id`) before relaying to Pria's transport via session-event.

use std::collections::HashMap;
use std::path::PathBuf;

use async_trait::async_trait;
use serde_json::Value;

use crate::pria_client::payloads::{
    derive_idempotency_key, normalise_usage, EVENT_TYPE_LLM_TOKENS, SOURCE_ON_USAGE,
    SOURCE_RPC_AGENT_END,
};
use crate::pria_client::{SessionEventPayload, UsageEvent, UsagePayload};

/// Everything needed to launch a session process.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub binary: PathBuf,
    pub args: Vec<String>,
    pub uid: u32,
    pub gid: u32,
    /// Full supplementary group list (primary + per-instance `inst_<id>`
    /// groups) for an initgroups-style privilege drop. When non-empty the
    /// child runs with EXACTLY these groups — gaining its authorized instance
    /// groups and dropping the agent's (root's) supplementary groups. Empty
    /// keeps the historical behavior (no setgroups).
    pub groups: Vec<u32>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub context_path: PathBuf,
    pub session_id: String,
}

/// Launch failure.
#[derive(Debug)]
pub struct LaunchError(pub String);

impl std::fmt::Display for LaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for LaunchError {}

/// Lifecycle status of a launched session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    Starting,
    Running,
    Cancelled,
    Closed,
    Exited,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Starting => "starting",
            SessionStatus::Running => "running",
            SessionStatus::Cancelled => "cancelled",
            SessionStatus::Closed => "closed",
            SessionStatus::Exited => "exited",
        }
    }
}

/// A handle to a launched session process.
#[async_trait]
pub trait SessionProcess: Send + Sync {
    fn pid(&self) -> u32;
    async fn send(&self, message: &str) -> Result<(), LaunchError>;
    async fn cancel(&self) -> Result<(), LaunchError>;
    async fn close(&self, grace_ms: u64) -> Result<(), LaunchError>;
    fn status(&self) -> SessionStatus;
    /// Take the child's output stream exactly once, for the usage-relay reader
    /// task (spec §5.5 / HS-U6). Returns `None` when unavailable — already taken,
    /// or a backend with no output channel. Default: `None`.
    ///
    /// Typed as an opaque `AsyncRead` rather than `tokio::process::ChildStdout`
    /// because the relay only ever reads lines from it. Keeping the concrete
    /// process type here made readiness untestable: a fake process cannot
    /// manufacture a `ChildStdout` without spawning a real OS process, so every
    /// fake-launcher test of `/sessions/start` failed the ready handshake.
    fn take_stdout(&self) -> Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>> {
        None
    }
    /// Await the child process's natural exit. Used by the zombie reaper task
    /// (`api/sessions.rs` `start` handler) to learn when to remove the session
    /// from the store after the child dies. Default impl never resolves so
    /// existing impls that don't back a real OS process are unaffected.
    async fn wait_for_exit(&self) {
        std::future::pending::<()>().await
    }
}

/// Launches session processes.
#[async_trait]
pub trait SynapsLauncher: Send + Sync {
    async fn launch(
        &self,
        spec: &LaunchSpec,
    ) -> Result<std::sync::Arc<dyn SessionProcess>, LaunchError>;
}

// ── HS-6 boundary tagger ─────────────────────────────────────────────────────

/// Tag a raw SynapsCLI `RpcEvent` (untagged JSON) with session identity and
/// wrap it as a Pria `session-event` payload. This is the HS-6 mitigation: the
/// guest agent supplies the account/instance/user/session tags SynapsCLI core
/// cannot.
pub fn tag_rpc_event(
    raw_event: &Value,
    account_id: &str,
    instance_id: &str,
    user_id: &str,
    session_id: &str,
) -> SessionEventPayload {
    let event_type = raw_event
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("synaps.output")
        .to_string();
    SessionEventPayload {
        account_id: account_id.to_string(),
        instance_id: instance_id.to_string(),
        user_id: user_id.to_string(),
        session_id: session_id.to_string(),
        event_id: format!("evt_{}", uuid::Uuid::new_v4()),
        event_type,
        payload: raw_event.clone(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    }
}

// ── HS-U6 RPC-boundary usage fallback ────────────────────────────────────────

/// Identity needed to tag an untagged `RpcEvent` with attribution.
#[derive(Debug, Clone)]
pub struct UsageIdentity {
    pub account_id: String,
    pub instance_id: String,
    pub user_id: String,
    pub vm_id: String,
    pub replica_id: String,
    pub session_id: String,
    pub ephemeral_task_id: Option<String>,
}

/// Validated startup receipt from Synaps RPC's first lifecycle frame.
///
/// `session_id` emitted by Synaps is its own runtime-session identifier, not
/// Pria's control-plane session id. The guest binds the process to the Pria id
/// at launch, so readiness validates the event type/protocol and returns only
/// the model + protocol receipt for that bound process.
#[derive(Debug, Clone)]
pub struct RpcReadyReceipt {
    pub model: String,
    pub protocol_version: u32,
}

/// Meter a raw SynapsCLI `RpcEvent::AgentEnd { usage }` (untagged JSON) into a
/// Pria [`UsagePayload`]. This is the **no-core-change fallback** (spec §0.2,
/// HS-U6): SynapsCLI emits `agent_end` with a `usage` object but no account /
/// session identity (`core/rpc_protocol.rs:272`), so the guest agent supplies
/// the tags it knows and forwards raw usage to `/internal/agentic-vm/usage`.
///
/// Returns `None` for any event that is not an `agent_end` carrying a `usage`
/// object — the relay should ignore it (zero-token usage is also dropped so we
/// never bill an empty turn). Emits **raw usage only** (no credits, spec §5.5).
pub fn tag_agent_end_usage(raw_event: &Value, identity: &UsageIdentity) -> Option<UsagePayload> {
    // `RpcEvent` is `#[serde(tag = "type")]`; the AgentEnd variant renames to
    // "agent_end" and flattens `usage` (a `TurnUsage`) under the `usage` key.
    if raw_event.get("type").and_then(|t| t.as_str()) != Some("agent_end") {
        return None;
    }
    let usage_raw = raw_event.get("usage")?;
    let usage = normalise_usage(usage_raw);

    // Drop genuinely empty turns — nothing to bill, nothing to cross-check.
    let any_tokens = [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ]
    .iter()
    .any(|k| usage.get(*k).and_then(|v| v.as_u64()).unwrap_or(0) > 0);
    if !any_tokens {
        return None;
    }

    let model = usage_raw
        .get("model")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());

    let idempotency_key = derive_idempotency_key(
        &identity.session_id,
        "agent_end",
        EVENT_TYPE_LLM_TOKENS,
        &usage,
    );

    let event = UsageEvent {
        idempotency_key,
        event_type: EVENT_TYPE_LLM_TOKENS.to_string(),
        // RPC `AgentEnd` carries no provider; Pria backfills from session start.
        provider: None,
        model,
        occurred_at: chrono::Utc::now().to_rfc3339(),
        usage,
        metadata: serde_json::json!({ "rpc_event": "agent_end" }),
    };

    Some(UsagePayload {
        account_id: identity.account_id.clone(),
        instance_id: identity.instance_id.clone(),
        user_id: identity.user_id.clone(),
        vm_id: identity.vm_id.clone(),
        replica_id: identity.replica_id.clone(),
        session_id: identity.session_id.clone(),
        ephemeral_task_id: identity.ephemeral_task_id.clone(),
        source: SOURCE_RPC_AGENT_END.to_string(),
        events: vec![event],
    })
}

/// Stream a launched `synaps rpc` child's stdout, metering every billable
/// `agent_end` usage frame into Pria's signed usage callback (spec §5.5; the
/// HS-U6 RPC-boundary fallback that ships before the `on_usage` plugin). The
/// task runs until stdout closes (process exit). Non-usage / unparseable frames
/// are ignored. The guest agent owns trusted attribution: SynapsCLI core only
/// emits raw token counts, and [`tag_agent_end_usage`] stamps the
/// account/vm/user/session identity the core cannot know.
pub async fn relay_agent_end_usage<R: tokio::io::AsyncRead + Unpin + Send>(
    stdout: R,
    identity: UsageIdentity,
    pria: std::sync::Arc<dyn crate::pria_client::PriaCallbackClient>,
    ready_tx: Option<tokio::sync::oneshot::Sender<RpcReadyReceipt>>,
) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut ready_tx = ready_tx;
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                // Readiness is a guest-owned process handshake, not an eventual
                // Pria callback. The first valid RPC `ready` lets `/sessions/start`
                // return a truthful receipt for EVERY preset/plugin set.
                if let Some(tx) = ready_tx.take() {
                    if val.get("type").and_then(Value::as_str) == Some("ready") {
                        let model = val
                            .get("model")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let protocol_version = val
                            .get("protocol_version")
                            .and_then(Value::as_u64)
                            .unwrap_or(0) as u32;
                        if !model.is_empty() && protocol_version > 0 {
                            let _ = tx.send(RpcReadyReceipt {
                                model,
                                protocol_version,
                            });
                        } else {
                            // Sender is consumed deliberately: malformed ready is
                            // not readiness and startup will fail closed on timeout.
                            tracing::warn!(session_id = %identity.session_id, "malformed synaps ready frame");
                        }
                    } else {
                        // Synaps contract says ready is first. Do not accept a
                        // later arbitrary frame as proof the process is promptable.
                        tracing::warn!(session_id = %identity.session_id, event_type = ?val.get("type"), "expected synaps ready as first RPC frame");
                    }
                }
                // Seam #3: forward every reply frame to Pria so the user-facing
                // SSE chat stream can surface it. Best-effort — never blocks the
                // usage metering below.
                if let Err(e) = pria.session_output(&identity.session_id, &val).await {
                    tracing::debug!(error = %e, "session_output forward failed");
                }
                if let Some(payload) = tag_agent_end_usage(&val, &identity) {
                    if let Err(e) = pria.usage(&payload).await {
                        tracing::warn!(
                            error = %e,
                            session_id = %identity.session_id,
                            "usage relay forward to Pria failed"
                        );
                    } else {
                        tracing::info!(
                            session_id = %identity.session_id,
                            "metered agent_end usage to Pria ledger"
                        );
                    }
                }
            }
            Ok(None) => break, // EOF: synaps process exited
            Err(e) => {
                tracing::warn!(error = %e, "usage relay stdout read failed");
                break;
            }
        }
    }
}

// ── AC-B2.2 in-VM `on_usage` plugin signing proxy ────────────────────────────

/// Re-tag an in-VM plugin's spec §6.2 usage envelope with **trusted** identity
/// and prepare it for the signed forward to `/internal/agentic-vm/usage`.
///
/// This is the AC-B2.2 primary path: the Pria session-context plugin fires on
/// SynapsCLI's `on_usage` hook (protocol v2), builds the §6.2 envelope, and
/// POSTs it to the guest agent's local usage proxy (the plugin holds no Pria
/// HMAC key). The guest agent owns signing + attribution:
///
///   * Identity (account/instance/user/vm/replica) comes from `identity`, which
///     the proxy resolves from its session table + config — the plugin may NAME
///     a `session_id` but may NOT spoof account/instance/user.
///   * The plugin-derived `idempotency_key`, `type`, `provider`, `model`,
///     `occurred_at`, `usage`, and `metadata` are preserved verbatim so the
///     ledger key the plugin computed is authoritative for this path.
///   * The `source` is forced to `synaps-hook-on-usage` (distinct from the RPC
///     fallback's `synaps-rpc-agent-end`), keeping both paths auditable.
///   * Empty turns (no positive token count on any event) are dropped, and any
///     event carrying a `credits`/`credit_cost` field is rejected (raw-only,
///     spec §5.5) by returning `None`.
///
/// Returns `None` when the envelope has no billable events — the proxy then
/// replies success without forwarding (nothing to bill).
pub fn tag_plugin_usage(envelope: &Value, identity: &UsageIdentity) -> Option<UsagePayload> {
    let raw_events = envelope.get("events")?.as_array()?;
    let mut events: Vec<UsageEvent> = Vec::with_capacity(raw_events.len());

    for raw in raw_events {
        // Raw-only invariant (spec §5.5): never accept credits from the plugin.
        if raw.get("credits").is_some() || raw.get("credit_cost").is_some() {
            return None;
        }
        // Deserialize into the canonical UsageEvent; skip malformed entries.
        let mut ev: UsageEvent = match serde_json::from_value(raw.clone()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        // Re-normalise the token counts so the forwarded `usage` matches the
        // canonical shape Pria expects (and the usage_hash basis).
        ev.usage = normalise_usage(&ev.usage);

        // Drop genuinely empty turns — nothing to bill.
        let any_tokens = [
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        ]
        .iter()
        .any(|k| ev.usage.get(*k).and_then(|v| v.as_u64()).unwrap_or(0) > 0);
        if !any_tokens {
            continue;
        }
        events.push(ev);
    }

    if events.is_empty() {
        return None;
    }

    Some(UsagePayload {
        account_id: identity.account_id.clone(),
        instance_id: identity.instance_id.clone(),
        user_id: identity.user_id.clone(),
        vm_id: identity.vm_id.clone(),
        replica_id: identity.replica_id.clone(),
        session_id: identity.session_id.clone(),
        ephemeral_task_id: identity.ephemeral_task_id.clone(),
        // Force the canonical plugin source regardless of what the plugin sent.
        source: SOURCE_ON_USAGE.to_string(),
        events,
    })
}

// ── real Linux launcher ──────────────────────────────────────────────────────

/// Spawns the real `synaps` binary, dropped to the target uid/gid.
pub struct ProcessLauncher;

impl ProcessLauncher {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ProcessLauncher {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl SynapsLauncher for ProcessLauncher {
    async fn launch(
        &self,
        spec: &LaunchSpec,
    ) -> Result<std::sync::Arc<dyn SessionProcess>, LaunchError> {
        if spec.uid == 0 || spec.gid == 0 {
            return Err(LaunchError(
                "refusing to launch synaps as root (uid/gid 0)".to_string(),
            ));
        }
        real::spawn(spec)
    }
}

#[cfg(unix)]
mod real {
    use super::*;
    use std::process::Stdio;
    use std::sync::Mutex as StdMutex;
    use tokio::process::{Child, Command};
    use tokio::sync::Mutex as AsyncMutex;

    pub struct ChildProcess {
        pid: u32,
        /// Stdin handle for message writes. Separate from `child_wait` so
        /// `send()` can run concurrently with the background wait task.
        stdin: AsyncMutex<Option<tokio::process::ChildStdin>>,
        /// Child process handle held ONLY by the background wait task. Once the
        /// task acquires this, it calls `wait()` — no other method touches it.
        child_wait: AsyncMutex<Child>,
        status: StdMutex<SessionStatus>,
        stdout: StdMutex<Option<tokio::process::ChildStdout>>,
        /// watch(false → true) fired when the OS process exits. Allows
        /// wait_for_exit() to subscribe without holding any lock.
        exit_rx: tokio::sync::watch::Receiver<bool>,
        exit_tx: StdMutex<Option<tokio::sync::watch::Sender<bool>>>,
    }

    pub fn spawn(spec: &LaunchSpec) -> Result<std::sync::Arc<dyn SessionProcess>, LaunchError> {
        let mut cmd = Command::new(&spec.binary);
        cmd.args(&spec.args)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Manual, ordered privilege drop via `pre_exec` (initgroups-style).
        // We deliberately do NOT use tokio's `.uid()/.gid()` (nor std's unstable
        // `.groups()`): the drop MUST be setgroups → setgid → setuid, all while
        // still privileged. Setting the supplementary group list to EXACTLY the
        // user's groups both (a) grants the user's `inst_<id>` instance groups
        // (per-instance tenant isolation) and (b) DROPS root's supplementary
        // groups the agent would otherwise leak into the session (spec §16.3).
        // `ProcessLauncher::launch` already refused uid/gid 0 before this point.
        {
            use std::os::unix::process::CommandExt as StdCommandExt;
            let uid = spec.uid as libc::uid_t;
            let gid = spec.gid as libc::gid_t;
            let groups: Vec<libc::gid_t> = spec.groups.iter().map(|g| *g as libc::gid_t).collect();
            // SAFETY: pre_exec runs in the forked child before exec. We only call
            // async-signal-safe syscalls (setgroups/setgid/setuid) over an owned,
            // pre-allocated gid slice — no allocation, no locks.
            unsafe {
                cmd.as_std_mut().pre_exec(move || {
                    if !groups.is_empty()
                        && libc::setgroups(groups.len() as _, groups.as_ptr()) != 0
                    {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::setgid(gid) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::setuid(uid) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        // Forward the minimal safe env + the (best-effort) session-context env.
        for var in ["PATH", "LANG", "TERM"] {
            if let Ok(v) = std::env::var(var) {
                cmd.env(var, v);
            }
        }
        cmd.env("SYNAPS_SESSION_CONTEXT", &spec.context_path);
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }
        cmd.kill_on_drop(true);

        let child = cmd
            .spawn()
            .map_err(|e| LaunchError(format!("failed to spawn synaps: {e}")))?;
        let pid = child.id().unwrap_or(0);
        let mut child = child;
        // Take stdout + stdin up-front; child_wait holds the Child solely for
        // the background OS-wait task. Separating stdin lets send() run
        // concurrently with wait() — no lock contention.
        let stdout = child.stdout.take();
        let stdin = child.stdin.take();
        // watch channel: false = running, true = exited.
        let (exit_tx, exit_rx) = tokio::sync::watch::channel(false);
        let proc = std::sync::Arc::new(ChildProcess {
            pid,
            stdin: AsyncMutex::new(stdin),
            child_wait: AsyncMutex::new(child),
            status: StdMutex::new(SessionStatus::Running),
            stdout: StdMutex::new(stdout),
            exit_rx,
            exit_tx: StdMutex::new(Some(exit_tx)),
        });
        // Background OS-wait task: acquires the child lock and calls wait().
        // cancel()/close() now use libc::kill() directly (no lock needed), so
        // SIGKILL is sent immediately; the SIGKILL wakes up this wait() quickly.
        // No deadlock: cancel/close never contend for the child lock.
        {
            let proc_ref = proc.clone();
            tokio::spawn(async move {
                // child_wait is held only here — no contention with send/cancel/close.
                let _ = proc_ref.child_wait.lock().await.wait().await;
                // Fire the exit watch so any outstanding wait_for_exit() returns.
                if let Some(tx) = proc_ref.exit_tx.lock().unwrap().take() {
                    let _ = tx.send(true);
                }
            });
        }
        Ok(proc)
    }

    #[async_trait]
    impl SessionProcess for ChildProcess {
        fn pid(&self) -> u32 {
            self.pid
        }

        fn take_stdout(&self) -> Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>> {
            self.stdout
                .lock()
                .unwrap()
                .take()
                .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Send + Unpin>)
        }

        async fn send(&self, message: &str) -> Result<(), LaunchError> {
            use tokio::io::AsyncWriteExt;
            // Lock stdin only — no child_wait lock needed, so send() runs
            // concurrently with the background wait task.
            let mut guard = self.stdin.lock().await;
            if let Some(stdin) = guard.as_mut() {
                stdin
                    .write_all(format!("{message}\n").as_bytes())
                    .await
                    .map_err(|e| LaunchError(format!("stdin write failed: {e}")))?;
                Ok(())
            } else {
                Err(LaunchError("session stdin is not available".into()))
            }
        }

        async fn cancel(&self) -> Result<(), LaunchError> {
            // Send SIGKILL directly via pid — no child-mutex needed, so this
            // never blocks even while the background wait task holds the lock.
            // SAFETY: kill(2) is always safe; ESRCH means already dead — ok.
            unsafe {
                libc::kill(self.pid as libc::pid_t, libc::SIGKILL);
            }
            *self.status.lock().unwrap() = SessionStatus::Cancelled;
            Ok(())
        }

        async fn close(&self, grace_ms: u64) -> Result<(), LaunchError> {
            // Graceful shutdown: SIGTERM -> wait up to grace_ms -> SIGKILL if needed.
            // Synaps writes its final agent_end frame on SIGTERM's shutdown path;
            // SIGKILL alone drops that frame and the turn's usage goes unmetered.
            // SAFETY: kill(2) with ESRCH (already dead) is harmless.
            unsafe {
                libc::kill(self.pid as libc::pid_t, libc::SIGTERM);
            }

            let grace = std::time::Duration::from_millis(grace_ms);
            let exited = tokio::time::timeout(grace, self.wait_for_exit())
                .await
                .is_ok();

            if !exited {
                // Grace period expired -- force termination.
                unsafe {
                    libc::kill(self.pid as libc::pid_t, libc::SIGKILL);
                }
            }

            *self.status.lock().unwrap() = SessionStatus::Closed;
            Ok(())
        }

        fn status(&self) -> SessionStatus {
            *self.status.lock().unwrap()
        }

        async fn wait_for_exit(&self) {
            // Clone the receiver and wait for the watch to become true.
            // Already true (child already exited before we were called) -> returns
            // immediately. This does NOT hold the child lock.
            let mut rx = self.exit_rx.clone();
            // wait_for returns immediately if the current value matches.
            let _ = rx.wait_for(|&v| v).await;
        }
    }
}

#[cfg(not(unix))]
mod real {
    use super::*;
    pub fn spawn(_spec: &LaunchSpec) -> Result<std::sync::Arc<dyn SessionProcess>, LaunchError> {
        Err(LaunchError("synaps launch only supported on unix".into()))
    }
}

// ── test fake ────────────────────────────────────────────────────────────────

#[cfg(any(test, feature = "test-fakes"))]
pub use fake::{FakeLauncher, FakeProcess, FakeStdout, READY_FRAME};

#[cfg(any(test, feature = "test-fakes"))]
mod fake {
    use super::*;
    use std::sync::Mutex;

    /// What a [`FakeProcess`] hands to the usage relay.
    #[derive(Clone, Debug)]
    pub enum FakeStdout {
        /// Emit exactly these bytes, then EOF. `Script(String::new())` is a
        /// child that closed stdout without ever speaking.
        Script(String),
        /// Hold stdout open and emit nothing, forever.
        Silent,
    }

    /// The canonical first frame a healthy `synaps rpc` emits. Fakes default to
    /// this so existing tests exercise the happy path unchanged.
    pub const READY_FRAME: &str =
        r#"{"type":"ready","model":"claude-sonnet-4-6","protocol_version":1}"#;

    /// Records launches and returns a controllable fake process.
    ///
    /// `stdout_script` is the byte stream the produced [`FakeProcess`] hands to
    /// the usage relay. It defaults to a valid ready frame; tests override it to
    /// drive the readiness failure paths (malformed frame, wrong first frame,
    /// EOF before ready, or silence until timeout).
    pub struct FakeLauncher {
        pub launches: Mutex<Vec<LaunchSpec>>,
        pub fail: Mutex<bool>,
        pub next_pid: Mutex<u32>,
        pub stdout_script: Mutex<Option<FakeStdout>>,
    }

    impl Default for FakeLauncher {
        fn default() -> Self {
            Self {
                launches: Mutex::new(Vec::new()),
                fail: Mutex::new(false),
                next_pid: Mutex::new(0),
                stdout_script: Mutex::new(Some(FakeStdout::Script(format!("{READY_FRAME}\n")))),
            }
        }
    }

    impl FakeLauncher {
        pub fn failing() -> Self {
            Self {
                fail: Mutex::new(true),
                ..Default::default()
            }
        }

        /// Emit exactly these bytes on the launched child's stdout, then EOF.
        pub fn with_stdout(script: impl Into<String>) -> Self {
            Self {
                stdout_script: Mutex::new(Some(FakeStdout::Script(script.into()))),
                ..Default::default()
            }
        }

        /// A child that holds stdout open and never speaks — drives the
        /// readiness TIMEOUT path (distinct from exiting, and from having no
        /// stdout at all).
        pub fn silent() -> Self {
            Self {
                stdout_script: Mutex::new(Some(FakeStdout::Silent)),
                ..Default::default()
            }
        }

        /// A child with no stdout channel whatsoever — drives the
        /// "cannot verify readiness" guard.
        pub fn no_stdout() -> Self {
            Self {
                stdout_script: Mutex::new(None),
                ..Default::default()
            }
        }
    }

    #[async_trait]
    impl SynapsLauncher for FakeLauncher {
        async fn launch(
            &self,
            spec: &LaunchSpec,
        ) -> Result<std::sync::Arc<dyn SessionProcess>, LaunchError> {
            if spec.uid == 0 {
                return Err(LaunchError("refusing root launch".into()));
            }
            if *self.fail.lock().unwrap() {
                return Err(LaunchError("synthetic launch failure".into()));
            }
            self.launches.lock().unwrap().push(spec.clone());
            let script = self.stdout_script.lock().unwrap().clone();
            let mut pid = self.next_pid.lock().unwrap();
            *pid = if *pid == 0 { 12345 } else { *pid + 1 };
            Ok(std::sync::Arc::new(FakeProcess::with_stdout(*pid, script)))
        }
    }

    pub struct FakeProcess {
        pid: u32,
        pub sent: Mutex<Vec<String>>,
        status: Mutex<SessionStatus>,
        /// Exit signal. A `watch` (not a oneshot) so `wait_for_exit()` is
        /// IDEMPOTENT, exactly like `real::ChildProcess`. With a oneshot the
        /// receiver was consumed by the first caller and every later caller
        /// returned instantly — so the start handler's smoke-check would take
        /// it and the zombie reaper would then conclude a live child had died
        /// and evict the session (close/send later 404'd on a running process).
        exit_tx: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
        exit_rx: tokio::sync::watch::Receiver<bool>,
        /// What the relay will read from this child.
        stdout: Mutex<Option<FakeStdout>>,
    }

    impl FakeProcess {
        pub fn new(pid: u32) -> Self {
            Self::with_stdout(pid, Some(FakeStdout::Script(format!("{READY_FRAME}\n"))))
        }

        pub fn with_stdout(pid: u32, stdout: Option<FakeStdout>) -> Self {
            let (tx, rx) = tokio::sync::watch::channel(false);
            Self {
                pid,
                sent: Mutex::new(Vec::new()),
                status: Mutex::new(SessionStatus::Running),
                exit_tx: Mutex::new(Some(tx)),
                exit_rx: rx,
                stdout: Mutex::new(stdout),
            }
        }

        /// Fire the exit signal (simulates child process death).
        pub fn trigger_exit(&self) {
            if let Some(tx) = self.exit_tx.lock().unwrap().take() {
                let _ = tx.send(true);
            }
        }
    }

    #[async_trait]
    impl SessionProcess for FakeProcess {
        fn pid(&self) -> u32 {
            self.pid
        }

        fn take_stdout(&self) -> Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>> {
            match self.stdout.lock().unwrap().take()? {
                // Frames, then EOF — the normal shape.
                FakeStdout::Script(text) => Some(Box::new(std::io::Cursor::new(text.into_bytes()))),
                // Alive but saying nothing. A cursor would hit EOF immediately
                // and look like a dead child; a duplex whose writer is held
                // open pends forever, which is what a silent process does.
                FakeStdout::Silent => {
                    let (reader, writer) = tokio::io::duplex(64);
                    std::mem::forget(writer);
                    Some(Box::new(reader))
                }
            }
        }

        async fn send(&self, message: &str) -> Result<(), LaunchError> {
            self.sent.lock().unwrap().push(message.to_string());
            Ok(())
        }
        async fn cancel(&self) -> Result<(), LaunchError> {
            *self.status.lock().unwrap() = SessionStatus::Cancelled;
            Ok(())
        }
        async fn close(&self, grace_ms: u64) -> Result<(), LaunchError> {
            // Mirror real::ChildProcess: wait up to grace_ms for exit, then force.
            let grace = std::time::Duration::from_millis(grace_ms);
            let _ = tokio::time::timeout(grace, self.wait_for_exit()).await;
            *self.status.lock().unwrap() = SessionStatus::Closed;
            Ok(())
        }
        fn status(&self) -> SessionStatus {
            *self.status.lock().unwrap()
        }

        async fn wait_for_exit(&self) {
            // Idempotent: every caller gets its own clone of the watch and
            // waits for the same edge. Mirrors real::ChildProcess.
            let mut rx = self.exit_rx.clone();
            let _ = rx.wait_for(|&exited| exited).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tag_rpc_event_injects_session_identity() {
        let raw = json!({"type": "synaps.output.delta", "payload": {"text": "hi"}});
        let tagged = tag_rpc_event(&raw, "acct_1", "inst_2", "user_3", "sess_4");
        assert_eq!(tagged.event_type, "synaps.output.delta");
        assert_eq!(tagged.session_id, "sess_4");
        assert_eq!(tagged.account_id, "acct_1");
        assert!(tagged.event_id.starts_with("evt_"));
    }

    fn identity() -> UsageIdentity {
        UsageIdentity {
            account_id: "acct_1".into(),
            instance_id: "inst_2".into(),
            user_id: "user_3".into(),
            vm_id: "vm_4".into(),
            replica_id: "r0".into(),
            session_id: "sess_5".into(),
            ephemeral_task_id: None,
        }
    }

    #[tokio::test]
    async fn relay_meters_agent_end_frames_from_real_stdout() {
        use crate::pria_client::fake::FakePriaClient;
        use std::process::Stdio;
        use std::sync::Arc;
        // A real child whose stdout emits noise, one billable agent_end frame,
        // and a non-usage frame. The relay must meter exactly the billable one.
        let agent_end = r#"{"type":"agent_end","usage":{"input_tokens":10,"output_tokens":5,"model":"gpt-5.5-codex"}}"#;
        let script = format!(
            "echo 'not json'; echo '{}'; echo '{{\"type\":\"synaps.output.delta\"}}'",
            agent_end
        );
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn test child");
        let stdout = child.stdout.take().expect("child stdout");
        let pria = Arc::new(FakePriaClient::default());
        relay_agent_end_usage(stdout, identity(), pria.clone(), None).await;
        let usages = pria.usages.lock().unwrap();
        assert_eq!(usages.len(), 1, "exactly one billable agent_end metered");
        assert_eq!(usages[0].session_id, "sess_5");
        assert_eq!(usages[0].account_id, "acct_1");
        assert_eq!(usages[0].source, SOURCE_RPC_AGENT_END);
    }

    #[tokio::test]
    async fn relay_drops_empty_turn_and_exits_on_eof() {
        use crate::pria_client::fake::FakePriaClient;
        use std::process::Stdio;
        use std::sync::Arc;
        // A zero-token agent_end must NOT be billed (spec §5.5 empty-turn drop),
        // and the relay must return cleanly when stdout closes.
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(r#"echo '{"type":"agent_end","usage":{"input_tokens":0,"output_tokens":0}}'"#)
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn test child");
        let stdout = child.stdout.take().expect("child stdout");
        let pria = Arc::new(FakePriaClient::default());
        relay_agent_end_usage(stdout, identity(), pria.clone(), None).await;
        assert!(
            pria.usages.lock().unwrap().is_empty(),
            "empty turn not billed"
        );
    }

    #[test]
    fn tag_agent_end_usage_builds_raw_only_payload() {
        let raw = json!({
            "type": "agent_end",
            "usage": {
                "input_tokens": 1234, "output_tokens": 567,
                "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 200,
                "cache_creation_5m": 200, "cache_creation_1h": 0,
                "model": "claude-sonnet-4-test"
            }
        });
        let payload = tag_agent_end_usage(&raw, &identity()).expect("must meter agent_end");
        assert_eq!(payload.source, "synaps-rpc-agent-end");
        assert_eq!(payload.account_id, "acct_1");
        assert_eq!(payload.session_id, "sess_5");
        assert_eq!(payload.events.len(), 1);
        let ev = &payload.events[0];
        assert_eq!(ev.event_type, "llm.tokens");
        assert_eq!(ev.model.as_deref(), Some("claude-sonnet-4-test"));
        assert!(ev.provider.is_none());
        assert!(ev
            .idempotency_key
            .starts_with("synaps:sess_5:agent_end:llm.tokens:"));
        assert_eq!(ev.usage["input_tokens"], 1234);
        // Raw-only: the serialised event must not carry credits.
        let v = serde_json::to_value(ev).unwrap();
        assert!(v.get("credits").is_none());
    }

    #[test]
    fn tag_agent_end_usage_ignores_non_agent_end() {
        let raw = json!({"type": "synaps.output.delta", "payload": {}});
        assert!(tag_agent_end_usage(&raw, &identity()).is_none());
    }

    #[test]
    fn tag_agent_end_usage_drops_empty_turn() {
        let raw = json!({
            "type": "agent_end",
            "usage": { "input_tokens": 0, "output_tokens": 0,
                       "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 }
        });
        assert!(tag_agent_end_usage(&raw, &identity()).is_none());
    }

    #[test]
    fn tag_agent_end_usage_model_null_when_absent() {
        let raw = json!({"type": "agent_end", "usage": { "input_tokens": 5 }});
        let payload = tag_agent_end_usage(&raw, &identity()).unwrap();
        assert!(payload.events[0].model.is_none());
    }

    // ── AC-B2.2 tag_plugin_usage ─────────────────────────────────────────────

    fn plugin_envelope() -> Value {
        // A spec §6.2 envelope as the in-VM plugin builds it. Note the plugin
        // claims an account_id we must IGNORE in favour of the trusted identity.
        json!({
            "account_id": "acct_SPOOFED",
            "instance_id": "inst_SPOOFED",
            "user_id": "user_SPOOFED",
            "session_id": "sess_5",
            "source": "synaps-hook-on-usage",
            "events": [{
                "idempotency_key": "synaps:sess_5:msg_123:llm.tokens:deadbeefdeadbeef",
                "type": "llm.tokens",
                "provider": "anthropic",
                "model": "claude-sonnet-4-test",
                "occurred_at": "2026-06-14T00:00:00Z",
                "usage": {
                    "input_tokens": 1234, "output_tokens": 567,
                    "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 200,
                    "cache_creation_5m": 200, "cache_creation_1h": 0
                },
                "metadata": { "message_id": "msg_123", "turn_id": "turn_abc" }
            }]
        })
    }

    #[test]
    fn tag_plugin_usage_restamps_trusted_identity_and_preserves_key() {
        let payload = tag_plugin_usage(&plugin_envelope(), &identity()).expect("billable");
        // Trusted identity wins over the plugin-claimed (spoofed) tags.
        assert_eq!(payload.account_id, "acct_1");
        assert_eq!(payload.instance_id, "inst_2");
        assert_eq!(payload.user_id, "user_3");
        assert_eq!(payload.vm_id, "vm_4");
        assert_eq!(payload.replica_id, "r0");
        // Canonical plugin source, distinct from the RPC fallback.
        assert_eq!(payload.source, "synaps-hook-on-usage");
        assert_eq!(payload.events.len(), 1);
        let ev = &payload.events[0];
        // Plugin-derived idempotency key + provider/model preserved verbatim.
        assert_eq!(
            ev.idempotency_key,
            "synaps:sess_5:msg_123:llm.tokens:deadbeefdeadbeef"
        );
        assert_eq!(ev.provider.as_deref(), Some("anthropic"));
        assert_eq!(ev.model.as_deref(), Some("claude-sonnet-4-test"));
        assert_eq!(ev.usage["input_tokens"], 1234);
        // Raw-only: no credits anywhere in the forwarded payload.
        let v = serde_json::to_value(&payload).unwrap();
        assert!(v.to_string().find("credits").is_none());
    }

    #[test]
    fn tag_plugin_usage_rejects_credits_field() {
        let mut env = plugin_envelope();
        env["events"][0]["credits"] = json!(0.0184);
        // Raw-only invariant (spec §5.5): the whole batch is rejected.
        assert!(tag_plugin_usage(&env, &identity()).is_none());
    }

    #[test]
    fn tag_plugin_usage_drops_empty_turns() {
        let env = json!({
            "session_id": "sess_5",
            "events": [{
                "idempotency_key": "k", "type": "llm.tokens",
                "occurred_at": "2026-06-14T00:00:00Z",
                "usage": { "input_tokens": 0, "output_tokens": 0 },
                "metadata": {}
            }]
        });
        assert!(tag_plugin_usage(&env, &identity()).is_none());
    }

    #[test]
    fn tag_plugin_usage_none_without_events() {
        assert!(tag_plugin_usage(&json!({"session_id": "s"}), &identity()).is_none());
    }

    #[test]
    fn tag_plugin_usage_normalises_usage_shape() {
        // Plugin sends only input_tokens; the proxy fills the canonical fields so
        // the forwarded usage matches the usage_hash basis Pria expects.
        let env = json!({
            "session_id": "sess_5",
            "events": [{
                "idempotency_key": "k", "type": "llm.tokens",
                "occurred_at": "2026-06-14T00:00:00Z",
                "usage": { "input_tokens": 7 }, "metadata": {}
            }]
        });
        let payload = tag_plugin_usage(&env, &identity()).unwrap();
        let u = &payload.events[0].usage;
        assert_eq!(u["input_tokens"], 7);
        assert_eq!(u["output_tokens"], 0);
        assert_eq!(u["cache_read_input_tokens"], 0);
        assert!(u["cache_creation_5m"].is_null());
    }

    #[tokio::test]
    async fn fake_launcher_refuses_root() {
        let l = FakeLauncher::default();
        let spec = LaunchSpec {
            binary: "/bin/true".into(),
            args: vec![],
            uid: 0,
            gid: 0,
            groups: vec![],
            cwd: None,
            env: HashMap::new(),
            context_path: "/tmp/ctx.json".into(),
            session_id: "s".into(),
        };
        assert!(l.launch(&spec).await.is_err());
    }

    #[tokio::test]
    async fn close_respects_grace_when_child_exits_early() {
        // FakeProcess exits at ~50ms; close(500) should complete around 50ms
        // without hitting the SIGKILL fallback path.
        let proc = std::sync::Arc::new(FakeProcess::new(99));
        let proc_clone = proc.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            proc_clone.trigger_exit();
        });
        let start = std::time::Instant::now();
        proc.close(500).await.unwrap();
        let elapsed = start.elapsed();
        assert_eq!(proc.status(), SessionStatus::Closed);
        // Should return well before the 500ms grace window expires.
        assert!(
            elapsed < std::time::Duration::from_millis(400),
            "close took too long: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn close_falls_back_to_sigkill_after_grace() {
        // FakeProcess never exits; close(50) must return after ~50ms (grace
        // period exhausted) with status Closed.
        let proc = FakeProcess::new(100);
        let start = std::time::Instant::now();
        proc.close(50).await.unwrap();
        let elapsed = start.elapsed();
        assert_eq!(proc.status(), SessionStatus::Closed);
        // Must have waited at least the grace period before returning.
        assert!(
            elapsed >= std::time::Duration::from_millis(45),
            "close returned too early: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn close_zero_grace_does_not_wait() {
        // close(0) must return almost immediately regardless of exit state.
        let proc = FakeProcess::new(101);
        let start = std::time::Instant::now();
        proc.close(0).await.unwrap();
        let elapsed = start.elapsed();
        assert_eq!(proc.status(), SessionStatus::Closed);
        assert!(
            elapsed < std::time::Duration::from_millis(100),
            "close(0) was too slow: {elapsed:?}"
        );
    }
}
