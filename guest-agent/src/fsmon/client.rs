//! fsmon control client (spec §6.6/§6.7). Peer of the fsmon control socket.
//!
//! HS-5 (CONFIRMED): fsmon is a sibling daemon, not a Synaps-managed sidecar
//! (`sidecar/spawn.rs` is a plugin-arg RPC, not a daemon supervisor). The guest
//! agent talks to it over a local UDS with newline-delimited JSON.

use async_trait::async_trait;

use super::types::{ControlRequest, ControlResponse, PolicyDoc};

/// fsmon control error.
#[derive(Debug)]
pub enum FsmonError {
    Unavailable(String),
    Protocol(String),
    Rejected(String),
}

impl std::fmt::Display for FsmonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FsmonError::Unavailable(e) => write!(f, "fsmon unavailable: {e}"),
            FsmonError::Protocol(e) => write!(f, "fsmon protocol error: {e}"),
            FsmonError::Rejected(e) => write!(f, "fsmon rejected request: {e}"),
        }
    }
}

impl std::error::Error for FsmonError {}

/// Outcome of a successful control round-trip.
#[derive(Debug, Clone, Default)]
pub struct FsmonStats {
    pub cache_len: Option<usize>,
    pub principals: Option<usize>,
    pub degraded: Option<bool>,
}

/// The fsmon control surface (abstracted so handler tests inject a fake).
#[async_trait]
pub trait FsmonControl: Send + Sync {
    async fn apply_policy(&self, doc: &PolicyDoc) -> Result<FsmonStats, FsmonError>;
    async fn ping(&self) -> Result<(), FsmonError>;
    async fn stats(&self) -> Result<FsmonStats, FsmonError>;
    /// Ensure the fsmon daemon is running and its control socket is reachable.
    ///
    /// fsmon is NOT started at boot — marking the whole `/` mount with
    /// `FAN_OPEN_PERM` before userspace is ready deadlocks the guest. Instead it
    /// is activated on demand the first time a policy is applied (post-boot the
    /// monitor runs without deadlocking). Default: assume externally managed.
    async fn ensure_running(&self) -> Result<(), FsmonError> {
        Ok(())
    }

    /// Stop a daemon we previously activated on demand (belt-and-suspenders for
    /// ephemeral task VMs / post-verification teardown).
    ///
    /// Long-lived `FAN_OPEN_PERM` marks hold one event fd per in-flight open;
    /// narrowing the mark to the account EFS mount keeps the rate bounded, but a
    /// task VM that only needs a one-shot policy check should release the monitor
    /// entirely once verification is done. Default: no-op (externally managed).
    async fn ensure_stopped(&self) -> Result<(), FsmonError> {
        Ok(())
    }
}

/// UDS-backed control client.
pub struct UdsFsmonControl {
    socket_path: std::path::PathBuf,
    /// Path to the `synaps_fsmon` binary for on-demand activation.
    daemon_bin: std::path::PathBuf,
    /// Optional audit-forward socket the daemon connects back to.
    forward_socket: Option<std::path::PathBuf>,
    /// The fanotify mount to mark. Narrowing this from the whole `/` to the
    /// account EFS mount (`/efs/accounts/<id>`) is the structural fix for
    /// fd-exhaustion: only opens on the account data subtree generate a
    /// synchronous `FAN_OPEN_PERM` round-trip, so a busy root filesystem (sshd,
    /// `/usr`, `/lib`) never floods the single-threaded permission loop. It is
    /// also a complete envelope — every path that needs write-containment
    /// (immutable prefixes, instance workspaces, session dirs) is EFS-rooted, so
    /// it lives under this one mount. Per-user homes hold only ephemeral runtime
    /// config and are isolated by Unix DAC, not this mark.
    mount_path: std::path::PathBuf,
    /// PID of a daemon we spawned on demand, so `ensure_stopped` can release it.
    daemon_pid: std::sync::Mutex<Option<u32>>,
}

impl UdsFsmonControl {
    pub fn new(socket_path: impl Into<std::path::PathBuf>) -> Self {
        Self {
            socket_path: socket_path.into(),
            daemon_bin: std::path::PathBuf::from("/usr/local/sbin/synaps_fsmon"),
            forward_socket: None,
            mount_path: std::path::PathBuf::from("/"),
            daemon_pid: std::sync::Mutex::new(None),
        }
    }

    /// Configure the on-demand daemon binary + forward socket (production wiring).
    pub fn with_daemon(
        mut self,
        daemon_bin: impl Into<std::path::PathBuf>,
        forward_socket: Option<std::path::PathBuf>,
    ) -> Self {
        self.daemon_bin = daemon_bin.into();
        self.forward_socket = forward_socket;
        self
    }

    /// Set the fanotify mount to mark (production: the account EFS mount, e.g.
    /// `config.paths.efs_root`). Defaults to `/` for safety/back-compat.
    pub fn with_mount(mut self, mount_path: impl Into<std::path::PathBuf>) -> Self {
        self.mount_path = mount_path.into();
        self
    }

