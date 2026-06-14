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
        pub killed: Mutex<Vec<u32>>,
    }

    impl FakeUserManager {
        pub fn with_user(self, rec: UserRecord) -> Self {
            self.users.lock().unwrap().insert(rec.username.clone(), rec);
            self
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
        };
        assert!(mgr.ensure_user(&spec).await.is_err());
    }
}
