//! Abstract OS-principal layer (spec §6.2/§6.3, §16.1).
//!
//! The guest agent never shells out arbitrary commands; principal management is
//! a narrow typed trait. The real implementation ([`users::LinuxUserManager`])
//! drives `useradd`/`usermod`/`getent` with explicit argv (no shell string
//! interpolation). Handler tests use [`FakeUserManager`] (spec §13.2). Tests
//! that mutate real OS users are opt-in and skipped by default (spec §13.3).

pub mod users;

use async_trait::async_trait;

/// Desired principal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrincipalState {
    Active,
    Disabled,
}

impl PrincipalState {
    pub fn from_str_loose(s: &str) -> Self {
        match s {
            "disabled" | "locked" | "revoked" => PrincipalState::Disabled,
            _ => PrincipalState::Active,
        }
    }
}

/// A desired Linux principal.
#[derive(Debug, Clone)]
pub struct UserSpec {
    pub username: String,
    pub uid: u32,
    pub gid: u32,
    pub home_dir: Option<String>,
    pub state: PrincipalState,
    /// Optional name of the primary group to create (idempotently) at `gid`
    /// before the user is added. When `None`, the group is assumed to already
    /// exist (e.g. the well-known `users` group). Enables per-account primary
    /// group isolation: the control plane sends a deterministic per-account
    /// group name + gid so all of an account's users share one private group
    /// for EFS-shared file collaboration without crossing account boundaries.
    pub group_name: Option<String>,
}

/// What `ensure_user` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrincipalAction {
    Created,
    Updated,
    Unchanged,
    Disabled,
}

impl PrincipalAction {
    pub fn as_str(self) -> &'static str {
        match self {
            PrincipalAction::Created => "created",
            PrincipalAction::Updated => "updated",
            PrincipalAction::Unchanged => "unchanged",
            PrincipalAction::Disabled => "disabled",
        }
    }
}

/// A resolved local user record.
#[derive(Debug, Clone)]
pub struct UserRecord {
    pub username: String,
    pub uid: u32,
    pub gid: u32,
    pub active: bool,
}

/// OS-layer error.
#[derive(Debug)]
pub struct OsError(pub String);

impl std::fmt::Display for OsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for OsError {}

/// The narrow OS-principal management surface.
#[async_trait]
pub trait OsUserManager: Send + Sync {
    /// Idempotently reconcile a principal to the desired spec. Returns the
    /// action taken. A `Disabled` spec locks the account.
    async fn ensure_user(&self, spec: &UserSpec) -> Result<PrincipalAction, OsError>;

    /// Lock/disable a principal so it cannot start new sessions.
    async fn disable_user(&self, username: &str) -> Result<(), OsError>;

    /// Look up a principal, returning `None` if it does not exist.
    async fn lookup(&self, username: &str) -> Result<Option<UserRecord>, OsError>;

    /// Kill processes owned by `uid`. Returns the number signalled.
    async fn kill_user_processes(&self, uid: u32) -> Result<u32, OsError>;

    /// Idempotently ensure the group `group_name` exists at `gid` and that
    /// `username` is a member of it. Used for per-instance tenant isolation:
    /// each authorized Instance is a Linux group (`inst_<id>`) the user joins,
    /// gating access to that instance's private EFS workspace. Additive — a
    /// user accumulates memberships across the instances they're authorized on;
    /// revocation is the disable path's concern.
    async fn ensure_group_membership(
        &self,
        username: &str,
        gid: u32,
        group_name: &str,
    ) -> Result<(), OsError>;

    /// Idempotently REMOVE `username` from the supplementary group
    /// `group_name`. The per-instance DE-authorization primitive: when a user's
    /// access to a SINGLE instance is revoked, they leave only that instance's
    /// `inst_<id>` group — memberships on OTHER instances and the per-account
    /// PRIMARY group are untouched, so the account is NOT disabled platform-wide.
    /// Idempotent: removing a non-member (or an absent group) is a successful
    /// no-op so reconcile reruns converge cleanly.
    async fn revoke_group_membership(
        &self,
        username: &str,
        group_name: &str,
    ) -> Result<(), OsError>;

    /// Resolve the full numeric group list (primary + supplementary) for a
    /// user. Used for an initgroups-style privilege drop when launching a
    /// session: the synaps child must run with exactly the user's groups (so it
    /// gains `inst_<id>` access and DROPS root's supplementary groups), not
    /// inherit the agent's root group set.
    async fn resolve_group_gids(&self, username: &str) -> Result<Vec<u32>, OsError>;
}

/// Deterministic UID derivation (spec §6.2 "deterministic UID/GID consistency
/// across replicas"; mirrors the Track A `routes/models` A2 helper). Used only
/// when the control plane does not pin a UID — normally the request carries the
/// authoritative uid/gid and this is a cross-check.
pub fn deterministic_uid(account_id: &str, user_id: &str, base: u32, span: u32) -> u32 {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    hasher.update(b":");
    hasher.update(user_id.as_bytes());
    let digest = hasher.finalize();
    let n = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    base + (n % span.max(1))
}

