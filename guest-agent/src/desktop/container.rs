//! Container-native KasmVNC lifecycle backends for AWS ECS/Fargate
//! (bridge design tasks T2/T3).
//!
//! A Fargate task has no systemd, so the systemd-shaped seams from
//! [`super::kasmvnc`] are reimplemented in-process:
//!
//! * [`ContainerUnitGenerator`] — names units identically to the systemd path
//!   but writes NO unit files (there is no `/etc/systemd/system` to populate).
//! * [`ContainerSystemctl`] — an in-process child supervisor that interprets
//!   the same unit names as stable handles and runs `vncserver` directly.
//!
//! `DesktopStore` still allocates ports and writes context env files exactly as
//! on VMs, so local-virsh behavior stays byte-identical.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use super::kasmvnc::{
    context_unit, kasmvnc_unit, read_env_file, read_session_meta, DesktopUnitSpec, KasmEnv,
    SystemctlBackend, SystemctlError, UnitGenerator, UnitStatus,
};

const CONTEXT_PREFIX: &str = "pria-kasmvnc-";
const LEGACY_PREFIX: &str = "kasmvnc@";
const UNIT_SUFFIX: &str = ".service";

// ── unit "generation" (T2) ────────────────────────────────────────────────────

/// Container-mode [`UnitGenerator`]: resolves the SAME unit names as the
/// systemd path — `pria-kasmvnc-<key>.service` for instance-aware desktops,
/// `kasmvnc@<user>.service` for legacy — so `DesktopStore::rehydrate` and every
/// persisted session sidecar remain bit-identical across substrates, but it
/// writes NO files (there is no systemd to consume them; the name is purely a
/// handle for [`ContainerSystemctl`]). `remove` is a no-op for the same reason.
pub struct ContainerUnitGenerator;

#[async_trait]
impl UnitGenerator for ContainerUnitGenerator {
    async fn ensure(&self, spec: &DesktopUnitSpec) -> Result<String, String> {
        Ok(if spec.is_instance_aware() {
            context_unit(&spec.key)
        } else {
            kasmvnc_unit(&spec.linux_username)
        })
    }

    async fn remove(&self, _spec: &DesktopUnitSpec) -> Result<(), String> {
        // Nothing was materialized on disk; the in-process supervisor owns the
        // child lifecycle via SystemctlBackend::stop.
        Ok(())
    }
}

// ── in-process desktop supervisor (T3) ────────────────────────────────────────

/// A supervised desktop child process.
struct DesktopChild {
    child: tokio::process::Child,
    /// OS pid, retained for process-group signaling even after `child` is
    /// mutably borrowed by wait futures.
    pid: u32,
}

/// In-process desktop supervisor implementing [`SystemctlBackend`] for
/// container substrates (no systemd, no `CAP_SYS_ADMIN`).
///
/// The unit name produced by [`ContainerUnitGenerator`] is parsed back into the
/// env-file key, the env file written by `DesktopStore` supplies
/// display/port/geometry/password, the setpw helper materializes the Kasm
/// credential, and `vncserver` is spawned directly (via `runuser` when running
/// as root) in its own session/process group.
///
/// No auto-restart policy in v1: ECS-level task health (the guest
/// `/guest/v1/health` container health check) plus control-plane restart is the
/// supervisor of record; keeping this backend restart-free keeps failure
/// reporting honest (`status` → `Failed`) and the code simple.
pub struct ContainerSystemctl {
    children: Arc<Mutex<HashMap<String, DesktopChild>>>,
    run_root: PathBuf,
    /// Password helper (default `/usr/local/sbin/pria-kasm-setpw`); overridable
    /// for tests via [`Self::with_bins`].
    setpw_bin: PathBuf,
    /// Desktop server binary (default `/usr/bin/vncserver`); overridable for
    /// tests via [`Self::with_bins`].
    vncserver_bin: PathBuf,
    /// Wrap the desktop spawn in `runuser -u <user> --` so it runs as the
    /// reconciled Linux user. Defaults to `euid == 0` (production containers
    /// run the agent as root; unprivileged test runs exec directly).
    use_runuser: bool,
    /// Test hook: when set, REPLACES the desktop argv entirely so process
    /// lifecycle tests can drive e.g. `/bin/sleep 30` without a real KasmVNC.
    test_argv_override: Option<Vec<String>>,
}

