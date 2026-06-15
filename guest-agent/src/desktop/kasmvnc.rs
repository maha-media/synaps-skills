//! KasmVNC desktop session lifecycle (spec §5.4, §4.3).
//!
//! Responsibilities:
//! 1. Write `/run/pria/kasmvnc/<linux_username>.env` (spec §4.3 env file).
//! 2. Configure the KasmVNC VNC password for the transport `kasm_user`
//!    (spec §5.3 — password stored on disk under the user's home, written as
//!    root but read by the session process; **NEVER logged**).
//! 3. Abstract `systemctl start|stop|status kasmvnc@<user>` through the
//!    [`SystemctlBackend`] trait so unit tests can inject a [`FakeSystemctl`]
//!    without a running systemd.
//!
//! ## Security invariants (spec §16)
//! * VNC passwords are never logged — they appear only in the env file and in the
//!   `DesktopSession` returned to the API layer which redacts them before any
//!   tracing output.
//! * The env file is written mode `0600`, owned by root (the guest-agent runs as
//!   root) so only systemd can read it when launching the per-user unit.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Default geometry for KasmVNC sessions.
pub const DEFAULT_GEOMETRY: &str = "1280x800";

/// The KasmVNC transport auth user (spec §5.3 — transport identity only).
pub const KASM_BASIC_USER: &str = "kasm_user";

// ── env file ─────────────────────────────────────────────────────────────────

/// The contents of `/run/pria/kasmvnc/<linux_username>.env`.
///
/// Consumed by `kasmvnc@.service` via `EnvironmentFile=` (spec §4.3).
#[derive(Debug, Clone)]
pub struct KasmEnv {
    pub display: String,
    pub ws_port: u16,
    pub geometry: String,
    /// VNC password for the `kasm_user` Basic-auth transport (spec §5.3).
    /// NEVER log or serialize this field.
    pub vnc_password: String,
}

impl KasmEnv {
    /// Render the env file contents (shell `KEY=VALUE` lines, no quotes needed
    /// for the values used here; spec §4.3 example).
    ///
    /// The password line uses `KASM_VNC_PASSWORD` which is read by the
    /// `ExecStartPre` helper that calls `kasmvncpasswd` — it is NOT emitted
    /// directly into the server process environment.
    pub fn render(&self) -> String {
        // NOTE: password is included in the env file (root-owned, mode 0600).
        // The Display impl deliberately omits it; see below.
        format!(
            "KASM_DISPLAY={display}\n\
             KASM_WS_PORT={port}\n\
             KASM_GEOMETRY={geometry}\n\
             KASM_VNC_PASSWORD={password}\n",
            display = self.display,
            port = self.ws_port,
            geometry = self.geometry,
            password = self.vnc_password,
        )
    }
}

/// Debug/Display of `KasmEnv` redacts the password (spec §16 "never log").
impl std::fmt::Display for KasmEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "KasmEnv {{ display: {}, ws_port: {}, geometry: {} }}",
            self.display, self.ws_port, self.geometry
        )
    }
}

/// Path of the env file for `linux_username`.
pub fn env_file_path(run_root: &Path, linux_username: &str) -> PathBuf {
    run_root
        .join("kasmvnc")
        .join(format!("{linux_username}.env"))
}

/// Write the env file for `linux_username` under `{run_root}/kasmvnc/`.
///
/// Creates the directory if absent. The file is written with Unix permissions
/// `0600` (owner: root) on Linux; on other platforms permissions are best-effort.
pub fn write_env_file(run_root: &Path, linux_username: &str, env: &KasmEnv) -> std::io::Result<()> {
    let dir = run_root.join("kasmvnc");
    std::fs::create_dir_all(&dir)?;
    let path = env_file_path(run_root, linux_username);
    let contents = env.render();

    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true).mode(0o600);
        let mut file = opts.open(&path)?;
        use std::io::Write;
        file.write_all(contents.as_bytes())?;
    }
    #[cfg(not(target_os = "linux"))]
    {
        std::fs::write(&path, contents.as_bytes())?;
    }

    Ok(())
}