// ── in-memory fake ───────────────────────────────────────────────────────────

#[cfg(any(test, feature = "test-fakes"))]
pub use fake::FakeUserManager;

#[cfg(any(test, feature = "test-fakes"))]
mod fake {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct FakeUserManager {
        users: Mutex<HashMap<String, UserRecord>>,
        /// username → set of (gid, group_name) supplementary memberships.
        memberships: Mutex<HashMap<String, Vec<(u32, String)>>>,
        pub killed: Mutex<Vec<u32>>,
    }

    impl FakeUserManager {
        pub fn with_user(self, rec: UserRecord) -> Self {
            self.users.lock().unwrap().insert(rec.username.clone(), rec);
            self
        }

        /// Test introspection: the supplementary groups a user has joined.
        pub fn memberships_of(&self, username: &str) -> Vec<(u32, String)> {
            self.memberships
                .lock()
                .unwrap()
                .get(username)
                .cloned()
                .unwrap_or_default()
        }
    }

    #[async_trait]
    impl OsUserManager for FakeUserManager {
        async fn ensure_user(&self, spec: &UserSpec) -> Result<PrincipalAction, OsError> {
            let mut users = self.users.lock().unwrap();
            let active = spec.state == PrincipalState::Active;
            match users.get_mut(&spec.username) {
                Some(existing) => {
                    let mut changed = false;
                    if existing.uid != spec.uid || existing.gid != spec.gid {
                        // UID/GID are immutable identity — surface as an error to
                        // fail closed rather than silently re-home.
                        return Err(OsError(format!(
                            "uid/gid mismatch for {} (have {}/{}, want {}/{})",
                            spec.username, existing.uid, existing.gid, spec.uid, spec.gid
                        )));
                    }
                    if existing.active != active {
                        existing.active = active;
                        changed = true;
                    }
                    if !active {
                        return Ok(PrincipalAction::Disabled);
                    }
                    Ok(if changed {
                        PrincipalAction::Updated
                    } else {
                        PrincipalAction::Unchanged
                    })
                }
                None => {
                    users.insert(
                        spec.username.clone(),
                        UserRecord {
                            username: spec.username.clone(),
                            uid: spec.uid,
                            gid: spec.gid,
                            active,
                        },
                    );
                    Ok(if active {
                        PrincipalAction::Created
                    } else {
                        PrincipalAction::Disabled
                    })
                }
            }
        }

        async fn disable_user(&self, username: &str) -> Result<(), OsError> {
            let mut users = self.users.lock().unwrap();
            match users.get_mut(username) {
                Some(u) => {
                    u.active = false;
                    Ok(())
                }
                None => Err(OsError(format!("no such user {username}"))),
            }
        }

        async fn lookup(&self, username: &str) -> Result<Option<UserRecord>, OsError> {
            Ok(self.users.lock().unwrap().get(username).cloned())
        }

        async fn kill_user_processes(&self, uid: u32) -> Result<u32, OsError> {
            self.killed.lock().unwrap().push(uid);
            Ok(0)
        }

        async fn ensure_group_membership(
            &self,
            username: &str,
            gid: u32,
            group_name: &str,
        ) -> Result<(), OsError> {
            // The user must exist to join a group (fail-closed, mirrors usermod).
            if !self.users.lock().unwrap().contains_key(username) {
                return Err(OsError(format!("no such user {username}")));
            }
            let mut m = self.memberships.lock().unwrap();
            let entry = m.entry(username.to_string()).or_default();
            if !entry.iter().any(|(g, _)| *g == gid) {
                entry.push((gid, group_name.to_string()));
            }
            Ok(())
        }

        async fn resolve_group_gids(&self, username: &str) -> Result<Vec<u32>, OsError> {
            let users = self.users.lock().unwrap();
            let rec = users
                .get(username)
                .ok_or_else(|| OsError(format!("no such user {username}")))?;
            let mut gids = vec![rec.gid];
            for (g, _) in self.memberships_of(username) {
                if !gids.contains(&g) {
                    gids.push(g);
                }
            }
            Ok(gids)
        }

