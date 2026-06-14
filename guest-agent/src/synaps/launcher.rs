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

use crate::pria_client::SessionEventPayload;

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
        Ok(std::sync::Arc::new(ChildProcess {
            pid,
            child: AsyncMutex::new(child),
            status: StdMutex::new(SessionStatus::Running),
        }))
    }

    #[async_trait]
    impl SessionProcess for ChildProcess {
        fn pid(&self) -> u32 {
            self.pid
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
