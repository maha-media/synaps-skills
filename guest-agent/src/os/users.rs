//! Real Linux principal manager (spec §6.2/§6.3).
//!
//! Drives `getent`/`useradd`/`usermod` with explicit argv — never a shell
//! string (spec §16.3 "no arbitrary shell"). Requires root; the integration
//! test that mutates real users is opt-in via `PRIA_GA_ROOT_TESTS=1` and is
//! skipped by default (spec §13.3).

use async_trait::async_trait;
use tokio::process::Command;

use super::{OsError, OsUserManager, PrincipalAction, PrincipalState, UserRecord, UserSpec};

/// Linux implementation backed by the shadow-utils CLIs.
pub struct LinuxUserManager;

impl LinuxUserManager {
    pub fn new() -> Self {
        Self
    }

    async fn run(program: &str, args: &[&str]) -> Result<(bool, String), OsError> {
        let output = Command::new(program)
            .args(args)
            .output()
            .await
            .map_err(|e| OsError(format!("failed to run {program}: {e}")))?;
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        Ok((output.status.success(), combined))
    }
}

impl Default for LinuxUserManager {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl OsUserManager for LinuxUserManager {
    async fn ensure_user(&self, spec: &UserSpec) -> Result<PrincipalAction, OsError> {
        let existing = self.lookup(&spec.username).await?;
        match existing {
            Some(rec) => {
                if rec.uid != spec.uid || rec.gid != spec.gid {
                    return Err(OsError(format!(
                        "uid/gid mismatch for {} (have {}/{}, want {}/{})",
                        spec.username, rec.uid, rec.gid, spec.uid, spec.gid
                    )));
                }
                match spec.state {
                    PrincipalState::Disabled => {
                        self.disable_user(&spec.username).await?;
                        Ok(PrincipalAction::Disabled)
                    }
                    PrincipalState::Active => {
                        if !rec.active {
                            let (ok, out) = Self::run("usermod", &["-U", &spec.username]).await?;
                            if !ok {
                                return Err(OsError(format!("usermod -U failed: {out}")));
                            }
                            Ok(PrincipalAction::Updated)
                        } else {
                            Ok(PrincipalAction::Unchanged)
                        }
                    }
                }
            }
            None => {
                let uid = spec.uid.to_string();
                let gid = spec.gid.to_string();
                let mut args: Vec<&str> = vec![
                    "--uid", &uid, "--gid", &gid, "-m", // create home
                ];
                if let Some(home) = &spec.home_dir {
                    args.push("--home-dir");
                    args.push(home);
                }
                args.push(&spec.username);
                let (ok, out) = Self::run("useradd", &args).await?;
                if !ok {
                    return Err(OsError(format!("useradd failed: {out}")));
                }
                if spec.state == PrincipalState::Disabled {
                    self.disable_user(&spec.username).await?;
                    return Ok(PrincipalAction::Disabled);
                }
                Ok(PrincipalAction::Created)
            }
        }
    }

    async fn disable_user(&self, username: &str) -> Result<(), OsError> {
        // Lock the password and the shell so no new login/session is possible.
        let (ok, out) = Self::run("usermod", &["-L", "-s", "/usr/sbin/nologin", username]).await?;
        if !ok {
            return Err(OsError(format!("usermod -L failed: {out}")));
        }
        Ok(())
    }

    async fn lookup(&self, username: &str) -> Result<Option<UserRecord>, OsError> {
        let (ok, out) = Self::run("getent", &["passwd", username]).await?;
        if !ok {
            return Ok(None);
        }
        // Format: name:passwd:uid:gid:gecos:home:shell
        let line = out.lines().next().unwrap_or("");
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() < 7 {
            return Ok(None);
        }
        let uid = fields[2].parse().unwrap_or(0);
        let gid = fields[3].parse().unwrap_or(0);
        let shell = fields[6];
        let active = !shell.contains("nologin") && !shell.contains("/false");
        Ok(Some(UserRecord {
            username: username.to_string(),
            uid,
            gid,
            active,
        }))
    }

    async fn kill_user_processes(&self, uid: u32) -> Result<u32, OsError> {
        // `pkill -U <uid>` returns 0 if processes matched, 1 if none.
        let (_ok, _out) = Self::run("pkill", &["-TERM", "-U", &uid.to_string()]).await?;
        Ok(0)
    }
}