        async fn revoke_group_membership(
            &self,
            username: &str,
            group_name: &str,
        ) -> Result<(), OsError> {
            // Idempotent: dropping the membership of an unknown user / group is a
            // successful no-op (mirrors `gpasswd -d` tolerating non-members).
            let mut m = self.memberships.lock().unwrap();
            if let Some(entry) = m.get_mut(username) {
                entry.retain(|(_, n)| n != group_name);
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_uid_is_stable_and_in_range() {
        let a = deterministic_uid("acct_1", "user_1", 100_000, 50_000);
        let b = deterministic_uid("acct_1", "user_1", 100_000, 50_000);
        assert_eq!(a, b);
        assert!((100_000..150_000).contains(&a));
        let c = deterministic_uid("acct_1", "user_2", 100_000, 50_000);
        assert_ne!(a, c);
    }

    #[tokio::test]
    async fn fake_create_then_idempotent() {
        let mgr = FakeUserManager::default();
        let spec = UserSpec {
            username: "pria_u_1".into(),
            uid: 104251,
            gid: 104251,
            home_dir: Some("/home/pria_u_1".into()),
            state: PrincipalState::Active,
            group_name: None,
        };
        assert_eq!(
            mgr.ensure_user(&spec).await.unwrap(),
            PrincipalAction::Created
        );
        assert_eq!(
            mgr.ensure_user(&spec).await.unwrap(),
            PrincipalAction::Unchanged
        );
        mgr.disable_user("pria_u_1").await.unwrap();
        let rec = mgr.lookup("pria_u_1").await.unwrap().unwrap();
        assert!(!rec.active);
    }

    #[tokio::test]
    async fn fake_uid_mismatch_fails_closed() {
        let mgr = FakeUserManager::default().with_user(UserRecord {
            username: "u".into(),
            uid: 1,
            gid: 1,
            active: true,
        });
        let spec = UserSpec {
            username: "u".into(),
            uid: 2,
            gid: 2,
            home_dir: None,
            state: PrincipalState::Active,
            group_name: None,
        };
        assert!(mgr.ensure_user(&spec).await.is_err());
    }

    #[tokio::test]
    async fn fake_group_membership_is_additive_and_idempotent() {
        let mgr = FakeUserManager::default().with_user(UserRecord {
            username: "u".into(),
            uid: 28146,
            gid: 14952,
            active: true,
        });
        // Join two instance groups; re-joining one is a no-op.
        mgr.ensure_group_membership("u", 60001, "inst_a").await.unwrap();
        mgr.ensure_group_membership("u", 60002, "inst_b").await.unwrap();
        mgr.ensure_group_membership("u", 60001, "inst_a").await.unwrap();
        let m = mgr.memberships_of("u");
        assert_eq!(m.len(), 2, "duplicate membership must not double-add");
        assert!(m.iter().any(|(g, n)| *g == 60001 && n == "inst_a"));
        assert!(m.iter().any(|(g, n)| *g == 60002 && n == "inst_b"));
    }

    #[tokio::test]
    async fn fake_group_membership_fails_for_unknown_user() {
        let mgr = FakeUserManager::default();
        assert!(mgr
            .ensure_group_membership("ghost", 60001, "inst_a")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn fake_resolve_group_gids_includes_primary_and_memberships() {
        let mgr = FakeUserManager::default().with_user(UserRecord {
            username: "u".into(),
            uid: 28146,
            gid: 14952,
            active: true,
        });
        mgr.ensure_group_membership("u", 60001, "inst_a").await.unwrap();
        mgr.ensure_group_membership("u", 60002, "inst_b").await.unwrap();
        let gids = mgr.resolve_group_gids("u").await.unwrap();
        // Primary gid first, then the joined instance gids — the exact set the
        // launcher hands to setgroups (drops root's groups).
        assert_eq!(gids[0], 14952, "primary gid must lead the group list");
        assert!(gids.contains(&60001));
        assert!(gids.contains(&60002));
        assert!(!gids.contains(&0), "must never include root's gid 0");
    }

    #[tokio::test]
    async fn fake_revoke_group_membership_is_surgical_and_idempotent() {
        let mgr = FakeUserManager::default().with_user(UserRecord {
            username: "u".into(),
            uid: 28146,
            gid: 14952,
            active: true,
        });
        mgr.ensure_group_membership("u", 60001, "inst_a").await.unwrap();
        mgr.ensure_group_membership("u", 60002, "inst_b").await.unwrap();
        // Revoke ONLY inst_a — inst_b membership (other instance) must survive.
        mgr.revoke_group_membership("u", "inst_a").await.unwrap();
        let m = mgr.memberships_of("u");
        assert_eq!(m.len(), 1, "only the revoked group is removed");
        assert!(m.iter().all(|(_, n)| n != "inst_a"), "inst_a removed");
        assert!(m.iter().any(|(g, n)| *g == 60002 && n == "inst_b"), "inst_b retained");
        // Re-revoking is an idempotent no-op (not an error).
        mgr.revoke_group_membership("u", "inst_a").await.unwrap();
        // The user is still active — per-instance revoke never disables the account.
        assert!(mgr.lookup("u").await.unwrap().unwrap().active);
        // Their resolved gids still include the primary + the retained instance.
        let gids = mgr.resolve_group_gids("u").await.unwrap();
        assert!(gids.contains(&14952) && gids.contains(&60002) && !gids.contains(&60001));
    }

    #[tokio::test]
    async fn fake_revoke_unknown_user_is_noop() {
        let mgr = FakeUserManager::default();
        assert!(mgr.revoke_group_membership("ghost", "inst_a").await.is_ok());
    }
}
