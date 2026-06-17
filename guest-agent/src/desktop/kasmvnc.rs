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

// ── desktop context identity (spec §4.2, §6.1) ────────────────────────────────

/// Per-desktop institution/digital-twin context delivered by the control plane.
///
/// Desktop identity is `(account_id, linux_username, instance_id)`: the same
/// Linux user runs INDEPENDENT institution desktops on one shared Account VM, so
/// every runtime artefact (registry entry, display/port, env + password + log
/// paths, systemd unit) is keyed by the [`desktop_key`] derived from
/// `(linux_username, instance_id)` — never by `linux_username` alone.
///
/// All fields are optional so a legacy control plane that sends no `instance_id`
/// keeps the pre-instance-aware single-desktop-per-user behaviour.
#[derive(Debug, Clone, Default)]
pub struct DesktopContext {
    pub instance_id: Option<String>,
    pub account_id: Option<String>,
    pub vm_id: Option<String>,
    pub workspace_dir: Option<String>,
    pub session_dir: Option<String>,
}

impl DesktopContext {
    /// The non-empty, trimmed instance id (institution/digital-twin) if present.
    pub fn instance(&self) -> Option<&str> {
        self.instance_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
}

/// Sanitize a string for safe use inside a file name or systemd unit name:
/// keep `[A-Za-z0-9_.-]`, replace everything else with `_`. Linux usernames and
/// Pria instance ids are already within this set, so this is a defensive guard
/// (never a lossy transform for legitimate input) that prevents path traversal
/// or unit-name injection from a malformed context.
pub fn sanitize_key_component(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Desktop runtime context key: `(linux_username, instance_id)`.
///
/// * With an instance id → `"<linux_username>__<instance_id>"` (both sanitized),
///   so two institutions for the same Linux user get independent desktops.
/// * Without an instance id → `"<linux_username>"` (legacy single-desktop key),
///   preserving backward compatibility with a control plane that doesn't send
///   `instance_id`.
pub fn desktop_key(linux_username: &str, instance_id: Option<&str>) -> String {
    match instance_id.map(str::trim).filter(|s| !s.is_empty()) {
        Some(instance) => format!(
            "{}__{}",
            sanitize_key_component(linux_username),
            sanitize_key_component(instance)
        ),
        None => sanitize_key_component(linux_username),
    }
}

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
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
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
///
/// `linux_username`/`instance_id` (+ optional account/vm/dir context) are
/// persisted so rehydrate can reconstruct the full desktop identity from the
/// context-keyed sidecar without parsing the [`desktop_key`] back apart.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SessionMeta {
    pub session_id: String,
    pub started_at: String,
    #[serde(default)]
    pub linux_username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vm_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_dir: Option<String>,
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

/// Legacy unit name for a single-desktop-per-user KasmVNC session: the
/// `kasmvnc@<linux_username>.service` template instance (spec §4.3). Used only
/// when no `instance_id` is supplied (backward compatibility).
pub fn kasmvnc_unit(linux_username: &str) -> String {
    format!("kasmvnc@{linux_username}.service")
}

/// Concrete per-context unit name for an instance-aware desktop (spec §2.3
/// Option A): `pria-kasmvnc-<context_key>.service`. A concrete (non-template)
/// unit is required because `kasmvnc@%i.service` derives `User=%i` from the
/// instance name — which is no longer a Linux user once the instance name is the
/// context key. The generated unit pins `User=<linux_username>` explicitly.
pub fn context_unit(context_key: &str) -> String {
    format!("pria-kasmvnc-{context_key}.service")
}

// ── per-context systemd unit generation (spec §2.3 Option A, §7.3) ────────────

/// Everything a [`UnitGenerator`] needs to materialise (or name) the systemd
/// unit for one desktop context.
#[derive(Debug, Clone)]
pub struct DesktopUnitSpec {
    /// Context key from [`desktop_key`].
    pub key: String,
    /// Linux user the desktop process must run as (`User=` in a generated unit).
    pub linux_username: String,
    /// Institution/digital-twin instance id, when instance-aware.
    pub instance_id: Option<String>,
    /// Path to the rendered EnvironmentFile for this context.
    pub env_file: PathBuf,
}

impl DesktopUnitSpec {
    /// True when this is an instance-aware (multi-context) desktop that needs a
    /// generated concrete unit; false for the legacy single-desktop template.
    pub fn is_instance_aware(&self) -> bool {
        self.instance_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|s| !s.is_empty())
    }
}

/// Decides/creates the systemd unit backing a desktop context and returns the
/// unit name `SystemctlBackend::start` should invoke.
///
/// * Legacy (no instance id) → returns `kasmvnc@<user>.service`, writes nothing
///   (the baked template owns it).
/// * Instance-aware → ensures `pria-kasmvnc-<key>.service` exists with an
///   explicit `User=` + this context's EnvironmentFile, then returns its name.
///
/// Injectable so unit tests stay filesystem-free.
#[async_trait]
pub trait UnitGenerator: Send + Sync {
    async fn ensure(&self, spec: &DesktopUnitSpec) -> Result<String, String>;
    /// Best-effort teardown of a generated unit on stop (no-op for the legacy
    /// template, whose lifecycle is owned by the baked AMI).
    async fn remove(&self, _spec: &DesktopUnitSpec) -> Result<(), String> {
        Ok(())
    }
}

/// Default generator: chooses the unit NAME by context but performs no
/// filesystem work — legacy desktops use the baked template, instance-aware
/// desktops resolve to `pria-kasmvnc-<key>.service`. Used by tests and any
/// backend where the concrete unit is provisioned out of band.
pub struct DefaultUnitNaming;

#[async_trait]
impl UnitGenerator for DefaultUnitNaming {
    async fn ensure(&self, spec: &DesktopUnitSpec) -> Result<String, String> {
        Ok(if spec.is_instance_aware() {
            context_unit(&spec.key)
        } else {
            kasmvnc_unit(&spec.linux_username)
        })
    }
}

/// Render a concrete per-context KasmVNC unit (spec §2.3 Option A). Mirrors the
/// baked `kasmvnc@.service` template but pins `User=` and the EnvironmentFile to
/// THIS context so multiple institution desktops for one Linux user never
/// collide on display/port/password. The password file is also context-specific
/// (`KASM_PASSWD_FILE`, see [`context_passwd_file`]) to avoid `~/.kasmpasswd`
/// overwrites between concurrent desktops (spec §6.5).
pub fn render_context_unit(spec: &DesktopUnitSpec) -> String {
    format!(
        "[Unit]\n\
         Description=KasmVNC desktop (pria context {key})\n\
         After=network-online.target\n\
         \n\
         [Service]\n\
         User={user}\n\
         PAMName=login\n\
         EnvironmentFile={env}\n\
         ExecStartPre=+/usr/local/sbin/pria-kasm-setpw {user} {key}\n\
         ExecStart=/usr/bin/vncserver ${{KASM_DISPLAY}} -fg -geometry ${{KASM_GEOMETRY}} -websocketPort ${{KASM_WS_PORT}} -interface 0.0.0.0\n\
         ExecStop=/usr/bin/vncserver -kill ${{KASM_DISPLAY}}\n\
         Restart=on-failure\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target\n",
        key = spec.key,
        user = spec.linux_username,
        env = spec.env_file.display(),
    )
}

/// Default directory generated desktop units are written to.
pub const SYSTEMD_UNIT_DIR: &str = "/etc/systemd/system";

/// Production generator: writes `pria-kasmvnc-<key>.service` into
/// `{unit_dir}` (default `/etc/systemd/system`), runs `systemctl daemon-reload`,
/// and returns the concrete unit name. Legacy contexts fall through to the baked
/// template (no file written).
pub struct FileUnitGenerator {
    pub unit_dir: PathBuf,
    /// Run `systemctl daemon-reload` after (re)writing a unit. Production sets
    /// this true; tests set it false to stay systemd-free.
    pub reload_daemon: bool,
}

impl Default for FileUnitGenerator {
    fn default() -> Self {
        let unit_dir = std::env::var("PRIA_SYSTEMD_UNIT_DIR")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(SYSTEMD_UNIT_DIR));
        Self {
            unit_dir,
            reload_daemon: true,
        }
    }
}