    async fn round_trip(&self, req: &ControlRequest) -> Result<FsmonStats, FsmonError> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixStream;

        let stream = UnixStream::connect(&self.socket_path)
            .await
            .map_err(|e| FsmonError::Unavailable(e.to_string()))?;
        let (read_half, mut write_half) = stream.into_split();
        let line = serde_json::to_string(req).map_err(|e| FsmonError::Protocol(e.to_string()))?;
        write_half
            .write_all(format!("{line}\n").as_bytes())
            .await
            .map_err(|e| FsmonError::Unavailable(e.to_string()))?;
        write_half
            .flush()
            .await
            .map_err(|e| FsmonError::Unavailable(e.to_string()))?;

        let mut reader = BufReader::new(read_half);
        let mut resp_line = String::new();
        reader
            .read_line(&mut resp_line)
            .await
            .map_err(|e| FsmonError::Protocol(e.to_string()))?;
        let resp: ControlResponse = serde_json::from_str(resp_line.trim())
            .map_err(|e| FsmonError::Protocol(e.to_string()))?;
        match resp {
            ControlResponse::Ok {
                cache_len,
                principals,
                degraded,
            } => Ok(FsmonStats {
                cache_len,
                principals,
                degraded,
            }),
            ControlResponse::Error { message } => Err(FsmonError::Rejected(message)),
        }
    }
}

#[async_trait]
impl FsmonControl for UdsFsmonControl {
    async fn apply_policy(&self, doc: &PolicyDoc) -> Result<FsmonStats, FsmonError> {
        self.round_trip(&ControlRequest::PolicyApply {
            policy: doc.clone(),
        })
        .await
    }

    async fn ping(&self) -> Result<(), FsmonError> {
        self.round_trip(&ControlRequest::Ping).await.map(|_| ())
    }

    async fn stats(&self) -> Result<FsmonStats, FsmonError> {
        self.round_trip(&ControlRequest::Stats).await
    }

    async fn ensure_running(&self) -> Result<(), FsmonError> {
        // Already up?
        if self.ping().await.is_ok() {
            return Ok(());
        }
        // Spawn the daemon over the configured mount (production: the account EFS
        // mount, not the whole `/`) with a minimal allow-all bootstrap policy (the
        // real policy is hot-pushed via apply_policy right after). Starting
        // post-boot avoids the boot-time fanotify deadlock; the narrow mount keeps
        // the permission-event rate bounded so event fds never exhaust NOFILE.
        let spool = self
            .socket_path
            .parent()
            .map(|p| p.join("fsmon-spool"))
            .unwrap_or_else(|| std::path::PathBuf::from("/run/pria/fsmon-spool"));
        let policy = self
            .socket_path
            .parent()
            .map(|p| p.join("fsmon-bootstrap-policy.json"))
            .unwrap_or_else(|| std::path::PathBuf::from("/run/pria/fsmon-bootstrap-policy.json"));
        // Write a minimal allow-all bootstrap policy so the daemon never denies a
        // boot-critical path before the real policy lands.
        let _ = std::fs::write(
            &policy,
            br#"{"default_decision":"allow","principals":[],"rules":[],"immutable_prefixes":[]}"#,
        );
        let mount = self.mount_path.to_string_lossy().to_string();
        let mut cmd = tokio::process::Command::new(&self.daemon_bin);
        cmd.arg("run")
            .arg("--mount")
            .arg(&mount)
            .arg("--control")
            .arg(&self.socket_path)
            .arg("--spool")
            .arg(&spool)
            .arg("--policy")
            .arg(&policy);
        if let Some(fwd) = &self.forward_socket {
            cmd.arg("--forward").arg(fwd);
        }
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        // Detach: the daemon must outlive this request handler.
        #[cfg(unix)]
        {
            unsafe {
                cmd.pre_exec(|| {
                    // New session so it isn't reaped with the request task.
                    libc::setsid();
                    Ok(())
                });
            }
        }
        let child = cmd
            .spawn()
            .map_err(|e| FsmonError::Unavailable(format!("failed to spawn synaps_fsmon: {e}")))?;
        // Remember the PID so ensure_stopped can release the monitor later.
        if let Some(pid) = child.id() {
            *self.daemon_pid.lock().unwrap() = Some(pid);
        }
        // Wait for the control socket to come up (poll ping up to ~8s).
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if self.ping().await.is_ok() {
                return Ok(());
            }
        }
        Err(FsmonError::Unavailable(
            "synaps_fsmon did not become ready within timeout".into(),
        ))
    }

    async fn ensure_stopped(&self) -> Result<(), FsmonError> {
        // Only stop a daemon WE activated on demand (PID recorded by
        // ensure_running). Externally-managed daemons (systemd) are left alone.
        let pid = self.daemon_pid.lock().unwrap().take();
        let Some(pid) = pid else {
            return Ok(());
        };
        #[cfg(unix)]
        {
            // SAFETY: SIGTERM to a pid we spawned; the daemon installs no signal
            // handler so it terminates, releasing all fanotify event fds + the mark.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
        // Best-effort: clear the control socket so a later ensure_running rebinds.
        let _ = std::fs::remove_file(&self.socket_path);
        Ok(())
    }
}

