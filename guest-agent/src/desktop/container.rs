//! Container-native KasmVNC child-process lifecycle for AWS ECS/Fargate.
//!
//! `DesktopStore` still allocates ports and writes context env files. This
//! backend interprets the same unit name as a stable handle, starts `vncserver`
//! directly as the reconciled Linux user, and tracks the child without systemd.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use async_trait::async_trait;
use tokio::process::Child;

use super::kasmvnc::{
    context_unit, kasmvnc_unit, read_env_file, DesktopUnitSpec, SystemctlBackend, SystemctlError,
    UnitGenerator, UnitStatus,
};

const CONTEXT_PREFIX: &str = "pria-kasmvnc-";
const CONTEXT_SUFFIX: &str = ".service";
const LEGACY_PREFIX: &str = "kasmvnc@";
const LEGACY_SUFFIX: &str = ".service";

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

pub struct ContainerSystemctl {
    run_root: PathBuf,
    children: Mutex<HashMap<String, Child>>,
}

impl ContainerSystemctl {
    pub fn new(run_root: PathBuf) -> Self {
        Self {
            run_root,
            children: Mutex::new(HashMap::new()),
        }
    }

    fn key_and_user(unit: &str) -> Result<(String, String), SystemctlError> {
        if let Some(key) = unit
            .strip_prefix(CONTEXT_PREFIX)
            .and_then(|s| s.strip_suffix(CONTEXT_SUFFIX))
        {
            let user = key.split_once("__").map(|(u, _)| u).unwrap_or(key);
            return Ok((key.to_string(), user.to_string()));
        }
        if let Some(user) = unit
            .strip_prefix(LEGACY_PREFIX)
            .and_then(|s| s.strip_suffix(LEGACY_SUFFIX))
        {
            return Ok((user.to_string(), user.to_string()));
        }
        Err(SystemctlError(format!(
            "invalid desktop unit handle: {unit}"
        )))
    }

    fn reap_finished(&self, unit: &str) -> Result<Option<UnitStatus>, SystemctlError> {
        let mut children = self.children.lock().unwrap();
        let Some(child) = children.get_mut(unit) else {
            return Ok(None);
        };
        match child.try_wait() {
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

#[async_trait]
impl SystemctlBackend for ContainerSystemctl {
    async fn start(&self, unit: &str) -> Result<(), SystemctlError> {
        if matches!(self.reap_finished(unit)?, Some(UnitStatus::Active)) {
            return Ok(());
        }
        let (key, user) = Self::key_and_user(unit)?;
        let env = read_env_file(&self.run_root, &key)
            .ok_or_else(|| SystemctlError(format!("missing desktop env for {key}")))?;

        // Container mode has no systemd ExecStartPre, so materialize the
        // context-specific Kasm credential before the server can accept traffic.
        // The helper reads the password from the root-owned 0600 env file; it is
        // never placed on argv or emitted to logs.
        let setpw = tokio::process::Command::new("/usr/local/sbin/pria-kasm-setpw")
            .args([&user, &key])
            .env("PRIA_RUN_ROOT", &self.run_root)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .status()
            .await
            .map_err(|e| SystemctlError(format!("configure desktop password for {unit}: {e}")))?;
        if !setpw.success() {
            return Err(SystemctlError(format!(
                "desktop password helper failed for {unit}"
            )));
        }

        let uid_out = tokio::process::Command::new("id")
            .args(["-u", &user])
            .output()
            .await
            .map_err(|e| SystemctlError(format!("resolve uid for {user}: {e}")))?;
        let gid_out = tokio::process::Command::new("id")
            .args(["-g", &user])
            .output()
            .await
            .map_err(|e| SystemctlError(format!("resolve gid for {user}: {e}")))?;
        if !uid_out.status.success() || !gid_out.status.success() {
            return Err(SystemctlError(format!(
                "desktop user does not exist: {user}"
            )));
        }
        let uid = String::from_utf8_lossy(&uid_out.stdout)
            .trim()
            .parse::<u32>()
            .map_err(|e| SystemctlError(format!("invalid uid for {user}: {e}")))?;
        let gid = String::from_utf8_lossy(&gid_out.stdout)
            .trim()
            .parse::<u32>()
            .map_err(|e| SystemctlError(format!("invalid gid for {user}: {e}")))?;

        let mut cmd = tokio::process::Command::new("/usr/bin/vncserver");
        cmd.args([
            &env.display,
            "-fg",
            "-geometry",
            &env.geometry,
            "-websocketPort",
            &env.ws_port.to_string(),
            "-interface",
            "0.0.0.0",
            "-KasmPasswordFile",
            &format!("/home/{user}/.vnc/pria-{key}.passwd"),
        ])
        .uid(uid)
        .gid(gid)
        .env("HOME", format!("/home/{user}"))
        .env("USER", &user)
        .env("LOGNAME", &user)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true);

        let child = cmd
            .spawn()
            .map_err(|e| SystemctlError(format!("start {unit}: {e}")))?;
        self.children
            .lock()
            .unwrap()
            .insert(unit.to_string(), child);
        Ok(())
    }

    async fn stop(&self, unit: &str) -> Result<(), SystemctlError> {
        let child = self.children.lock().unwrap().remove(unit);
        if let Some(mut child) = child {
            child
                .start_kill()
                .map_err(|e| SystemctlError(format!("stop {unit}: {e}")))?;
            let _ = child.wait().await;
        }
        Ok(())
    }

    async fn status(&self, unit: &str) -> Result<UnitStatus, SystemctlError> {
        Ok(self.reap_finished(unit)?.unwrap_or(UnitStatus::Inactive))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(user: &str, instance: Option<&str>) -> DesktopUnitSpec {
        let key = crate::desktop::kasmvnc::desktop_key(user, instance);
        DesktopUnitSpec {
            key: key.clone(),
            linux_username: user.into(),
            instance_id: instance.map(String::from),
            env_file: std::path::PathBuf::from(format!("/run/pria/kasmvnc/{key}.env")),
        }
    }

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

    #[test]
    fn parses_context_and_legacy_handles_without_shell_input() {
        assert_eq!(
            ContainerSystemctl::key_and_user("pria-kasmvnc-pria_u_1__inst_2.service").unwrap(),
            ("pria_u_1__inst_2".into(), "pria_u_1".into()),
        );
        assert_eq!(
            ContainerSystemctl::key_and_user("kasmvnc@pria_u_1.service").unwrap(),
            ("pria_u_1".into(), "pria_u_1".into()),
        );
        assert!(ContainerSystemctl::key_and_user("../../evil").is_err());
    }
}