impl FileUnitGenerator {
    fn unit_path(&self, key: &str) -> PathBuf {
        self.unit_dir.join(context_unit(key))
    }
}

#[async_trait]
impl UnitGenerator for FileUnitGenerator {
    async fn ensure(&self, spec: &DesktopUnitSpec) -> Result<String, String> {
        if !spec.is_instance_aware() {
            // Legacy single-desktop: the baked template owns the unit.
            return Ok(kasmvnc_unit(&spec.linux_username));
        }
        let path = self.unit_path(&spec.key);
        let contents = render_context_unit(spec);
        std::fs::create_dir_all(&self.unit_dir)
            .map_err(|e| format!("create unit dir {}: {e}", self.unit_dir.display()))?;
        // Only rewrite + daemon-reload when the unit content actually changed,
        // so a reuse/start of an already-running desktop is a cheap no-op.
        let changed = std::fs::read_to_string(&path)
            .map(|cur| cur != contents)
            .unwrap_or(true);
        if changed {
            std::fs::write(&path, contents.as_bytes())
                .map_err(|e| format!("write unit {}: {e}", path.display()))?;
            if self.reload_daemon {
                daemon_reload().await?;
            }
        }
        Ok(context_unit(&spec.key))
    }

    async fn remove(&self, spec: &DesktopUnitSpec) -> Result<(), String> {
        if !spec.is_instance_aware() {
            return Ok(());
        }
        let path = self.unit_path(&spec.key);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
            if self.reload_daemon {
                let _ = daemon_reload().await;
            }
        }
        Ok(())
    }
}