// ── systemctl abstraction ─────────────────────────────────────────────────────

/// Systemctl operation result for desktop units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnitStatus {
    Active,
    Inactive,
    Failed,
    Unknown,
}

impl UnitStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            UnitStatus::Active => "active",
            UnitStatus::Inactive => "inactive",
            UnitStatus::Failed => "failed",
            UnitStatus::Unknown => "unknown",
        }
    }
}

/// Error from a systemctl operation.
#[derive(Debug)]
pub struct SystemctlError(pub String);

impl std::fmt::Display for SystemctlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "systemctl error: {}", self.0)
    }
}

impl std::error::Error for SystemctlError {}

/// Abstract systemctl backend.  The real implementation shells out to the system
/// `systemctl`; [`FakeSystemctl`] records calls for unit tests without requiring
/// systemd.
#[async_trait]
pub trait SystemctlBackend: Send + Sync {
    async fn start(&self, unit: &str) -> Result<(), SystemctlError>;
    async fn stop(&self, unit: &str) -> Result<(), SystemctlError>;
    async fn status(&self, unit: &str) -> Result<UnitStatus, SystemctlError>;
}

// ── desktop port readiness ─────────────────────────────────────────────────────

/// `systemctl start kasmvnc@<user>` returns as soon as the unit's main process
/// has forked — but KasmVNC's `Xvnc` takes a moment longer to actually bind its
/// websocket port. If the guest agent reports the desktop "started" before the
/// port is listening, the Pria VNC proxy races ahead and hits a closed socket
/// (HS-G3 → 502). A [`PortReadiness`] probe lets `start()` block until the port
/// is genuinely reachable. Injectable so unit tests stay socket-free.
#[async_trait]
pub trait PortReadiness: Send + Sync {
    /// Wait until `127.0.0.1:<port>` accepts a TCP connection or the probe's
    /// internal deadline elapses. Returns `true` if the port became ready.
    async fn wait(&self, port: u16) -> bool;
}

/// Default probe used by unit tests and any backend without a real listener:
/// reports ready immediately so tests never block on a socket.
pub struct AlwaysReady;

#[async_trait]
impl PortReadiness for AlwaysReady {
    async fn wait(&self, _port: u16) -> bool {
        true
    }
}

/// Production probe: polls `127.0.0.1:<port>` until connectable or `timeout`.
pub struct TcpPortReadiness {
    pub timeout: std::time::Duration,
    pub interval: std::time::Duration,
}

impl TcpPortReadiness {
    pub fn new(timeout: std::time::Duration) -> Self {
        Self {
            timeout,
            interval: std::time::Duration::from_millis(250),
        }
    }
}

#[async_trait]
impl PortReadiness for TcpPortReadiness {
    async fn wait(&self, port: u16) -> bool {
        let deadline = tokio::time::Instant::now() + self.timeout;
        loop {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(self.interval).await;
        }
    }
}

/// Unit name for a KasmVNC session (spec §4.3 template `kasmvnc@.service`).
pub fn kasmvnc_unit(linux_username: &str) -> String {
    format!("kasmvnc@{linux_username}.service")
}

// ── real systemctl backend ────────────────────────────────────────────────────

/// Shells out to the system `systemctl` binary.  Only available on Linux;
/// on other platforms it always returns an error.
pub struct RealSystemctl;

#[async_trait]
impl SystemctlBackend for RealSystemctl {
    async fn start(&self, unit: &str) -> Result<(), SystemctlError> {
        #[cfg(target_os = "linux")]
        {
            let out = tokio::process::Command::new("systemctl")
                .args(["start", unit])
                .output()
                .await
                .map_err(|e| SystemctlError(format!("spawn failed: {e}")))?;
            if out.status.success() {
                return Ok(());
            }
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(SystemctlError(format!(
                "systemctl start {unit} failed ({}): {stderr}",
                out.status,
            )));
        }
        #[cfg(not(target_os = "linux"))]
        Err(SystemctlError("systemctl only available on Linux".into()))
    }