// ── test fake ────────────────────────────────────────────────────────────────

#[cfg(any(test, feature = "test-fakes"))]
pub use fake::FakeFsmonControl;

#[cfg(any(test, feature = "test-fakes"))]
mod fake {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct FakeFsmonControl {
        pub applied: Mutex<Vec<PolicyDoc>>,
        pub available: Mutex<bool>,
        pub ensure_running_calls: Mutex<usize>,
        pub ensure_stopped_calls: Mutex<usize>,
    }

    impl FakeFsmonControl {
        pub fn healthy() -> Self {
            Self {
                applied: Mutex::new(Vec::new()),
                available: Mutex::new(true),
                ensure_running_calls: Mutex::new(0),
                ensure_stopped_calls: Mutex::new(0),
            }
        }
        pub fn unavailable() -> Self {
            Self {
                applied: Mutex::new(Vec::new()),
                available: Mutex::new(false),
                ensure_running_calls: Mutex::new(0),
                ensure_stopped_calls: Mutex::new(0),
            }
        }
    }

    #[async_trait]
    impl FsmonControl for FakeFsmonControl {
        async fn apply_policy(&self, doc: &PolicyDoc) -> Result<FsmonStats, FsmonError> {
            if !*self.available.lock().unwrap() {
                return Err(FsmonError::Unavailable("socket closed".into()));
            }
            self.applied.lock().unwrap().push(doc.clone());
            Ok(FsmonStats {
                cache_len: Some(0),
                principals: Some(doc.principals.len()),
                degraded: Some(false),
            })
        }
        async fn ping(&self) -> Result<(), FsmonError> {
            if *self.available.lock().unwrap() {
                Ok(())
            } else {
                Err(FsmonError::Unavailable("down".into()))
            }
        }
        async fn stats(&self) -> Result<FsmonStats, FsmonError> {
            if *self.available.lock().unwrap() {
                Ok(FsmonStats::default())
            } else {
                Err(FsmonError::Unavailable("down".into()))
            }
        }
        async fn ensure_running(&self) -> Result<(), FsmonError> {
            *self.ensure_running_calls.lock().unwrap() += 1;
            // Mirror the real daemon: if the (simulated) socket can't come up,
            // activation fails — we do NOT fabricate availability.
            if *self.available.lock().unwrap() {
                Ok(())
            } else {
                Err(FsmonError::Unavailable("daemon did not start".into()))
            }
        }
        async fn ensure_stopped(&self) -> Result<(), FsmonError> {
            *self.ensure_stopped_calls.lock().unwrap() += 1;
            *self.available.lock().unwrap() = false;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_mount_narrows_the_fanotify_mark_target() {
        // Default is the whole `/` (safe fallback); production narrows to the
        // account EFS mount so the permission loop never floods on root-fs opens.
        let default = UdsFsmonControl::new("/run/pria/fsmon.sock");
        assert_eq!(default.mount_path, std::path::PathBuf::from("/"));

        let narrowed = UdsFsmonControl::new("/run/pria/fsmon.sock")
            .with_mount("/efs/accounts/acct_abc123");
        assert_eq!(
            narrowed.mount_path,
            std::path::PathBuf::from("/efs/accounts/acct_abc123")
        );
    }

    #[tokio::test]
    async fn ensure_stopped_is_a_noop_when_nothing_was_activated() {
        // No PID recorded (ensure_running never spawned a daemon) → clean Ok,
        // never signals a stray process.
        let ctl = UdsFsmonControl::new("/run/pria/fsmon-noexist.sock");
        assert!(ctl.daemon_pid.lock().unwrap().is_none());
        ctl.ensure_stopped().await.expect("noop stop");
        assert!(ctl.daemon_pid.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn fake_tracks_start_stop_lifecycle() {
        let f = FakeFsmonControl::healthy();
        f.ensure_running().await.unwrap();
        assert_eq!(*f.ensure_running_calls.lock().unwrap(), 1);
        assert!(f.ping().await.is_ok());
        f.ensure_stopped().await.unwrap();
        assert_eq!(*f.ensure_stopped_calls.lock().unwrap(), 1);
        // After stop the monitor is no longer reachable.
        assert!(f.ping().await.is_err());
    }

    #[tokio::test]
    async fn fake_unavailable_fails_activation_without_fabricating_availability() {
        let f = FakeFsmonControl::unavailable();
        assert!(f.ensure_running().await.is_err());
        assert!(f.ping().await.is_err());
    }
}