impl ContainerSystemctl {
    pub fn new(run_root: PathBuf) -> Self {
        #[cfg(unix)]
        // SAFETY: geteuid has no failure modes or side effects.
        let is_root = unsafe { libc::geteuid() } == 0;
        #[cfg(not(unix))]
        let is_root = false;
        Self {
            children: Arc::new(Mutex::new(HashMap::new())),
            run_root,
            setpw_bin: PathBuf::from("/usr/local/sbin/pria-kasm-setpw"),
            vncserver_bin: PathBuf::from("/usr/bin/vncserver"),
            use_runuser: is_root,
            test_argv_override: None,
        }
    }

    /// Override helper/server binaries (tests point these at `/bin/true` and a
    /// long-running stand-in). Also disables `runuser` wrapping so the child is
    /// spawned directly under the test uid.
    pub fn with_bins(mut self, setpw: impl Into<PathBuf>, vncserver: impl Into<PathBuf>) -> Self {
        self.setpw_bin = setpw.into();
        self.vncserver_bin = vncserver.into();
        self.use_runuser = false;
        self
    }

    /// Test hook: replace the desktop argv wholesale (e.g. `["30"]` with
    /// `vncserver_bin = /bin/sleep`).
    #[cfg(test)]
    pub fn with_test_argv(mut self, argv: Vec<String>) -> Self {
        self.test_argv_override = Some(argv);
        self
    }

    /// Parse a unit handle back into `(env_file_key, is_context_form)`.
    ///
    /// * `pria-kasmvnc-<key>.service` → (`<key>`, true)
    /// * `kasmvnc@<user>.service` → (`<user>`, false)
    fn unit_key(unit: &str) -> Result<(String, bool), SystemctlError> {
        if let Some(key) = unit
            .strip_prefix(CONTEXT_PREFIX)
            .and_then(|s| s.strip_suffix(UNIT_SUFFIX))
        {
            if !key.is_empty() {
                return Ok((key.to_string(), true));
            }
        }
        if let Some(user) = unit
            .strip_prefix(LEGACY_PREFIX)
            .and_then(|s| s.strip_suffix(UNIT_SUFFIX))
        {
            if !user.is_empty() {
                return Ok((user.to_string(), false));
            }
        }
        Err(SystemctlError(format!(
            "invalid desktop unit handle: {unit}"
        )))
    }

    /// Resolve the Linux username for a context-form key.
    ///
    /// The key format is `<sanitized_user>__<sanitized_instance>`
    /// ([`super::kasmvnc::desktop_key`]), but splitting on `__` is ambiguous
    /// when the sanitized username itself contains `__`. The authoritative
    /// source is the [`super::kasmvnc::SessionMeta`] sidecar persisted next to
    /// the env file; we fall back to the portion before the FIRST `__` only
    /// when the sidecar is missing/incomplete (best-effort recovery — accepted
    /// because sanitized usernames containing `__` do not occur with the
    /// current `pria_u_<id>` naming scheme).
    fn resolve_user(run_root: &Path, key: &str, is_context: bool) -> String {
        if !is_context {
            // Legacy form: the unit IS the username.
            return key.to_string();
        }
        if let Some(meta) = read_session_meta(run_root, key) {
            if !meta.linux_username.trim().is_empty() {
                return meta.linux_username;
            }
        }
        key.split_once("__").map(|(u, _)| u).unwrap_or(key).into()
    }

    /// The argv passed to the desktop server binary (pure; unit-tested).
    fn desktop_argv(env: &KasmEnv) -> Vec<String> {
        vec![
            env.display.clone(),
            "-fg".into(),
            "-geometry".into(),
            env.geometry.clone(),
            "-websocketPort".into(),
            env.ws_port.to_string(),
            "-interface".into(),
            "0.0.0.0".into(),
        ]
    }

    /// Inspect a tracked child: `None` if untracked, `Active` while running,
    /// otherwise remove it and map the exit status. Exit reaping happens here
    /// so `status` transitions Active → Inactive/Failed without a supervisor
    /// loop.
    fn probe(&self, unit: &str) -> Result<Option<UnitStatus>, SystemctlError> {
        let mut children = self.children.lock().unwrap();
        let Some(entry) = children.get_mut(unit) else {
            return Ok(None);
        };
        match entry.child.try_wait() {
            Ok(None) => Ok(Some(UnitStatus::Active)),
            Ok(Some(status)) => {
                children.remove(unit);
                Ok(Some(if status.success() {
                    UnitStatus::Inactive
                } else {
                    UnitStatus::Failed
                }))
            }
            Err(e) => Err(SystemctlError(format!("inspect {unit}: {e}"))),
        }
    }
}

