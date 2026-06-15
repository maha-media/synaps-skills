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

// Disable/enable must be SYMMETRIC. `disable_user` sets BOTH a password lock
// and a nologin shell; `lookup().active` is derived purely from the shell
// (a nologin/false shell ⇒ inactive). So re-enabling a principal must restore
// a real login shell — unlocking the password alone leaves the nologin shell
// in place and the principal stays inactive forever (every session/desktop
// start is rejected with principal_disabled).
const NOLOGIN_SHELL: &str = "/usr/sbin/nologin";
const LOGIN_SHELL: &str = "/bin/bash";

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

    /// Idempotently ensure a group named `name` exists at `gid`. Drives
    /// `getent group`/`groupadd` with explicit argv (spec §16.3 — no shell).
    ///
    /// Fail-closed semantics:
    ///   * gid already taken by `name`            → Ok (idempotent no-op)
    ///   * gid taken by a *different* group name  → Err (refuse to alias)
    ///   * `name` exists at a *different* gid      → Err (refuse to re-gid)
    ///   * neither exists                          → `groupadd --gid <gid> <name>`
    async fn ensure_group(&self, gid: u32, name: &str) -> Result<(), OsError> {
        let gid_s = gid.to_string();
        // Look up by gid first.
        let (ok_gid, out_gid) = Self::run("getent", &["group", &gid_s]).await?;
        if ok_gid {
            // Format: name:passwd:gid:members
            let existing = out_gid.lines().next().unwrap_or("");
            let existing_name = existing.split(':').next().unwrap_or("");
            if existing_name == name {
                return Ok(());
            }
            return Err(OsError(format!(
                "gid {gid} already in use by group {existing_name} (want {name})"
            )));
        }
        // gid is free; refuse if the *name* exists at another gid.
        let (ok_name, out_name) = Self::run("getent", &["group", name]).await?;
        if ok_name {
            let existing = out_name.lines().next().unwrap_or("");
            let existing_gid = existing.split(':').nth(2).unwrap_or("?");
            return Err(OsError(format!(
                "group {name} already exists at gid {existing_gid} (want {gid})"
            )));
        }
        let (ok, out) = Self::run("groupadd", &["--gid", &gid_s, name]).await?;
        if !ok {
            return Err(OsError(format!("groupadd failed: {out}")));
        }
        Ok(())
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
                            // Symmetric with disable_user(): restore BOTH the
                            // password (-U) AND a login shell (-s). Without the
                            // shell restore, lookup() still reports the principal
                            // inactive (nologin) and session/desktop starts keep
                            // failing with principal_disabled.
                            let (ok, out) =
                                Self::run("usermod", &["-U", "-s", LOGIN_SHELL, &spec.username])
                                    .await?;
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
                // Ensure the primary group exists first when the control plane
                // pins a per-account group (`useradd --gid` requires it to
                // pre-exist). When `group_name` is None we assume a well-known
                // group (e.g. `users`) and skip group creation.
                if let Some(group_name) = &spec.group_name {
                    self.ensure_group(spec.gid, group_name).await?;
                }
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
        // Paired with the re-enable above (usermod -U -s LOGIN_SHELL) so a
        // disable → enable cycle round-trips cleanly.
        let (ok, out) = Self::run("usermod", &["-L", "-s", NOLOGIN_SHELL, username]).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    // `ensure_group` lookup/fail-closed semantics, exercised against the
    // always-present `root` group (gid 0) so no root privileges are required.
    #[tokio::test]
    async fn ensure_group_idempotent_for_matching_existing_group() {
        let mgr = LinuxUserManager::new();
        // gid 0 already exists as `root` — matching name is an idempotent no-op.
        assert!(mgr.ensure_group(0, "root").await.is_ok());
    }

    #[tokio::test]
    async fn ensure_group_refuses_gid_aliased_to_other_name() {
        let mgr = LinuxUserManager::new();
        // gid 0 is taken by `root`; refusing to alias it to another name.
        assert!(mgr.ensure_group(0, "not_root").await.is_err());
    }

    #[tokio::test]
    async fn ensure_group_refuses_name_at_other_gid() {
        let mgr = LinuxUserManager::new();
        // `root` group exists at gid 0; refuse to recreate it at a different gid.
        assert!(mgr.ensure_group(987654, "root").await.is_err());
    }

    // Disable → enable round-trip on a real throwaway user. Opt-in (needs root):
    //   PRIA_GA_ROOT_TESTS=1 cargo test -- ensure_user_disable_enable_round_trip --nocapture
    // Regression guard for the asymmetric-disable bug: disable sets a nologin
    // shell, so re-enabling MUST restore a login shell or lookup() keeps
    // reporting the principal inactive and every session start is rejected.
    #[tokio::test]
    async fn ensure_user_disable_enable_round_trip() {
        if std::env::var("PRIA_GA_ROOT_TESTS").ok().as_deref() != Some("1") {
            eprintln!("skipping ensure_user_disable_enable_round_trip (set PRIA_GA_ROOT_TESTS=1 as root)");
            return;
        }
        let mgr = LinuxUserManager::new();
        let username = "pria_ga_roundtrip_test";
        let uid = 30571u32;
        let gid = 30571u32;
        // Clean any prior run.
        let _ = LinuxUserManager::run("userdel", &["-r", username]).await;
        let _ = LinuxUserManager::run("groupdel", &[username]).await;

        let active_spec = UserSpec {
            username: username.to_string(),
            uid,
            gid,
            group_name: Some(username.to_string()),
            state: PrincipalState::Active,
            home_dir: None,
        };
        let disabled_spec = UserSpec { state: PrincipalState::Disabled, ..active_spec.clone() };

        // create → active
        assert_eq!(mgr.ensure_user(&active_spec).await.unwrap(), PrincipalAction::Created);
        assert!(mgr.lookup(username).await.unwrap().unwrap().active);

        // disable → inactive (nologin shell)
        assert_eq!(mgr.ensure_user(&disabled_spec).await.unwrap(), PrincipalAction::Disabled);
        assert!(!mgr.lookup(username).await.unwrap().unwrap().active);

        // re-enable → active again (shell restored — the regression this guards)
        assert_eq!(mgr.ensure_user(&active_spec).await.unwrap(), PrincipalAction::Updated);
        assert!(
            mgr.lookup(username).await.unwrap().unwrap().active,
            "re-enable must restore a login shell so the principal is active"
        );

        // cleanup
        let _ = LinuxUserManager::run("userdel", &["-r", username]).await;
        let _ = LinuxUserManager::run("groupdel", &[username]).await;
    }
}
