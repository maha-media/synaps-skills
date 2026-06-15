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
    /// Take the child's stdout stream exactly once, for the usage-relay reader
    /// task (spec §5.5 / HS-U6). Returns `None` when unavailable — already taken,
    /// or a non-process backend (fake / non-unix). Default: `None`.
    fn take_stdout(&self) -> Option<tokio::process::ChildStdout> {
        None
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
pub async fn relay_agent_end_usage(
    stdout: tokio::process::ChildStdout,
    identity: UsageIdentity,
    pria: std::sync::Arc<dyn crate::pria_client::PriaCallbackClient>,
) {
    use tokio::io::{AsyncBufReadExt, BufReader};
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
        child: AsyncMutex<Child>,
        status: StdMutex<SessionStatus>,
        stdout: StdMutex<Option<tokio::process::ChildStdout>>,
    }

    pub fn spawn(spec: &LaunchSpec) -> Result<std::sync::Arc<dyn SessionProcess>, LaunchError> {
        let mut cmd = Command::new(&spec.binary);
        cmd.args(&spec.args)
            .uid(spec.uid)
            .gid(spec.gid)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
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
        // Take stdout up-front so the usage-relay reader task can own it; the
        // child stays in the AsyncMutex for stdin writes (send) + lifecycle.
        let stdout = child.stdout.take();
        Ok(std::sync::Arc::new(ChildProcess {
            pid,
            child: AsyncMutex::new(child),
            status: StdMutex::new(SessionStatus::Running),
            stdout: StdMutex::new(stdout),
        }))
    }

    #[async_trait]
    impl SessionProcess for ChildProcess {
        fn pid(&self) -> u32 {
            self.pid
        }

        fn take_stdout(&self) -> Option<tokio::process::ChildStdout> {
            self.stdout.lock().unwrap().take()
        }

        async fn send(&self, message: &str) -> Result<(), LaunchError> {
            use tokio::io::AsyncWriteExt;
            let mut guard = self.child.lock().await;
            if let Some(stdin) = guard.stdin.as_mut() {
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
            let mut guard = self.child.lock().await;
            let _ = guard.start_kill();
            *self.status.lock().unwrap() = SessionStatus::Cancelled;
            Ok(())
        }

        async fn close(&self, _grace_ms: u64) -> Result<(), LaunchError> {
            let mut guard = self.child.lock().await;
            let _ = guard.start_kill();
            *self.status.lock().unwrap() = SessionStatus::Closed;
            Ok(())
        }

        fn status(&self) -> SessionStatus {
            *self.status.lock().unwrap()
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
pub use fake::{FakeLauncher, FakeProcess};

#[cfg(any(test, feature = "test-fakes"))]
mod fake {
    use super::*;
    use std::sync::Mutex;

    /// Records launches and returns a controllable fake process.
    #[derive(Default)]
    pub struct FakeLauncher {
        pub launches: Mutex<Vec<LaunchSpec>>,
        pub fail: Mutex<bool>,
        pub next_pid: Mutex<u32>,
    }

    impl FakeLauncher {
        pub fn failing() -> Self {
            Self {
                fail: Mutex::new(true),
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
            let mut pid = self.next_pid.lock().unwrap();
            *pid = if *pid == 0 { 12345 } else { *pid + 1 };
            Ok(std::sync::Arc::new(FakeProcess::new(*pid)))
        }
    }

    pub struct FakeProcess {
        pid: u32,
        pub sent: Mutex<Vec<String>>,
        status: Mutex<SessionStatus>,
    }

    impl FakeProcess {
        pub fn new(pid: u32) -> Self {
            Self {
                pid,
                sent: Mutex::new(Vec::new()),
                status: Mutex::new(SessionStatus::Running),
            }
        }
    }

    #[async_trait]
    impl SessionProcess for FakeProcess {
        fn pid(&self) -> u32 {
            self.pid
        }
        async fn send(&self, message: &str) -> Result<(), LaunchError> {
            self.sent.lock().unwrap().push(message.to_string());
            Ok(())
        }
        async fn cancel(&self) -> Result<(), LaunchError> {
            *self.status.lock().unwrap() = SessionStatus::Cancelled;
            Ok(())
        }
        async fn close(&self, _grace_ms: u64) -> Result<(), LaunchError> {
            *self.status.lock().unwrap() = SessionStatus::Closed;
            Ok(())
        }
        fn status(&self) -> SessionStatus {
            *self.status.lock().unwrap()
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
        relay_agent_end_usage(stdout, identity(), pria.clone()).await;
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
        relay_agent_end_usage(stdout, identity(), pria.clone()).await;
        assert!(pria.usages.lock().unwrap().is_empty(), "empty turn not billed");
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
            cwd: None,
            env: HashMap::new(),
            context_path: "/tmp/ctx.json".into(),
            session_id: "s".into(),
        };
        assert!(l.launch(&spec).await.is_err());
    }
}
