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

/// Parse a previously written env file back into a [`KasmEnv`]. Used by
/// [`DesktopStore::rehydrate`] to recover a surviving desktop's port / geometry
/// / password after a guest-agent restart (the in-memory session table is lost
/// but the env file persists, root-owned 0600). Returns `None` if the file is
/// absent or missing a required key.
pub fn read_env_file(run_root: &Path, linux_username: &str) -> Option<KasmEnv> {
    let path = env_file_path(run_root, linux_username);
    let raw = std::fs::read_to_string(&path).ok()?;
    let mut display = None;
    let mut ws_port = None;
    let mut geometry = None;
    let mut vnc_password = None;
    for line in raw.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        match k.trim() {
            "KASM_DISPLAY" => display = Some(v.trim().to_string()),
            "KASM_WS_PORT" => ws_port = v.trim().parse::<u16>().ok(),
            "KASM_GEOMETRY" => geometry = Some(v.trim().to_string()),
            "KASM_VNC_PASSWORD" => vnc_password = Some(v.trim().to_string()),
            _ => {}
        }
    }
    Some(KasmEnv {
        display: display?,
        ws_port: ws_port?,
        geometry: geometry?,
        vnc_password: vnc_password?,
    })
}

/// Non-secret session metadata persisted alongside the env file so the
/// session table can be faithfully rebuilt on restart. The VNC password is
/// deliberately NOT stored here — it lives only in the root-owned 0600 env
/// file ([`write_env_file`]); rehydrate reads it back from there.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionMeta {
    pub session_id: String,
    pub started_at: String,
}

/// Path of the session-metadata sidecar for `linux_username`.
pub fn session_meta_path(run_root: &Path, linux_username: &str) -> PathBuf {
    run_root
        .join("kasmvnc")
        .join(format!("{linux_username}.meta.json"))
}