/// Signal an entire process group (the child called `setsid`, so its pid is
/// the pgid). Best-effort: ESRCH after exit is fine.
#[cfg(unix)]
fn kill_group(pid: u32, signal: libc::c_int) {
    // SAFETY: plain kill(2) on a pgid we created; no memory safety concerns.
    unsafe {
        libc::kill(-(pid as libc::pid_t), signal);
    }
}

#[async_trait]
impl SystemctlBackend for ContainerSystemctl {
    async fn start(&self, unit: &str) -> Result<(), SystemctlError> {
        // Idempotent start: a live child under this handle is success.
        if matches!(self.probe(unit)?, Some(UnitStatus::Active)) {
            return Ok(());
        }
        let (key, is_context) = Self::unit_key(unit)?;
        let user = Self::resolve_user(&self.run_root, &key, is_context);
        let env = read_env_file(&self.run_root, &key)
            .ok_or_else(|| SystemctlError(format!("missing desktop env file for {key}")))?;

        // Container mode has no systemd ExecStartPre, so run the password
        // helper synchronously before the server can accept traffic. The
        // password travels via the environment only — never argv, never logs.
        // Run it AS THE DESKTOP USER (mirroring systemd, where ExecStartPre
        // executes as the unit's User=): the helper materializes ~/.vnc and the
        // passwd file, and a root-run helper under the hardened umask would
        // leave ~/.vnc root-owned 0700 — the user's vncserver then cannot write
        // its pid/log files there.
        let setpw_status = {
            let mut cmd = if self.use_runuser {
                let mut c = tokio::process::Command::new("runuser");
                c.arg("-u").arg(&user).arg("--").arg(&self.setpw_bin);
                c
            } else {
                tokio::process::Command::new(&self.setpw_bin)
            };
            cmd.arg(&user);
            if is_context {
                cmd.arg(&key);
            }
            cmd.env("KASM_VNC_PASSWORD", &env.vnc_password)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .await
                .map_err(|e| {
                    SystemctlError(format!(
                        "spawn password helper {} for {unit}: {e}",
                        self.setpw_bin.display()
                    ))
                })?
        };
        if !setpw_status.success() {
            return Err(SystemctlError(format!(
                "password helper failed for {unit} ({setpw_status})"
            )));
        }

        // Desktop argv (test hook may replace it wholesale).
        let argv = self
            .test_argv_override
            .clone()
            .unwrap_or_else(|| Self::desktop_argv(&env));

        // As root, wrap in `runuser -u <user> --` so the desktop runs as the
        // reconciled Linux user; unprivileged (tests) exec the binary directly.
        let mut cmd = if self.use_runuser {
            let mut c = tokio::process::Command::new("runuser");
            c.arg("-u").arg(&user).arg("--").arg(&self.vncserver_bin);
            c.args(&argv);
            c
        } else {
            let mut c = tokio::process::Command::new(&self.vncserver_bin);
            c.args(&argv);
            c
        };
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            // The desktop must outlive any request-handler drop; stop() owns
            // termination explicitly.
            .kill_on_drop(false);
        #[cfg(unix)]
        {
            // SAFETY: setsid in the pre-exec child is async-signal-safe; it
            // gives the desktop its own session + process group so stop() can
            // signal the whole tree.
            unsafe {
                cmd.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }
        let child = cmd
            .spawn()
            .map_err(|e| SystemctlError(format!("start {unit}: {e}")))?;
        let pid = child
            .id()
            .ok_or_else(|| SystemctlError(format!("start {unit}: child exited before tracking")))?;
        self.children
            .lock()
            .unwrap()
            .insert(unit.to_string(), DesktopChild { child, pid });
        Ok(())
    }

    async fn stop(&self, unit: &str) -> Result<(), SystemctlError> {
        // Idempotent: no tracked child → Ok.
        let Some(mut entry) = self.children.lock().unwrap().remove(unit) else {
            return Ok(());
        };
        #[cfg(unix)]
        {
            kill_group(entry.pid, libc::SIGTERM);
            match tokio::time::timeout(std::time::Duration::from_secs(5), entry.child.wait()).await
            {
                Ok(_) => return Ok(()),
                Err(_elapsed) => {
                    kill_group(entry.pid, libc::SIGKILL);
                    let _ = entry.child.wait().await;
                }
            }
        }
        #[cfg(not(unix))]
        {
            let _ = entry.child.start_kill();
            let _ = entry.child.wait().await;
        }
        Ok(())
    }

    async fn status(&self, unit: &str) -> Result<UnitStatus, SystemctlError> {
        Ok(self.probe(unit)?.unwrap_or(UnitStatus::Inactive))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::kasmvnc::{write_env_file, write_session_meta, SessionMeta};

    fn temp_run_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ga-container-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn env(display: &str, port: u16) -> KasmEnv {
        KasmEnv {
            display: display.into(),
            ws_port: port,
            geometry: "1280x800".into(),
            vnc_password: "s3cret".into(),
        }
    }

    fn spec(user: &str, instance: Option<&str>) -> DesktopUnitSpec {
        let key = crate::desktop::kasmvnc::desktop_key(user, instance);
        DesktopUnitSpec {
            key: key.clone(),
            linux_username: user.into(),
            instance_id: instance.map(String::from),
            env_file: PathBuf::from(format!("/run/pria/kasmvnc/{key}.env")),
        }
    }

    fn count_entries(dir: &Path) -> usize {
        std::fs::read_dir(dir).map(|d| d.count()).unwrap_or(0)
    }

    // ── T2: ContainerUnitGenerator ───────────────────────────────────────────

    #[tokio::test]
    async fn container_generator_names_context_unit_without_writing_files() {
        let s = spec("pria_u_1", Some("inst_2"));
        let unit = ContainerUnitGenerator.ensure(&s).await.unwrap();
        // Identical to the systemd path so rehydrate stays bit-identical.
        assert_eq!(unit, context_unit(&s.key));
        assert_eq!(unit, "pria-kasmvnc-pria_u_1__inst_2.service");
        ContainerUnitGenerator.remove(&s).await.unwrap();
    }

    #[tokio::test]
    async fn container_generator_names_legacy_template_unit() {
        let s = spec("pria_u_1", None);
        let unit = ContainerUnitGenerator.ensure(&s).await.unwrap();
        assert_eq!(unit, kasmvnc_unit("pria_u_1"));
        assert_eq!(unit, "kasmvnc@pria_u_1.service");
    }

    // ── T3: unit-handle parsing + user resolution ────────────────────────────

    #[test]
    fn parses_context_and_legacy_unit_handles() {
        assert_eq!(
            ContainerSystemctl::unit_key("pria-kasmvnc-pria_u_1__inst_2.service").unwrap(),
            ("pria_u_1__inst_2".into(), true),
        );
        assert_eq!(
            ContainerSystemctl::unit_key("kasmvnc@pria_u_1.service").unwrap(),
            ("pria_u_1".into(), false),
        );
        assert!(ContainerSystemctl::unit_key("../../evil").is_err());
        assert!(ContainerSystemctl::unit_key("pria-kasmvnc-.service").is_err());
        assert!(ContainerSystemctl::unit_key("kasmvnc@.service").is_err());
    }

    #[test]
    fn resolves_user_from_session_meta_with_split_fallback() {
        let root = temp_run_root();
        // Legacy form: unit IS the username.
        assert_eq!(
            ContainerSystemctl::resolve_user(&root, "pria_u_9", false),
            "pria_u_9"
        );
        // Context form without sidecar: fall back to the prefix before "__".
        assert_eq!(
            ContainerSystemctl::resolve_user(&root, "pria_u_1__inst_2", true),
            "pria_u_1"
        );
        // Sidecar present: authoritative even when splitting would misparse.
        write_session_meta(
            &root,
            "pria_u_1__inst_2",
            &SessionMeta {
                session_id: "s1".into(),
                started_at: "2026-07-08T00:00:00Z".into(),
                linux_username: "pria_u_1".into(),
                instance_id: Some("inst_2".into()),
                ..SessionMeta::default()
            },
        )
        .unwrap();
        assert_eq!(
            ContainerSystemctl::resolve_user(&root, "pria_u_1__inst_2", true),
            "pria_u_1"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn desktop_argv_matches_the_systemd_execstart_contract() {
        let argv = ContainerSystemctl::desktop_argv(&env(":11", 8591));
        assert_eq!(
            argv,
            vec![
                ":11",
                "-fg",
                "-geometry",
                "1280x800",
                "-websocketPort",
                "8591",
                "-interface",
                "0.0.0.0",
            ]
        );
        // The password is NEVER on argv.
        assert!(!argv.iter().any(|a| a.contains("s3cret")));
    }

    // ── T3: process lifecycle (no root, no kasm binaries) ────────────────────

    #[tokio::test]
    async fn start_registers_active_child_and_writes_nothing() {
        let root = temp_run_root();
        write_env_file(&root, "pria_u_1__inst_2", &env(":11", 8591)).unwrap();
        let before = count_entries(&root.join("kasmvnc"));
        let ctl = ContainerSystemctl::new(root.clone())
            .with_bins("/bin/true", "/bin/sleep")
            .with_test_argv(vec!["30".into()]);
        let unit = "pria-kasmvnc-pria_u_1__inst_2.service";
        ctl.start(unit).await.unwrap();
        assert_eq!(ctl.status(unit).await.unwrap(), UnitStatus::Active);
        // No unit files or other artifacts materialized by the backend.
        assert_eq!(count_entries(&root.join("kasmvnc")), before);
        ctl.stop(unit).await.unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn double_start_is_idempotent_and_keeps_one_child() {
        let root = temp_run_root();
        write_env_file(&root, "pria_u_1", &env(":12", 8592)).unwrap();
        let ctl = ContainerSystemctl::new(root.clone())
            .with_bins("/bin/true", "/bin/sleep")
            .with_test_argv(vec!["30".into()]);
        let unit = "kasmvnc@pria_u_1.service";
        ctl.start(unit).await.unwrap();
        let pid1 = ctl.children.lock().unwrap().get(unit).unwrap().pid;
        ctl.start(unit).await.unwrap();
        let pid2 = ctl.children.lock().unwrap().get(unit).unwrap().pid;
        assert_eq!(pid1, pid2, "second start must reuse the live child");
        assert_eq!(ctl.children.lock().unwrap().len(), 1);
        ctl.stop(unit).await.unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn stop_terminates_the_child_and_status_reports_inactive() {
        let root = temp_run_root();
        write_env_file(&root, "pria_u_1", &env(":13", 8593)).unwrap();
        let ctl = ContainerSystemctl::new(root.clone())
            .with_bins("/bin/true", "/bin/sleep")
            .with_test_argv(vec!["30".into()]);
        let unit = "kasmvnc@pria_u_1.service";
        ctl.start(unit).await.unwrap();
        ctl.stop(unit).await.unwrap();
        assert_eq!(ctl.status(unit).await.unwrap(), UnitStatus::Inactive);
        // Idempotent stop of an untracked unit.
        ctl.stop(unit).await.unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn status_reports_failed_when_child_exits_nonzero() {
        let root = temp_run_root();
        write_env_file(&root, "pria_u_1", &env(":14", 8594)).unwrap();
        let ctl = ContainerSystemctl::new(root.clone())
            .with_bins("/bin/true", "/bin/false")
            .with_test_argv(vec![]);
        let unit = "kasmvnc@pria_u_1.service";
        ctl.start(unit).await.unwrap();
        // Poll until the exit is reaped (child terminates near-instantly).
        let mut status = UnitStatus::Unknown;
        for _ in 0..50 {
            status = ctl.status(unit).await.unwrap();
            if status != UnitStatus::Active {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(status, UnitStatus::Failed);
        // The failed entry was reaped; subsequent status is Inactive.
        assert_eq!(ctl.status(unit).await.unwrap(), UnitStatus::Inactive);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn start_fails_cleanly_when_env_file_is_missing() {
        let root = temp_run_root();
        let ctl = ContainerSystemctl::new(root.clone()).with_bins("/bin/true", "/bin/sleep");
        let err = ctl
            .start("kasmvnc@pria_u_missing.service")
            .await
            .expect_err("no env file → clean error");
        assert!(err.0.contains("missing desktop env file"), "{}", err.0);
        assert_eq!(
            ctl.status("kasmvnc@pria_u_missing.service").await.unwrap(),
            UnitStatus::Inactive
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn start_fails_when_password_helper_exits_nonzero() {
        let root = temp_run_root();
        write_env_file(&root, "pria_u_1", &env(":15", 8595)).unwrap();
        let ctl = ContainerSystemctl::new(root.clone()).with_bins("/bin/false", "/bin/sleep");
        let err = ctl
            .start("kasmvnc@pria_u_1.service")
            .await
            .expect_err("setpw failure must abort the start");
        assert!(err.0.contains("password helper failed"), "{}", err.0);
        let _ = std::fs::remove_dir_all(&root);
    }
}