/// `systemctl daemon-reload` (Linux only; a no-op error elsewhere).
async fn daemon_reload() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let out = tokio::process::Command::new("systemctl")
            .arg("daemon-reload")
            .output()
            .await
            .map_err(|e| format!("spawn systemctl daemon-reload failed: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("systemctl daemon-reload failed: {stderr}"));
    }
    #[cfg(not(target_os = "linux"))]
    Ok(())
}

/// Context-specific KasmVNC password file: `~/.vnc/pria-<context_key>.passwd`
/// for an instance-aware desktop, or the default `~/.kasmpasswd` for legacy.
/// Keeps two concurrent desktops for the same Linux user from clobbering each
/// other's transport credential (spec §6.5).
pub fn context_passwd_file(home_dir: &Path, spec: &DesktopUnitSpec) -> PathBuf {
    if spec.is_instance_aware() {
        home_dir
            .join(".vnc")
            .join(format!("pria-{}.passwd", spec.key))
    } else {
        home_dir.join(".kasmpasswd")
    }
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
    /// Institution/digital-twin desktop identity (spec §4.2). Present for
    /// instance-aware desktops; `None` for legacy single-desktop sessions.
    pub instance_id: Option<String>,
    pub account_id: Option<String>,
    pub vm_id: Option<String>,
    pub workspace_dir: Option<String>,
    pub session_dir: Option<String>,
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
            .field("instance_id", &self.instance_id)
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
    /// Institution/digital-twin desktop identity (spec §4.2, §6.3). The control
    /// plane keys instance-aware reuse + stale-runtime reconciliation on this.
    /// Omitted from the wire for legacy single-desktop sessions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vm_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_dir: Option<String>,
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
            instance_id: self.instance_id.clone(),
            account_id: self.account_id.clone(),
            vm_id: self.vm_id.clone(),
            workspace_dir: self.workspace_dir.clone(),
            session_dir: self.session_dir.clone(),
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
    /// Applies the supplied VNC password to the desktop's password file on every
    /// start so a reused/already-running unit still honors a freshly-minted
    /// credential.
    password_applier: Arc<dyn PasswordApplier>,
    /// Materialises (or names) the per-context systemd unit so multiple
    /// institution desktops for one Linux user run as independent units.
    unit_generator: Arc<dyn UnitGenerator>,
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
            unit_generator: Arc::new(DefaultUnitNaming),
        }
    }

    /// Override the port-readiness probe (production wires a real TCP probe so
    /// `start()` only returns once KasmVNC is actually accepting connections).
    pub fn with_port_readiness(mut self, readiness: Arc<dyn PortReadiness>) -> Self {
        self.readiness = readiness;
        self
    }

    /// Override the password applier (production wires [`SetpwApplier`] so the
    /// control-plane-supplied password is written to the context password file
    /// even when the unit is already running and `systemctl start` no-ops).
    pub fn with_password_applier(mut self, applier: Arc<dyn PasswordApplier>) -> Self {
        self.password_applier = applier;
        self
    }

    /// Override the systemd unit generator (production wires [`FileUnitGenerator`]
    /// so instance-aware desktops get a concrete `pria-kasmvnc-<key>.service`
    /// with an explicit `User=`).
    pub fn with_unit_generator(mut self, generator: Arc<dyn UnitGenerator>) -> Self {
        self.unit_generator = generator;
        self
    }

    /// Start a KasmVNC session for `linux_username` in an institution context.
    ///
    /// Desktop identity is `(linux_username, instance_id)` (the [`desktop_key`]).
    /// Steps (spec §5.4, §2.3 Option A):
    /// 1. allocate display/port (persisted, keyed by context),
    /// 2. write the context env file,
    /// 3. ensure the per-context systemd unit, `systemctl start` it,
    /// 4. apply the password to the context password file,
    /// 5. record the session keyed by context.
    ///
    /// Idempotent per context: a second start for the same `(user, instance)`
    /// reuses the slot/unit. A start for the SAME user but a DIFFERENT instance
    /// allocates a SEPARATE display/port/unit so the two desktops coexist.
    pub async fn start(
        &self,
        session_id: String,
        linux_username: String,
        vnc_password: String,
        geometry: Option<String>,
        context: DesktopContext,
    ) -> Result<DesktopSession, String> {
        // Hold the async alloc_lock across await points to serialise concurrent starts.
        let _lock = self.alloc_lock.lock().await;

        let key = desktop_key(&linux_username, context.instance());

        // 1. allocate display/port keyed by CONTEXT (sync, persisted file)
        let alloc =
            crate::desktop::ports::allocate(&self.run_root, &key).map_err(|e| e.to_string())?;
        let crate::desktop::ports::Allocation { display, port } = alloc;
        let display_str = format!(":{display}");
        let geom = geometry.unwrap_or_else(|| DEFAULT_GEOMETRY.to_string());

        // 2. write env file (password goes into the file; never into logs),
        //    keyed by context so concurrent desktops don't share an env file.
        let env = KasmEnv {
            display: display_str.clone(),
            ws_port: port,
            geometry: geom.clone(),
            vnc_password: vnc_password.clone(),
        };
        write_env_file(&self.run_root, &key, &env)
            .map_err(|e| format!("failed to write kasmvnc env file: {e}"))?;

        // 3. ensure + start the per-context systemd unit. For legacy (no
        //    instance) this resolves to the baked `kasmvnc@<user>.service`
        //    template; instance-aware desktops get a generated
        //    `pria-kasmvnc-<key>.service` pinned to `User=<user>`.
        let spec = DesktopUnitSpec {
            key: key.clone(),
            linux_username: linux_username.clone(),
            instance_id: context.instance().map(str::to_string),
            env_file: env_file_path(&self.run_root, &key),
        };
        let unit = self
            .unit_generator
            .ensure(&spec)
            .await
            .map_err(|e| format!("failed to ensure desktop unit: {e}"))?;
        self.systemctl
            .start(&unit)
            .await
            .map_err(|e| format!("systemctl start {unit} failed: {e}"))?;

        // 3a. Apply the password unconditionally (see PasswordApplier docs).
        // `systemctl start` is a no-op when the unit is already active, so the
        // unit's own ExecStartPre would NOT re-run — applying directly here keeps
        // a freshly-minted credential honored without disrupting the X session.
        if let Err(e) = self
            .password_applier
            .apply(&linux_username, &vnc_password)
            .await
        {
            tracing::warn!(
                unit = %unit,
                error = %e,
                "failed to apply kasmvnc password; Basic auth may 401 until next unit restart"
            );
        }

        // 3b. wait for KasmVNC to actually bind its websocket port.
        if !self.readiness.wait(port).await {
            tracing::warn!(
                unit = %unit,
                port,
                "kasmvnc port did not become ready within timeout; reporting started anyway"
            );
        }

        // 4. record (keyed by context)
        let ds = DesktopSession {
            session_id,
            linux_username: linux_username.clone(),
            display: display_str,
            port,
            basic_user: KASM_BASIC_USER.to_string(),
            vnc_password,
            geometry: geom,
            started_at: chrono::Utc::now().to_rfc3339(),
            instance_id: context.instance().map(str::to_string),
            account_id: context.account_id.clone(),
            vm_id: context.vm_id.clone(),
            workspace_dir: context.workspace_dir.clone(),
            session_dir: context.session_dir.clone(),
        };
        self.sessions
            .lock()
            .unwrap()
            .insert(key.clone(), ds.clone());

        // Persist non-secret session metadata (keyed by context) so the session
        // table can be faithfully rebuilt after a guest-agent restart. The VNC
        // password is NOT written here — it stays in the 0600 env file.
        if let Err(e) = write_session_meta(
            &self.run_root,
            &key,
            &SessionMeta {
                session_id: ds.session_id.clone(),
                started_at: ds.started_at.clone(),
                linux_username: linux_username.clone(),
                instance_id: ds.instance_id.clone(),
                account_id: ds.account_id.clone(),
                vm_id: ds.vm_id.clone(),
                workspace_dir: ds.workspace_dir.clone(),
                session_dir: ds.session_dir.clone(),
            },
        ) {
            tracing::warn!(
                key = %key,
                error = %e,
                "failed to persist desktop session metadata; rehydrate will synthesize a session id"
            );
        }
        Ok(ds)
    }

    /// Stop the KasmVNC session for `(linux_username, instance_id)`.
    ///
    /// When `instance_id` is supplied only THAT institution's desktop is stopped
    /// — the user's other institution desktops on the shared Account VM are left
    /// running. When absent, the legacy single-desktop key (`linux_username`) is
    /// stopped (backward compatible).
    ///
    /// Steps (spec §5.4 step 6, §7.3):
    /// 1. `systemctl stop <unit>`,
    /// 2. best-effort remove a generated context unit,
    /// 3. release port allocation,
    /// 4. remove env/meta sidecars + session-table entry.
    pub async fn stop(
        &self,
        linux_username: &str,
        instance_id: Option<&str>,
    ) -> Result<(), String> {
        let key = desktop_key(linux_username, instance_id);
        let spec = DesktopUnitSpec {
            key: key.clone(),
            linux_username: linux_username.to_string(),
            instance_id: instance_id
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            env_file: env_file_path(&self.run_root, &key),
        };
        // Resolve the same unit name the start path used.
        let unit = self.unit_generator.ensure(&spec).await.unwrap_or_else(|_| {
            if spec.is_instance_aware() {
                context_unit(&key)
            } else {
                kasmvnc_unit(linux_username)
            }
        });
        self.systemctl
            .stop(&unit)
            .await
            .map_err(|e| format!("systemctl stop {unit} failed: {e}"))?;
        // Best-effort teardown of a generated unit so /etc doesn't accumulate
        // stale context units.
        let _ = self.unit_generator.remove(&spec).await;

        let _lock = self.alloc_lock.lock().await;
        crate::desktop::ports::release(&self.run_root, &key).map_err(|e| e.to_string())?;
        remove_session_meta(&self.run_root, &key);
        self.sessions.lock().unwrap().remove(&key);
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
        for (key, alloc) in allocations {
            // Don't clobber a session already recorded this process lifetime.
            if self.sessions.lock().unwrap().contains_key(&key) {
                continue;
            }
            // The metadata sidecar (keyed by context) carries the real
            // linux_username + instance context. For pre-instance-aware
            // allocations the sidecar lacks linux_username, so fall back to the
            // key (which == username for legacy single-desktop allocations).
            let meta = read_session_meta(&self.run_root, &key);
            let linux_username = meta
                .as_ref()
                .map(|m| m.linux_username.clone())
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| key.clone());
            let instance_id = meta.as_ref().and_then(|m| m.instance_id.clone());
            let instance_aware = instance_id
                .as_deref()
                .map(str::trim)
                .is_some_and(|s| !s.is_empty());
            let unit = if instance_aware {
                context_unit(&key)
            } else {
                kasmvnc_unit(&linux_username)
            };
            let active = matches!(self.systemctl.status(&unit).await, Ok(UnitStatus::Active));
            if !active {
                // The desktop is gone; free the stale allocation + metadata so
                // the display/port slot can be reused.
                let _ = crate::desktop::ports::release(&self.run_root, &key);
                remove_session_meta(&self.run_root, &key);
                continue;
            }
            let Some(env) = read_env_file(&self.run_root, &key) else {
                tracing::warn!(
                    key = %key,
                    "kasmvnc unit active but env file missing/unparseable; cannot rehydrate session"
                );
                continue;
            };
            // Recover the original session id when the sidecar is present;
            // otherwise synthesize a stable rehydrated id so the desktop is
            // still reusable by context key.
            let session_id = meta
                .as_ref()
                .map(|m| m.session_id.clone())
                .unwrap_or_else(|| format!("rehydrated:{key}"));
            let started_at = meta
                .as_ref()
                .map(|m| m.started_at.clone())
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
            let ds = DesktopSession {
                session_id,
                linux_username,
                display: format!(":{}", alloc.display),
                port: env.ws_port,
                basic_user: KASM_BASIC_USER.to_string(),
                vnc_password: env.vnc_password,
                geometry: env.geometry,
                started_at,
                instance_id,
                account_id: meta.as_ref().and_then(|m| m.account_id.clone()),
                vm_id: meta.as_ref().and_then(|m| m.vm_id.clone()),
                workspace_dir: meta.as_ref().and_then(|m| m.workspace_dir.clone()),
                session_dir: meta.and_then(|m| m.session_dir.clone()),
            };
            self.sessions.lock().unwrap().insert(key.clone(), ds);
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

    /// Look up a single session by `(linux_username, instance_id)` context.
    pub fn get(&self, linux_username: &str, instance_id: Option<&str>) -> Option<DesktopSession> {
        let key = desktop_key(linux_username, instance_id);
        self.sessions.lock().unwrap().get(&key).cloned()
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
            instance_id: None,
            account_id: None,
            vm_id: None,
            workspace_dir: None,
            session_dir: None,
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
                Default::default(),
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
            .start(
                "sess_a".into(),
                "pria_u_a".into(),
                "pw_a".into(),
                None,
                Default::default(),
            )
            .await
            .unwrap();
        let b = store
            .start(
                "sess_b".into(),
                "pria_u_b".into(),
                "pw_b".into(),
                None,
                Default::default(),
            )
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
            .start(
                "sess_a".into(),
                "pria_u_a".into(),
                "pw".into(),
                None,
                Default::default(),
            )
            .await
            .unwrap();
        store.stop("pria_u_a", None).await.unwrap();

        assert!(store.get("pria_u_a", None).is_none());
        let stopped = fake_ctl.stopped.lock().unwrap();
        assert!(stopped.contains(&"kasmvnc@pria_u_a.service".to_string()));

        // Port should be released and reusable.
        let c = store
            .start(
                "sess_c".into(),
                "pria_u_c".into(),
                "pw_c".into(),
                None,
                Default::default(),
            )
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
            .start(
                "sess_x".into(),
                "pria_u_x".into(),
                "pw".into(),
                None,
                Default::default(),
            )
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
            .start(
                "s1".into(),
                "ua".into(),
                "pw1".into(),
                None,
                Default::default(),
            )
            .await
            .unwrap();
        store
            .start(
                "s2".into(),
                "ub".into(),
                "pw2".into(),
                None,
                Default::default(),
            )
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
            instance_id: None,
            account_id: None,
            vm_id: None,
            workspace_dir: None,
            session_dir: None,
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
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let probe = TcpPortReadiness::new(std::time::Duration::from_secs(2));
        assert!(probe.wait(port).await, "probe must detect a bound port");
    }

    #[tokio::test]
    async fn tcp_probe_times_out_on_closed_port() {
        // Reserve then drop a port so nothing is listening; the probe must give
        // up at its deadline rather than hang.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let probe = TcpPortReadiness::new(std::time::Duration::from_millis(400));
        assert!(
            !probe.wait(port).await,
            "probe must time out on a closed port"
        );
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
            .start(
                "sess_r".into(),
                "pria_u_r".into(),
                "pw".into(),
                None,
                Default::default(),
            )
            .await
            .unwrap();
        let seen = probe.seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "readiness probe must run exactly once");
        assert_eq!(
            seen[0], ds.port,
            "probe must check the allocated KasmVNC port"
        );
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
            .start(
                "sess_1".into(),
                "pria_u_x".into(),
                "pw_first".into(),
                None,
                Default::default(),
            )
            .await
            .unwrap();
        // Second start for the SAME user = the reuse / already-running case.
        store
            .start(
                "sess_2".into(),
                "pria_u_x".into(),
                "pw_second".into(),
                None,
                Default::default(),
            )
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
            .start(
                "sess_fo".into(),
                "pria_u_fo".into(),
                "pw".into(),
                None,
                Default::default(),
            )
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
                .start(
                    "sess_orig".into(),
                    "pria_u_a".into(),
                    "pw_a".into(),
                    Some("1280x800".into()),
                    Default::default(),
                )
                .await
                .unwrap();
        }
        // Simulate restart: brand-new store over the SAME run_root. Its session
        // table starts empty, but the unit is still Active in the shared fake.
        let store2 = DesktopStore::new(root.clone(), ctl.clone());
        assert!(
            store2.list().is_empty(),
            "fresh store starts with no sessions"
        );
        let restored = store2.rehydrate().await;
        assert_eq!(restored, 1, "the active desktop must be rehydrated");
        let s = store2
            .get("pria_u_a", None)
            .expect("session present after rehydrate");
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
                .start(
                    "sess_dead".into(),
                    "pria_u_dead".into(),
                    "pw".into(),
                    None,
                    Default::default(),
                )
                .await
                .unwrap();
        }
        // Desktop died across the restart.
        ctl.set_status(&kasmvnc_unit("pria_u_dead"), UnitStatus::Inactive);
        let store2 = DesktopStore::new(root.clone(), ctl.clone());
        let restored = store2.rehydrate().await;
        assert_eq!(restored, 0, "an inactive unit must not be rehydrated");
        assert!(store2.get("pria_u_dead", None).is_none());
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
            .start(
                "sess_live".into(),
                "pria_u_a".into(),
                "pw_live".into(),
                None,
                Default::default(),
            )
            .await
            .unwrap();
        // Rehydrate must not duplicate or overwrite the live session.
        assert_eq!(
            store.rehydrate().await,
            0,
            "live session is not re-restored"
        );
        let s = store.get("pria_u_a", None).unwrap();
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
                .start(
                    "sess_orig".into(),
                    "pria_u_a".into(),
                    "pw_a".into(),
                    None,
                    Default::default(),
                )
                .await
                .unwrap();
        }
        // Remove the sidecar to emulate a pre-feature desktop.
        remove_session_meta(&root, "pria_u_a");
        let store2 = DesktopStore::new(root.clone(), ctl.clone());
        assert_eq!(store2.rehydrate().await, 1);
        let s = store2.get("pria_u_a", None).unwrap();
        assert_eq!(s.session_id, "rehydrated:pria_u_a");
        assert_eq!(
            s.vnc_password, "pw_a",
            "password still recovered from env file"
        );
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

    // ── instance-aware desktop identity (spec §4.2, §6.x) ──────────────────────

    fn ctx(instance: &str) -> DesktopContext {
        DesktopContext {
            instance_id: Some(instance.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn desktop_key_combines_user_and_instance() {
        assert_eq!(
            desktop_key("alice_acme", Some("inst1")),
            "alice_acme__inst1"
        );
        // Legacy (no instance) keys by user alone.
        assert_eq!(desktop_key("alice_acme", None), "alice_acme");
        assert_eq!(desktop_key("alice_acme", Some("")), "alice_acme");
        assert_eq!(desktop_key("alice_acme", Some("   ")), "alice_acme");
    }

    #[test]
    fn desktop_key_sanitizes_unsafe_components() {
        // Path/unit-name injection chars are neutralised to '_'.
        let k = desktop_key("alice_acme", Some("../../etc/x"));
        assert!(
            !k.contains('/'),
            "key must not contain path separators: {k}"
        );
        assert_eq!(k, "alice_acme__.._.._etc_x");
    }

    #[tokio::test]
    async fn two_instances_same_user_get_distinct_desktops_and_ports() {
        // The CORE multi-institution invariant: one Linux user, two institutions
        // → two independent desktops with distinct display/port, both live.
        let root = tmp_run_root();
        let store = make_store(root);

        let a = store
            .start(
                "sess_a".into(),
                "alice_acme".into(),
                "pw_a".into(),
                None,
                ctx("inst1"),
            )
            .await
            .unwrap();
        let b = store
            .start(
                "sess_b".into(),
                "alice_acme".into(),
                "pw_b".into(),
                None,
                ctx("inst2"),
            )
            .await
            .unwrap();

        assert_eq!(a.instance_id.as_deref(), Some("inst1"));
        assert_eq!(b.instance_id.as_deref(), Some("inst2"));
        assert_ne!(a.port, b.port, "each institution desktop gets its own port");
        assert_ne!(a.display, b.display);
        // Both coexist in the registry.
        assert_eq!(store.list().len(), 2);
        assert!(store.get("alice_acme", Some("inst1")).is_some());
        assert!(store.get("alice_acme", Some("inst2")).is_some());
    }

    #[tokio::test]
    async fn list_returns_both_instances_with_distinct_instance_ids() {
        let root = tmp_run_root();
        let store = make_store(root);
        store
            .start(
                "s1".into(),
                "alice_acme".into(),
                "p1".into(),
                None,
                ctx("i1"),
            )
            .await
            .unwrap();
        store
            .start(
                "s2".into(),
                "alice_acme".into(),
                "p2".into(),
                None,
                ctx("i2"),
            )
            .await
            .unwrap();

        let infos: Vec<_> = store.list().into_iter().map(|d| d.to_info()).collect();
        let instances: std::collections::HashSet<Option<String>> =
            infos.iter().map(|i| i.instance_id.clone()).collect();
        assert!(instances.contains(&Some("i1".to_string())));
        assert!(instances.contains(&Some("i2".to_string())));
        let ports: std::collections::HashSet<u16> = infos.iter().map(|i| i.port).collect();
        assert_eq!(ports.len(), 2, "two distinct ports listed");
    }

    #[tokio::test]
    async fn stop_with_instance_id_stops_only_that_institution_desktop() {
        let root = tmp_run_root();
        let fake_ctl = Arc::new(fake::FakeSystemctl::default());
        let store = DesktopStore::new(root.clone(), fake_ctl.clone());

        store
            .start(
                "s1".into(),
                "alice_acme".into(),
                "p1".into(),
                None,
                ctx("i1"),
            )
            .await
            .unwrap();
        store
            .start(
                "s2".into(),
                "alice_acme".into(),
                "p2".into(),
                None,
                ctx("i2"),
            )
            .await
            .unwrap();

        // Stop ONLY institution i1.
        store.stop("alice_acme", Some("i1")).await.unwrap();

        assert!(
            store.get("alice_acme", Some("i1")).is_none(),
            "i1 desktop stopped"
        );
        assert!(
            store.get("alice_acme", Some("i2")).is_some(),
            "i2 desktop still live"
        );
        assert_eq!(store.list().len(), 1);
        // The stopped unit is the i1 context unit, not i2's.
        let stopped = fake_ctl.stopped.lock().unwrap();
        assert!(stopped.contains(&context_unit("alice_acme__i1")));
        assert!(!stopped.contains(&context_unit("alice_acme__i2")));
    }

    #[tokio::test]
    async fn instance_aware_start_uses_generated_context_unit() {
        // Instance-aware desktops must start a concrete pria-kasmvnc-<key> unit,
        // NOT the legacy kasmvnc@<user> template (whose User=%i would break).
        let root = tmp_run_root();
        let fake_ctl = Arc::new(fake::FakeSystemctl::default());
        let store = DesktopStore::new(root.clone(), fake_ctl.clone());
        store
            .start(
                "s1".into(),
                "alice_acme".into(),
                "p1".into(),
                None,
                ctx("i1"),
            )
            .await
            .unwrap();
        let started = fake_ctl.started.lock().unwrap();
        assert_eq!(started.as_slice(), &[context_unit("alice_acme__i1")]);
    }

    #[tokio::test]
    async fn legacy_no_instance_still_uses_template_unit() {
        // Backward compatibility: no instance_id → the baked template unit.
        let root = tmp_run_root();
        let fake_ctl = Arc::new(fake::FakeSystemctl::default());
        let store = DesktopStore::new(root.clone(), fake_ctl.clone());
        store
            .start(
                "s1".into(),
                "alice_acme".into(),
                "p1".into(),
                None,
                Default::default(),
            )
            .await
            .unwrap();
        let started = fake_ctl.started.lock().unwrap();
        assert_eq!(started.as_slice(), &[kasmvnc_unit("alice_acme")]);
    }

    #[tokio::test]
    async fn rehydrate_recovers_instance_context_from_sidecar() {
        let root = tmp_run_root();
        let ctl = Arc::new(fake::FakeSystemctl::default());
        {
            let store = DesktopStore::new(root.clone(), ctl.clone());
            store
                .start(
                    "sess_i".into(),
                    "alice_acme".into(),
                    "pw".into(),
                    None,
                    ctx("inst42"),
                )
                .await
                .unwrap();
        }
        // Restart: fresh store over the same run_root.
        let store2 = DesktopStore::new(root.clone(), ctl.clone());
        assert_eq!(store2.rehydrate().await, 1);
        let s = store2
            .get("alice_acme", Some("inst42"))
            .expect("instance desktop rehydrated under its context key");
        assert_eq!(s.session_id, "sess_i");
        assert_eq!(s.instance_id.as_deref(), Some("inst42"));
        assert_eq!(s.linux_username, "alice_acme");
    }

    #[test]
    fn render_context_unit_pins_user_and_env_file() {
        let spec = DesktopUnitSpec {
            key: "alice_acme__i1".into(),
            linux_username: "alice_acme".into(),
            instance_id: Some("i1".into()),
            env_file: PathBuf::from("/run/pria/kasmvnc/alice_acme__i1.env"),
        };
        let unit = render_context_unit(&spec);
        assert!(
            unit.contains("User=alice_acme"),
            "must pin the real Linux user"
        );
        assert!(unit.contains("EnvironmentFile=/run/pria/kasmvnc/alice_acme__i1.env"));
        assert!(unit.contains("ExecStartPre=+/usr/local/sbin/pria-kasm-setpw alice_acme"));
        // No literal %i template token — this is a concrete unit.
        assert!(!unit.contains("%i"));
    }

    #[tokio::test]
    async fn file_unit_generator_writes_concrete_unit_for_instance() {
        let dir = tmp_run_root().join("systemd");
        let gen = FileUnitGenerator {
            unit_dir: dir.clone(),
            reload_daemon: false,
        };
        let spec = DesktopUnitSpec {
            key: "alice_acme__i1".into(),
            linux_username: "alice_acme".into(),
            instance_id: Some("i1".into()),
            env_file: PathBuf::from("/run/pria/kasmvnc/alice_acme__i1.env"),
        };
        let unit = gen.ensure(&spec).await.unwrap();
        assert_eq!(unit, "pria-kasmvnc-alice_acme__i1.service");
        let written = std::fs::read_to_string(dir.join(&unit)).expect("unit file written");
        assert!(written.contains("User=alice_acme"));
        // remove() tears the file down.
        gen.remove(&spec).await.unwrap();
        assert!(!dir.join(&unit).exists());
    }

    #[tokio::test]
    async fn file_unit_generator_legacy_writes_nothing() {
        let dir = tmp_run_root().join("systemd");
        let gen = FileUnitGenerator {
            unit_dir: dir.clone(),
            reload_daemon: false,
        };
        let spec = DesktopUnitSpec {
            key: "alice_acme".into(),
            linux_username: "alice_acme".into(),
            instance_id: None,
            env_file: PathBuf::from("/run/pria/kasmvnc/alice_acme.env"),
        };
        let unit = gen.ensure(&spec).await.unwrap();
        assert_eq!(unit, kasmvnc_unit("alice_acme"));
        // No generated unit file for the legacy template path.
        assert!(
            !dir.exists()
                || std::fs::read_dir(&dir)
                    .map(|mut d| d.next().is_none())
                    .unwrap_or(true)
        );
    }

    #[test]
    fn context_passwd_file_is_per_context_for_instances() {
        let home = PathBuf::from("/home/alice_acme");
        let inst_spec = DesktopUnitSpec {
            key: "alice_acme__i1".into(),
            linux_username: "alice_acme".into(),
            instance_id: Some("i1".into()),
            env_file: PathBuf::new(),
        };
        let p = context_passwd_file(&home, &inst_spec);
        assert_eq!(
            p,
            PathBuf::from("/home/alice_acme/.vnc/pria-alice_acme__i1.passwd")
        );
        // Legacy shares the default ~/.kasmpasswd.
        let legacy_spec = DesktopUnitSpec {
            key: "alice_acme".into(),
            linux_username: "alice_acme".into(),
            instance_id: None,
            env_file: PathBuf::new(),
        };
        assert_eq!(
            context_passwd_file(&home, &legacy_spec),
            PathBuf::from("/home/alice_acme/.kasmpasswd")
        );
    }
}