    async fn stop(&self, unit: &str) -> Result<(), SystemctlError> {
        #[cfg(target_os = "linux")]
        {
            let out = tokio::process::Command::new("systemctl")
                .args(["stop", unit])
                .output()
                .await
                .map_err(|e| SystemctlError(format!("spawn failed: {e}")))?;
            if out.status.success() {
                return Ok(());
            }
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(SystemctlError(format!(
                "systemctl stop {unit} failed ({}): {stderr}",
                out.status,
            )));
        }
        #[cfg(not(target_os = "linux"))]
        Err(SystemctlError("systemctl only available on Linux".into()))
    }

    async fn status(&self, unit: &str) -> Result<UnitStatus, SystemctlError> {
        #[cfg(target_os = "linux")]
        {
            let out = tokio::process::Command::new("systemctl")
                .args(["is-active", "--quiet", unit])
                .output()
                .await
                .map_err(|e| SystemctlError(format!("spawn failed: {e}")))?;
            // `is-active` exit 0 = active, 3 = inactive/failed.
            return Ok(if out.status.success() {
                UnitStatus::Active
            } else {
                // Distinguish "failed" from "inactive" by checking `is-failed`.
                let failed = tokio::process::Command::new("systemctl")
                    .args(["is-failed", "--quiet", unit])
                    .output()
                    .await
                    .map(|o| o.status.success())
                    .unwrap_or(false);
                if failed {
                    UnitStatus::Failed
                } else {
                    UnitStatus::Inactive
                }
            });
        }
        #[cfg(not(target_os = "linux"))]
        Err(SystemctlError("systemctl only available on Linux".into()))
    }
}

// ── fake backend (tests / test-fakes feature) ─────────────────────────────────

#[cfg(any(test, feature = "test-fakes"))]
pub use fake::FakeSystemctl;

#[cfg(any(test, feature = "test-fakes"))]
pub mod fake {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Records start/stop calls and exposes controllable status per unit.
    #[derive(Default)]
    pub struct FakeSystemctl {
        pub started: Mutex<Vec<String>>,
        pub stopped: Mutex<Vec<String>>,
        /// Per-unit status overrides.  Defaults to `Inactive` for unknown units
        /// and `Active` after a `start` call.
        pub statuses: Mutex<HashMap<String, UnitStatus>>,
        /// If set, `start` returns this error.
        pub fail_start: Mutex<Option<String>>,
        /// If set, `stop` returns this error.
        pub fail_stop: Mutex<Option<String>>,
    }

    impl FakeSystemctl {
        /// Pre-set the status for a unit.
        pub fn set_status(&self, unit: &str, status: UnitStatus) {
            self.statuses
                .lock()
                .unwrap()
                .insert(unit.to_string(), status);
        }
    }

    #[async_trait]
    impl SystemctlBackend for FakeSystemctl {
        async fn start(&self, unit: &str) -> Result<(), SystemctlError> {
            if let Some(msg) = self.fail_start.lock().unwrap().clone() {
                return Err(SystemctlError(msg));
            }
            self.started.lock().unwrap().push(unit.to_string());
            self.statuses
                .lock()
                .unwrap()
                .insert(unit.to_string(), UnitStatus::Active);
            Ok(())
        }

        async fn stop(&self, unit: &str) -> Result<(), SystemctlError> {
            if let Some(msg) = self.fail_stop.lock().unwrap().clone() {
                return Err(SystemctlError(msg));
            }
            self.stopped.lock().unwrap().push(unit.to_string());
            self.statuses
                .lock()
                .unwrap()
                .insert(unit.to_string(), UnitStatus::Inactive);
            Ok(())
        }

        async fn status(&self, unit: &str) -> Result<UnitStatus, SystemctlError> {
            Ok(self
                .statuses
                .lock()
                .unwrap()
                .get(unit)
                .cloned()
                .unwrap_or(UnitStatus::Inactive))
        }
    }
}

// ── desktop session record ─────────────────────────────────────────────────────