/// Write the session-metadata sidecar (created atomically). Best-effort caller —
/// a desktop start still succeeds if this fails (rehydrate falls back to a
/// synthesized session id).
pub fn write_session_meta(
    run_root: &Path,
    linux_username: &str,
    meta: &SessionMeta,
) -> std::io::Result<()> {
    let dir = run_root.join("kasmvnc");
    std::fs::create_dir_all(&dir)?;
    let path = session_meta_path(run_root, linux_username);
    let json = serde_json::to_vec_pretty(meta)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Read the session-metadata sidecar for `linux_username`, if present.
pub fn read_session_meta(run_root: &Path, linux_username: &str) -> Option<SessionMeta> {
    let path = session_meta_path(run_root, linux_username);
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Remove the session-metadata sidecar for `linux_username` (best-effort).
pub fn remove_session_meta(run_root: &Path, linux_username: &str) {
    let _ = std::fs::remove_file(session_meta_path(run_root, linux_username));
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

// ── desktop password application ────────────────────────────────────────────

/// Applies the KasmVNC Basic-auth (`kasm_user`) password to a user's
/// `~/.kasmpasswd`.
///
/// Why this is a distinct, always-run step (and not left to the unit's
/// `ExecStartPre=pria-kasm-setpw`):
///
/// The `kasmvnc@<user>.service` unit writes `.kasmpasswd` from its
/// `ExecStartPre` hook — but **only when the unit actually (re)starts**.
/// `systemctl start` is a no-op when the unit is already active, so a desktop
/// that survived a guest-agent restart keeps its *old* `.kasmpasswd` even
/// though the control plane just supplied a fresh password (the agent's
/// in-memory session table is lost on restart, so the reuse path on the
/// control plane misses the live desktop and issues a fresh `start` with a new
/// password). The result is a Basic-auth mismatch → KasmVNC 401 → the Pria VNC
/// proxy surfaces "Request failed with status code 401".
///
/// KasmVNC re-reads `.kasmpasswd` per connection, so applying the password
/// directly (no unit restart) is sufficient and non-disruptive: the user's
/// running X session is preserved while the new credential takes effect on the
/// next handshake. Injectable so unit tests never shell out.
#[async_trait]
pub trait PasswordApplier: Send + Sync {
    /// Write `vnc_password` into `linux_username`'s `~/.kasmpasswd` for the
    /// `kasm_user` transport. Must be idempotent (safe to run on every start,
    /// including immediately after the unit's own `ExecStartPre`).
    async fn apply(&self, linux_username: &str, vnc_password: &str) -> Result<(), String>;
}

/// Default applier for unit tests / any backend without a real helper: does
/// nothing so tests never spawn a process or touch the filesystem.
pub struct NoopPasswordApplier;

#[async_trait]
impl PasswordApplier for NoopPasswordApplier {
    async fn apply(&self, _linux_username: &str, _vnc_password: &str) -> Result<(), String> {
        Ok(())
    }
}

/// Default path to the privileged setpw helper (matches the unit's
/// `ExecStartPre=+/usr/local/sbin/pria-kasm-setpw`).
pub const DEFAULT_SETPW_BIN: &str = "/usr/local/sbin/pria-kasm-setpw";

/// Production applier: invokes the `pria-kasm-setpw` helper exactly as the
/// systemd unit's `ExecStartPre` does — as root, with the password supplied via
/// the `KASM_VNC_PASSWORD` environment variable (never on argv; spec §16,
/// HS-G1). The helper resolves the user's home, writes `.kasmpasswd` mode 0600,
/// and is idempotent.
pub struct SetpwApplier {
    pub bin: PathBuf,
}

impl Default for SetpwApplier {
    fn default() -> Self {
        let bin = std::env::var("PRIA_KASM_SETPW_BIN")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_SETPW_BIN));
        Self { bin }
    }
}

#[async_trait]
impl PasswordApplier for SetpwApplier {
    async fn apply(&self, linux_username: &str, vnc_password: &str) -> Result<(), String> {
        #[cfg(target_os = "linux")]
        {
            // Password is passed via env, never argv, and is never logged.
            let out = tokio::process::Command::new(&self.bin)
                .arg(linux_username)
                .env("KASM_VNC_PASSWORD", vnc_password)
                .output()
                .await
                .map_err(|e| format!("spawn {} failed: {e}", self.bin.display()))?;
            if out.status.success() {
                return Ok(());
            }
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "{} {linux_username} failed ({}): {stderr}",
                self.bin.display(),
                out.status
            ));
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (linux_username, vnc_password);
            Err("setpw only available on Linux".into())
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

    /// Records every `(linux_username, vnc_password)` the store asked to apply,
    /// so tests can assert the password is (re)written on every start —
    /// including reuse of an already-running unit.
    #[derive(Default)]
    pub struct FakePasswordApplier {
        pub applied: Mutex<Vec<(String, String)>>,
        /// If set, `apply` returns this error (to exercise the fail-open path).
        pub fail: Mutex<Option<String>>,
    }

    #[async_trait]
    impl PasswordApplier for FakePasswordApplier {
        async fn apply(&self, linux_username: &str, vnc_password: &str) -> Result<(), String> {
            if let Some(msg) = self.fail.lock().unwrap().clone() {
                return Err(msg);
            }
            self.applied
                .lock()
                .unwrap()
                .push((linux_username.to_string(), vnc_password.to_string()));
            Ok(())
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
    /// Applies the supplied VNC password to `~/.kasmpasswd` on every start so a
    /// reused/already-running unit still honors a freshly-minted credential.
    password_applier: Arc<dyn PasswordApplier>,
}

impl DesktopStore {
    pub fn new(run_root: PathBuf, systemctl: Arc<dyn SystemctlBackend>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            alloc_lock: AsyncMutex::new(()),
            run_root,
            systemctl,
            readiness: Arc::new(AlwaysReady),
            password_applier: Arc::new(NoopPasswordApplier),
        }
    }

    /// Override the port-readiness probe (production wires a real TCP probe so
    /// `start()` only returns once KasmVNC is actually accepting connections).
    pub fn with_port_readiness(mut self, readiness: Arc<dyn PortReadiness>) -> Self {
        self.readiness = readiness;
        self
    }

    /// Override the password applier (production wires [`SetpwApplier`] so the
    /// control-plane-supplied password is written to `~/.kasmpasswd` even when
    /// the unit is already running and `systemctl start` no-ops).
    pub fn with_password_applier(mut self, applier: Arc<dyn PasswordApplier>) -> Self {
        self.password_applier = applier;
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

        // 3a. Apply the password to ~/.kasmpasswd unconditionally.
        //
        // `systemctl start` is a no-op when the unit is already active (e.g. the
        // desktop survived a guest-agent restart, so the control plane's
        // single-session reuse missed it and issued a fresh start with a new
        // password). In that case the unit's `ExecStartPre=pria-kasm-setpw` does
        // NOT run, leaving `.kasmpasswd` holding the previous credential — the
        // freshly-supplied password would then 401 at the KasmVNC Basic-auth
        // gate. Applying it directly here closes that gap; KasmVNC re-reads the
        // file per connection so the running X session is preserved. Idempotent
        // and best-effort: a failure is logged but does not abort the start
        // (behavior is then no worse than before this step existed).
        if let Err(e) = self
            .password_applier
            .apply(&linux_username, &vnc_password)
            .await
        {
            tracing::warn!(
                unit = %unit,
                error = %e,
                "failed to apply kasmvnc password to .kasmpasswd; Basic auth may 401 until next unit restart"
            );
        }

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
            .insert(linux_username.clone(), ds.clone());

        // Persist non-secret session metadata so the session table can be
        // faithfully rebuilt after a guest-agent restart (rehydrate()). The VNC
        // password is NOT written here — it stays in the 0600 env file.
        if let Err(e) = write_session_meta(
            &self.run_root,
            &linux_username,
            &SessionMeta {
                session_id: ds.session_id.clone(),
                started_at: ds.started_at.clone(),
            },
        ) {
            tracing::warn!(
                user = %linux_username,
                error = %e,
                "failed to persist desktop session metadata; rehydrate will synthesize a session id"
            );
        }
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
        remove_session_meta(&self.run_root, linux_username);
        self.sessions.lock().unwrap().remove(linux_username);
        Ok(())
    }

    /// Rebuild the in-memory session table from persisted state after a restart.
    ///
    /// The session `HashMap` is in-memory and lost when the guest-agent process
    /// restarts, but the desktops themselves (the `kasmvnc@<user>` systemd
    /// units) keep running and their port allocations + env files + metadata
    /// sidecars persist on disk. Without this, `GET /desktops` reports an empty
    /// table after a restart, so the control plane's single-session reuse check
    /// misses the live desktop and issues a redundant fresh `/start` (harmless
    /// since the port is reused and the password is re-applied, but not ideal).
    ///
    /// For each persisted allocation whose unit is still `Active`, this reads
    /// the env file (port/geometry/password) and the metadata sidecar
    /// (session_id/started_at) and re-records the session so `GET /desktops` is
    /// truthful and single-session reuse works as designed. Stale allocations
    /// (unit no longer active) are released so their slot frees up.
    ///
    /// Best-effort and idempotent: any per-user error is logged and skipped;
    /// already-present sessions are left untouched. Returns the count restored.
    pub async fn rehydrate(&self) -> usize {
        let allocations = crate::desktop::ports::snapshot(&self.run_root);
        let mut restored = 0;
        for (username, alloc) in allocations {
            // Don't clobber a session already recorded this process lifetime.
            if self.sessions.lock().unwrap().contains_key(&username) {
                continue;
            }
            let unit = kasmvnc_unit(&username);
            let active = matches!(
                self.systemctl.status(&unit).await,
                Ok(UnitStatus::Active)
            );
            if !active {
                // The desktop is gone; free the stale allocation + metadata so
                // the display/port slot can be reused.
                let _ = crate::desktop::ports::release(&self.run_root, &username);
                remove_session_meta(&self.run_root, &username);
                continue;
            }
            let Some(env) = read_env_file(&self.run_root, &username) else {
                tracing::warn!(
                    user = %username,
                    "kasmvnc unit active but env file missing/unparseable; cannot rehydrate session"
                );
                continue;
            };
            // Recover the original session id when the sidecar is present;
            // otherwise synthesize a stable rehydrated id so the desktop is
            // still reusable by linux_username.
            let meta = read_session_meta(&self.run_root, &username);
            let session_id = meta
                .as_ref()
                .map(|m| m.session_id.clone())
                .unwrap_or_else(|| format!("rehydrated:{username}"));
            let started_at = meta
                .map(|m| m.started_at)
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
            let ds = DesktopSession {
                session_id,
                linux_username: username.clone(),
                display: format!(":{}", alloc.display),
                port: env.ws_port,
                basic_user: KASM_BASIC_USER.to_string(),
                vnc_password: env.vnc_password,
                geometry: env.geometry,
                started_at,
            };
            self.sessions
                .lock()
                .unwrap()
                .insert(username.clone(), ds);
            restored += 1;
        }
        if restored > 0 {
            tracing::info!(restored, "rehydrated desktop sessions from persisted state");
        }
        restored
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

    #[tokio::test]
    async fn start_applies_password_on_every_start_including_reuse() {
        // Regression: when a KasmVNC unit survives a guest-agent restart, the
        // control plane misses it (in-memory session table lost) and issues a
        // fresh start with a NEW password. `systemctl start` no-ops on the
        // already-active unit, so the unit's own ExecStartPre never re-runs —
        // start() MUST therefore apply the password itself, every time, or the
        // new credential 401s at KasmVNC's Basic-auth gate.
        let applier = Arc::new(fake::FakePasswordApplier::default());
        let store = DesktopStore::new(tmp_run_root(), Arc::new(fake::FakeSystemctl::default()))
            .with_password_applier(applier.clone());

        store
            .start("sess_1".into(), "pria_u_x".into(), "pw_first".into(), None)
            .await
            .unwrap();
        // Second start for the SAME user = the reuse / already-running case.
        store
            .start("sess_2".into(), "pria_u_x".into(), "pw_second".into(), None)
            .await
            .unwrap();

        let applied = applier.applied.lock().unwrap();
        assert_eq!(
            applied.len(),
            2,
            "password must be applied on every start, not just the first"
        );
        assert_eq!(applied[0], ("pria_u_x".into(), "pw_first".into()));
        assert_eq!(
            applied[1],
            ("pria_u_x".into(), "pw_second".into()),
            "the fresh password must be re-applied even when the unit is reused"
        );
    }

    #[tokio::test]
    async fn start_is_fail_open_when_password_apply_fails() {
        // A setpw failure must not abort the start (behavior is then no worse
        // than before this step existed); the session is still recorded.
        let applier = Arc::new(fake::FakePasswordApplier::default());
        *applier.fail.lock().unwrap() = Some("kasmvncpasswd not found".into());
        let store = DesktopStore::new(tmp_run_root(), Arc::new(fake::FakeSystemctl::default()))
            .with_password_applier(applier.clone());

        let ds = store
            .start("sess_fo".into(), "pria_u_fo".into(), "pw".into(), None)
            .await
            .expect("start must succeed even if password apply fails (fail-open)");
        assert_eq!(ds.session_id, "sess_fo");
        assert!(
            applier.applied.lock().unwrap().is_empty(),
            "the failing applier recorded nothing, but start still succeeded"
        );
    }

    #[test]
    fn setpw_applier_default_honors_env_override() {
        // Default path matches the unit's ExecStartPre; PRIA_KASM_SETPW_BIN
        // overrides it for non-standard installs.
        let def = SetpwApplier::default();
        assert!(def.bin.ends_with("pria-kasm-setpw"));
    }

    // ── rehydrate ─────────────────────────────────────────────────────────────

    // After a guest-agent restart the in-memory session table is empty, but the
    // desktop's allocation + env file + metadata sidecar persist and the
    // `kasmvnc@<user>` unit is still active. rehydrate() must rebuild the
    // session faithfully so GET /desktops is truthful and single-session reuse
    // works (no redundant fresh start).
    #[tokio::test]
    async fn rehydrate_restores_active_session_from_persisted_state() {
        let root = tmp_run_root();
        let ctl = Arc::new(fake::FakeSystemctl::default());
        // First process lifetime: start a desktop (persists alloc/env/meta).
        {
            let store = DesktopStore::new(root.clone(), ctl.clone());
            store
                .start("sess_orig".into(), "pria_u_a".into(), "pw_a".into(), Some("1280x800".into()))
                .await
                .unwrap();
        }
        // Simulate restart: brand-new store over the SAME run_root. Its session
        // table starts empty, but the unit is still Active in the shared fake.
        let store2 = DesktopStore::new(root.clone(), ctl.clone());
        assert!(store2.list().is_empty(), "fresh store starts with no sessions");
        let restored = store2.rehydrate().await;
        assert_eq!(restored, 1, "the active desktop must be rehydrated");
        let s = store2.get("pria_u_a").expect("session present after rehydrate");
        // Faithful recovery: original session id, port, geometry, password.
        assert_eq!(s.session_id, "sess_orig");
        assert_eq!(s.port, 6901);
        assert_eq!(s.geometry, "1280x800");
        assert_eq!(s.vnc_password, "pw_a");
        assert_eq!(s.display, ":1");
    }

    // A persisted allocation whose unit is no longer active must NOT be
    // rehydrated, and its stale allocation should be released so the slot frees.
    #[tokio::test]
    async fn rehydrate_skips_and_releases_inactive_units() {
        let root = tmp_run_root();
        let ctl = Arc::new(fake::FakeSystemctl::default());
        {
            let store = DesktopStore::new(root.clone(), ctl.clone());
            store
                .start("sess_dead".into(), "pria_u_dead".into(), "pw".into(), None)
                .await
                .unwrap();
        }
        // Desktop died across the restart.
        ctl.set_status(&kasmvnc_unit("pria_u_dead"), UnitStatus::Inactive);
        let store2 = DesktopStore::new(root.clone(), ctl.clone());
        let restored = store2.rehydrate().await;
        assert_eq!(restored, 0, "an inactive unit must not be rehydrated");
        assert!(store2.get("pria_u_dead").is_none());
        // The stale slot was released → a new user gets display :1 again.
        let realloc = crate::desktop::ports::allocate(&root, "pria_u_new").unwrap();
        assert_eq!(realloc.display, 1, "stale allocation must be freed");
    }

    // Rehydrate is idempotent and never clobbers a session already recorded in
    // the current process lifetime.
    #[tokio::test]
    async fn rehydrate_is_idempotent_and_preserves_live_sessions() {
        let root = tmp_run_root();
        let ctl = Arc::new(fake::FakeSystemctl::default());
        let store = DesktopStore::new(root.clone(), ctl.clone());
        store
            .start("sess_live".into(), "pria_u_a".into(), "pw_live".into(), None)
            .await
            .unwrap();
        // Rehydrate must not duplicate or overwrite the live session.
        assert_eq!(store.rehydrate().await, 0, "live session is not re-restored");
        let s = store.get("pria_u_a").unwrap();
        assert_eq!(s.session_id, "sess_live");
        assert_eq!(s.vnc_password, "pw_live");
        // Running it again is still a no-op.
        assert_eq!(store.rehydrate().await, 0);
    }

    // When the metadata sidecar is missing (e.g. an older desktop started before
    // this feature), rehydrate still recovers the desktop from the env file and
    // synthesizes a stable session id so it remains reusable by linux_username.
    #[tokio::test]
    async fn rehydrate_synthesizes_session_id_without_sidecar() {
        let root = tmp_run_root();
        let ctl = Arc::new(fake::FakeSystemctl::default());
        {
            let store = DesktopStore::new(root.clone(), ctl.clone());
            store
                .start("sess_orig".into(), "pria_u_a".into(), "pw_a".into(), None)
                .await
                .unwrap();
        }
        // Remove the sidecar to emulate a pre-feature desktop.
        remove_session_meta(&root, "pria_u_a");
        let store2 = DesktopStore::new(root.clone(), ctl.clone());
        assert_eq!(store2.rehydrate().await, 1);
        let s = store2.get("pria_u_a").unwrap();
        assert_eq!(s.session_id, "rehydrated:pria_u_a");
        assert_eq!(s.vnc_password, "pw_a", "password still recovered from env file");
    }

    #[test]
    fn read_env_file_round_trips_written_env() {
        let root = tmp_run_root();
        let env = KasmEnv {
            display: ":3".into(),
            ws_port: 6903,
            geometry: "1920x1080".into(),
            vnc_password: "rt_secret".into(),
        };
        write_env_file(&root, "pria_u_rt", &env).unwrap();
        let back = read_env_file(&root, "pria_u_rt").expect("env file parses");
        assert_eq!(back.display, ":3");
        assert_eq!(back.ws_port, 6903);
        assert_eq!(back.geometry, "1920x1080");
        assert_eq!(back.vnc_password, "rt_secret");
    }
}
