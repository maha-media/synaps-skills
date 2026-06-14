//! Shared mutable runtime state surfaced in health/heartbeat (spec §6.1/§7.1).
//!
//! Populated incrementally by later slices: session count (GA-B6), policy info
//! (GA-B7), fsmon status (GA-B7/B8). Held behind `Arc` in `AppState`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use crate::fsmon::types::PolicyDoc;

/// fsmon health as reported by the guest agent (spec §6.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsmonStatus {
    Healthy,
    Degraded,
    Unavailable,
}

impl FsmonStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            FsmonStatus::Healthy => "healthy",
            FsmonStatus::Degraded => "degraded",
            FsmonStatus::Unavailable => "unavailable",
        }
    }
}

/// The currently-applied policy summary (spec §6.1).
#[derive(Debug, Clone, Default)]
pub struct PolicyState {
    pub policy_profile_id: Option<String>,
    pub policy_version: Option<u64>,
    pub policy_hash: Option<String>,
}

/// fsmon decision counters (spec §6.7), incremented by the audit relay.
#[derive(Debug, Default, Clone, Copy)]
pub struct FsmonDecisions {
    pub allowed: u64,
    pub denied: u64,
    pub observed: u64,
}

/// Process-wide runtime state.
pub struct RuntimeState {
    started_at: Instant,
    active_sessions: AtomicU64,
    policy: Mutex<PolicyState>,
    fsmon_status: Mutex<FsmonStatus>,
    fsmon_allowed: AtomicU64,
    fsmon_denied: AtomicU64,
    fsmon_observed: AtomicU64,
    /// The last policy pushed to fsmon, re-applied on `fsmon/reload`.
    last_fsmon_policy: Mutex<Option<PolicyDoc>>,
    policy_loaded_at: Mutex<Option<String>>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeState {
    pub fn new() -> Self {
        Self {
            started_at: Instant::now(),
            active_sessions: AtomicU64::new(0),
            policy: Mutex::new(PolicyState::default()),
            fsmon_status: Mutex::new(FsmonStatus::Unavailable),
            fsmon_allowed: AtomicU64::new(0),
            fsmon_denied: AtomicU64::new(0),
            fsmon_observed: AtomicU64::new(0),
            last_fsmon_policy: Mutex::new(None),
            policy_loaded_at: Mutex::new(None),
        }
    }

    pub fn uptime_seconds(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    pub fn active_sessions(&self) -> u64 {
        self.active_sessions.load(Ordering::Relaxed)
    }

    pub fn incr_sessions(&self) {
        self.active_sessions.fetch_add(1, Ordering::Relaxed);
    }

    pub fn decr_sessions(&self) {
        // Saturating decrement.
        let mut cur = self.active_sessions.load(Ordering::Relaxed);
        while cur > 0 {
            match self.active_sessions.compare_exchange_weak(
                cur,
                cur - 1,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(actual) => cur = actual,
            }
        }
    }

    pub fn policy(&self) -> PolicyState {
        self.policy.lock().expect("policy poisoned").clone()
    }

    pub fn set_policy(&self, p: PolicyState) {
        *self.policy.lock().expect("policy poisoned") = p;
    }

    pub fn fsmon_status(&self) -> FsmonStatus {
        *self.fsmon_status.lock().expect("fsmon status poisoned")
    }

    pub fn set_fsmon_status(&self, s: FsmonStatus) {
        *self.fsmon_status.lock().expect("fsmon status poisoned") = s;
    }

    pub fn record_decision(&self, decision: &str) {
        match decision {
            "deny" | "denied" => {
                self.fsmon_denied.fetch_add(1, Ordering::Relaxed);
            }
            "observe" | "observed" => {
                self.fsmon_observed.fetch_add(1, Ordering::Relaxed);
            }
            "allow" | "allowed" => {
                self.fsmon_allowed.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }

    pub fn fsmon_decisions(&self) -> FsmonDecisions {
        FsmonDecisions {
            allowed: self.fsmon_allowed.load(Ordering::Relaxed),
            denied: self.fsmon_denied.load(Ordering::Relaxed),
            observed: self.fsmon_observed.load(Ordering::Relaxed),
        }
    }

    pub fn set_last_fsmon_policy(&self, doc: PolicyDoc) {
        *self.last_fsmon_policy.lock().unwrap() = Some(doc);
        *self.policy_loaded_at.lock().unwrap() = Some(chrono::Utc::now().to_rfc3339());
    }

    pub fn last_fsmon_policy(&self) -> Option<PolicyDoc> {
        self.last_fsmon_policy.lock().unwrap().clone()
    }

    pub fn policy_loaded_at(&self) -> Option<String> {
        self.policy_loaded_at.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_counter_saturates_at_zero() {
        let r = RuntimeState::new();
        assert_eq!(r.active_sessions(), 0);
        r.decr_sessions();
        assert_eq!(r.active_sessions(), 0);
        r.incr_sessions();
        r.incr_sessions();
        assert_eq!(r.active_sessions(), 2);
        r.decr_sessions();
        assert_eq!(r.active_sessions(), 1);
    }

    #[test]
    fn policy_and_fsmon_roundtrip() {
        let r = RuntimeState::new();
        assert_eq!(r.fsmon_status(), FsmonStatus::Unavailable);
        r.set_fsmon_status(FsmonStatus::Healthy);
        assert_eq!(r.fsmon_status(), FsmonStatus::Healthy);
        r.set_policy(PolicyState {
            policy_hash: Some("sha256:abc".into()),
            policy_version: Some(17),
            policy_profile_id: Some("policy_default".into()),
        });
        assert_eq!(r.policy().policy_version, Some(17));
    }
}