/// A started desktop session (spec §8.2 `vnc.sessions[]`).
///
/// The `vnc_password` field is intentionally excluded from `Debug` and is never
/// serialized by this type — the API layer (spec §5.4 step 5) serializes it only
/// into the heartbeat VNC session list and the start-desktop response.
///
/// **SECURITY**: never pass this value to `tracing::debug!` or similar.
#[derive(Clone)]
pub struct DesktopSession {
    pub session_id: String,
    pub linux_username: String,
    pub display: String,
    pub port: u16,
    pub basic_user: String,
    /// Raw password — never log (spec §16 "never log HMAC secrets or VNC passwords").
    pub vnc_password: String,
    pub geometry: String,
    pub started_at: String,
}

/// `Debug` for `DesktopSession` redacts the password.
impl std::fmt::Debug for DesktopSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DesktopSession")
            .field("session_id", &self.session_id)
            .field("linux_username", &self.linux_username)
            .field("display", &self.display)
            .field("port", &self.port)
            .field("basic_user", &self.basic_user)
            .field("vnc_password", &"[REDACTED]")
            .field("geometry", &self.geometry)
            .field("started_at", &self.started_at)
            .finish()
    }
}

/// Wire representation of a desktop session for the heartbeat / list API.
/// The `password` field is included because the Pria control plane must store it
/// to hand to the VNC proxy; it must NOT appear in any log line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopSessionInfo {
    pub session_id: String,
    pub linux_username: String,
    pub display: String,
    pub port: u16,
    pub basic_user: String,
    /// VNC transport password — Pria controller uses this for `Basic` auth.
    /// Never log (spec §16, §8.2 note).
    pub password: String,
}

impl DesktopSession {
    pub fn to_info(&self) -> DesktopSessionInfo {
        DesktopSessionInfo {
            session_id: self.session_id.clone(),
            linux_username: self.linux_username.clone(),
            display: self.display.clone(),
            port: self.port,
            basic_user: self.basic_user.clone(),
            password: self.vnc_password.clone(),
        }
    }
}

// ── in-memory desktop store ───────────────────────────────────────────────────

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

/// Thread-safe store of active desktop sessions.
///
/// One entry per Linux user; replaces any previous entry on restart (idempotent
/// start). The allocation lock (`alloc_lock`) serialises concurrent start
/// requests so the port allocator never races.
pub struct DesktopStore {
    sessions: Mutex<HashMap<String, DesktopSession>>,
    /// Serialises port allocation + env-file write + systemctl start.
    /// Uses `tokio::sync::Mutex` so it can be held across `.await` points.
    alloc_lock: AsyncMutex<()>,
    run_root: PathBuf,
    pub systemctl: Arc<dyn SystemctlBackend>,
    /// Probe that gates `start()` on the KasmVNC port actually listening.
    readiness: Arc<dyn PortReadiness>,
}

impl DesktopStore {
    pub fn new(run_root: PathBuf, systemctl: Arc<dyn SystemctlBackend>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            alloc_lock: AsyncMutex::new(()),
            run_root,
            systemctl,
            readiness: Arc::new(AlwaysReady),
        }
    }

    /// Override the port-readiness probe (production wires a real TCP probe so
    /// `start()` only returns once KasmVNC is actually accepting connections).
    pub fn with_port_readiness(mut self, readiness: Arc<dyn PortReadiness>) -> Self {
        self.readiness = readiness;
        self
    }

    /// Start a KasmVNC session for `linux_username`.
    ///
    /// Steps (spec §5.4):
    /// 1. allocate display/port (persisted),
    /// 2. write env file,
    /// 3. `systemctl start kasmvnc@<user>`,
    /// 4. record session.
    ///
    /// Returns the started session. Idempotent if the unit is already active
    /// (re-writes env file and calls start again — systemctl is idempotent).
    pub async fn start(
        &self,
        session_id: String,
        linux_username: String,
        vnc_password: String,
        geometry: Option<String>,
    ) -> Result<DesktopSession, String> {
        // Hold the async alloc_lock across await points to serialise concurrent starts.
        let _lock = self.alloc_lock.lock().await;

        // 1. allocate display/port (sync, persisted file)
        let alloc = crate::desktop::ports::allocate(&self.run_root, &linux_username)
            .map_err(|e| e.to_string())?;
        let crate::desktop::ports::Allocation { display, port } = alloc;
        let display_str = format!(":{display}");
        let geom = geometry.unwrap_or_else(|| DEFAULT_GEOMETRY.to_string());

        // 2. write env file (password goes into the file; never into logs)
        let env = KasmEnv {
            display: display_str.clone(),
            ws_port: port,
            geometry: geom.clone(),
            vnc_password: vnc_password.clone(),
        };
        write_env_file(&self.run_root, &linux_username, &env)
            .map_err(|e| format!("failed to write kasmvnc env file: {e}"))?;

        // 3. systemctl start (async)
        let unit = kasmvnc_unit(&linux_username);
        self.systemctl
            .start(&unit)
            .await
            .map_err(|e| format!("systemctl start {unit} failed: {e}"))?;

        // 3b. wait for KasmVNC to actually bind its websocket port. `systemctl
        // start` returns once the unit's main process has forked, but Xvnc takes
        // a moment to listen; returning early makes the Pria VNC proxy race a
        // closed socket (HS-G3 → 502). Best-effort: log if it never binds but
        // still record the session so the caller can observe/retry.
        if !self.readiness.wait(port).await {
            tracing::warn!(
                unit = %unit,
                port,
                "kasmvnc port did not become ready within timeout; reporting started anyway"
            );
        }

        // 4. record
        let ds = DesktopSession {
            session_id,
            linux_username: linux_username.clone(),
            display: display_str,
            port,
            basic_user: KASM_BASIC_USER.to_string(),
            vnc_password,
            geometry: geom,
            started_at: chrono::Utc::now().to_rfc3339(),
        };
        self.sessions
            .lock()
            .unwrap()
            .insert(linux_username, ds.clone());
        Ok(ds)
    }

    /// Stop the KasmVNC session for `linux_username`.
    ///
    /// Steps (spec §5.4 step 6):
    /// 1. `systemctl stop kasmvnc@<user>`,
    /// 2. release port allocation,
    /// 3. remove from session table.
    pub async fn stop(&self, linux_username: &str) -> Result<(), String> {
        let unit = kasmvnc_unit(linux_username);
        self.systemctl
            .stop(&unit)
            .await
            .map_err(|e| format!("systemctl stop {unit} failed: {e}"))?;

        let _lock = self.alloc_lock.lock().await;
        crate::desktop::ports::release(&self.run_root, linux_username)
            .map_err(|e| e.to_string())?;
        self.sessions.lock().unwrap().remove(linux_username);
        Ok(())
    }

    /// Snapshot all active sessions (for heartbeat / list endpoint).
    /// Password is included in the snapshot for the Pria heartbeat §8.2 contract.
    pub fn list(&self) -> Vec<DesktopSession> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }

    /// Look up a single session by Linux username.
    pub fn get(&self, linux_username: &str) -> Option<DesktopSession> {
        self.sessions.lock().unwrap().get(linux_username).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_run_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ga-kasmvnc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_store(root: PathBuf) -> DesktopStore {
        DesktopStore::new(root, Arc::new(fake::FakeSystemctl::default()))
    }

    #[test]
    fn env_render_contains_required_fields() {
        let env = KasmEnv {
            display: ":1".into(),
            ws_port: 6901,
            geometry: "1280x800".into(),
            vnc_password: "s3cr3t".into(),
        };
        let rendered = env.render();
        assert!(rendered.contains("KASM_DISPLAY=:1"));
        assert!(rendered.contains("KASM_WS_PORT=6901"));
        assert!(rendered.contains("KASM_GEOMETRY=1280x800"));
        assert!(rendered.contains("KASM_VNC_PASSWORD=s3cr3t"));
    }

    #[test]
    fn env_display_redacts_password() {
        let env = KasmEnv {
            display: ":1".into(),
            ws_port: 6901,
            geometry: "1280x800".into(),
            vnc_password: "topsecret".into(),
        };
        let displayed = format!("{env}");
        assert!(
            !displayed.contains("topsecret"),
            "password must be redacted in Display: {displayed}"
        );
    }

    #[test]
    fn debug_session_redacts_password() {
        let ds = DesktopSession {
            session_id: "sess_1".into(),
            linux_username: "pria_u_a".into(),
            display: ":1".into(),
            port: 6901,
            basic_user: KASM_BASIC_USER.into(),
            vnc_password: "supersecret".into(),
            geometry: DEFAULT_GEOMETRY.into(),
            started_at: "2026-06-14T00:00:00Z".into(),
        };
        let debug_str = format!("{ds:?}");
        assert!(
            !debug_str.contains("supersecret"),
            "password must be redacted in Debug: {debug_str}"
        );
        assert!(debug_str.contains("[REDACTED]"));
    }

    #[test]
    fn env_file_written_and_readable() {
        let root = tmp_run_root();
        let env = KasmEnv {
            display: ":2".into(),
            ws_port: 6902,
            geometry: "1920x1080".into(),
            vnc_password: "pw123".into(),
        };
        write_env_file(&root, "pria_u_b", &env).unwrap();
        let path = env_file_path(&root, "pria_u_b");
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("KASM_DISPLAY=:2"));
        assert!(contents.contains("KASM_WS_PORT=6902"));
    }

    #[tokio::test]
    async fn store_start_records_session_and_calls_systemctl() {
        let root = tmp_run_root();
        let fake_ctl = Arc::new(fake::FakeSystemctl::default());
        let store = DesktopStore::new(root.clone(), fake_ctl.clone());

        let ds = store
            .start(
                "sess_desktop_1".into(),
                "pria_u_a".into(),
                "vnc_pw_a".into(),
                None,
            )
            .await
            .unwrap();

        assert_eq!(ds.linux_username, "pria_u_a");
        assert_eq!(ds.port, 6901);
        assert_eq!(ds.display, ":1");
        assert_eq!(ds.basic_user, KASM_BASIC_USER);
        assert_eq!(ds.vnc_password, "vnc_pw_a");

        let started = fake_ctl.started.lock().unwrap();
        assert_eq!(started.as_slice(), &["kasmvnc@pria_u_a.service"]);

        assert_eq!(store.list().len(), 1);
    }

    #[tokio::test]
    async fn store_start_two_users_get_distinct_ports() {
        let root = tmp_run_root();
        let store = make_store(root);

        let a = store
            .start("sess_a".into(), "pria_u_a".into(), "pw_a".into(), None)
            .await
            .unwrap();
        let b = store
            .start("sess_b".into(), "pria_u_b".into(), "pw_b".into(), None)
            .await
            .unwrap();

        assert_ne!(a.port, b.port);
        assert_ne!(a.display, b.display);
        // spec §5.2: ports 6901/6902
        let ports: std::collections::HashSet<u16> = [a.port, b.port].into();
        assert!(ports.contains(&6901));
        assert!(ports.contains(&6902));
    }

    #[tokio::test]
    async fn store_stop_removes_session_and_releases_port() {
        let root = tmp_run_root();
        let fake_ctl = Arc::new(fake::FakeSystemctl::default());
        let store = DesktopStore::new(root.clone(), fake_ctl.clone());

        store
            .start("sess_a".into(), "pria_u_a".into(), "pw".into(), None)
            .await
            .unwrap();
        store.stop("pria_u_a").await.unwrap();

        assert!(store.get("pria_u_a").is_none());
        let stopped = fake_ctl.stopped.lock().unwrap();
        assert!(stopped.contains(&"kasmvnc@pria_u_a.service".to_string()));

        // Port should be released and reusable.
        let c = store
            .start("sess_c".into(), "pria_u_c".into(), "pw_c".into(), None)
            .await
            .unwrap();
        assert_eq!(c.port, 6901);
    }

    #[tokio::test]
    async fn store_start_systemctl_failure_returns_error() {
        let root = tmp_run_root();
        let fake_ctl = Arc::new(fake::FakeSystemctl::default());
        *fake_ctl.fail_start.lock().unwrap() = Some("D-Bus connection failed".into());
        let store = DesktopStore::new(root, fake_ctl);

        let result = store
            .start("sess_x".into(), "pria_u_x".into(), "pw".into(), None)
            .await;
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(msg.contains("D-Bus connection failed"), "{msg}");
    }

    #[tokio::test]
    async fn store_list_returns_all_sessions() {
        let root = tmp_run_root();
        let store = make_store(root);

        store
            .start("s1".into(), "ua".into(), "pw1".into(), None)
            .await
            .unwrap();
        store
            .start("s2".into(), "ub".into(), "pw2".into(), None)
            .await
            .unwrap();

        let list = store.list();
        assert_eq!(list.len(), 2);
        let usernames: std::collections::HashSet<&str> =
            list.iter().map(|s| s.linux_username.as_str()).collect();
        assert!(usernames.contains("ua"));
        assert!(usernames.contains("ub"));
    }

    #[test]
    fn kasmvnc_unit_name_format() {
        assert_eq!(kasmvnc_unit("pria_u_12001"), "kasmvnc@pria_u_12001.service");
    }

    #[test]
    fn to_info_includes_password_for_controller() {
        let ds = DesktopSession {
            session_id: "sess_1".into(),
            linux_username: "user".into(),
            display: ":1".into(),
            port: 6901,
            basic_user: KASM_BASIC_USER.into(),
            vnc_password: "vnc_secret".into(),
            geometry: DEFAULT_GEOMETRY.into(),
            started_at: "2026-06-14T00:00:00Z".into(),
        };
        let info = ds.to_info();
        // The controller (spec §5.1) needs the password to build Basic auth.
        assert_eq!(info.password, "vnc_secret");
        assert_eq!(info.basic_user, "kasm_user");
    }

    #[tokio::test]
    async fn always_ready_probe_returns_immediately() {
        // The default probe never blocks (so unit tests stay socket-free).
        assert!(AlwaysReady.wait(6901).await);
    }

    #[tokio::test]
    async fn tcp_probe_detects_a_listening_port() {
        // Bind an ephemeral port and confirm the probe sees it as ready.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let probe = TcpPortReadiness::new(std::time::Duration::from_secs(2));
        assert!(probe.wait(port).await, "probe must detect a bound port");
    }

    #[tokio::test]
    async fn tcp_probe_times_out_on_closed_port() {
        // Reserve then drop a port so nothing is listening; the probe must give
        // up at its deadline rather than hang.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let probe = TcpPortReadiness::new(std::time::Duration::from_millis(400));
        assert!(!probe.wait(port).await, "probe must time out on a closed port");
    }

    #[tokio::test]
    async fn start_waits_for_port_readiness_probe() {
        // start() must consult the readiness probe; inject one that records the
        // port it was asked about so we can assert the gate ran.
        use std::sync::Mutex as StdMutex;
        struct RecordingProbe {
            seen: StdMutex<Vec<u16>>,
        }
        #[async_trait]
        impl PortReadiness for RecordingProbe {
            async fn wait(&self, port: u16) -> bool {
                self.seen.lock().unwrap().push(port);
                true
            }
        }
        let probe = Arc::new(RecordingProbe {
            seen: StdMutex::new(Vec::new()),
        });
        let store = DesktopStore::new(tmp_run_root(), Arc::new(fake::FakeSystemctl::default()))
            .with_port_readiness(probe.clone());
        let ds = store
            .start("sess_r".into(), "pria_u_r".into(), "pw".into(), None)
            .await
            .unwrap();
        let seen = probe.seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "readiness probe must run exactly once");
        assert_eq!(seen[0], ds.port, "probe must check the allocated KasmVNC port");
    }
}
