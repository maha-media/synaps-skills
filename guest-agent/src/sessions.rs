//! In-memory session table (spec §6.4/§6.5). Tracks launched processes + state.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use crate::runtime::RuntimeState;
use crate::synaps::launcher::{SessionProcess, SessionStatus};

/// Per-session metadata stored alongside the process handle.
pub struct SessionEntry {
    pub session_id: String,
    pub account_id: String,
    pub instance_id: String,
    pub user_id: String,
    pub uid: u32,
    pub pid: u32,
    pub started_at: String,
    pub context_path: String,
    pub process: Arc<dyn SessionProcess>,
}

/// The session table. Increments/decrements the runtime active-session counter.
pub struct SessionStore {
    sessions: Mutex<HashMap<String, SessionEntry>>,
    runtime: Arc<RuntimeState>,
}

impl SessionStore {
    pub fn new(runtime: Arc<RuntimeState>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            runtime,
        }
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(session_id)
    }

    pub fn insert(&self, entry: SessionEntry) {
        let mut map = self.sessions.lock().unwrap();
        if map.insert(entry.session_id.clone(), entry).is_none() {
            self.runtime.incr_sessions();
        }
    }

    /// Clone out the process handle (an `Arc`) so async control methods can be
    /// awaited without holding the table lock.
    pub fn process(&self, session_id: &str) -> Option<Arc<dyn SessionProcess>> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .map(|e| e.process.clone())
    }

    /// Snapshot of status info for `status` endpoint.
    pub fn status(&self, session_id: &str) -> Option<(u32, String, SessionStatus)> {
        let map = self.sessions.lock().unwrap();
        map.get(session_id)
            .map(|e| (e.pid, e.started_at.clone(), e.process.status()))
    }

    /// Resolve a uid to its session identity tags (for fsmon audit enrichment).
    /// Returns `(session_id, account_id, instance_id, user_id)`.
    pub fn find_by_uid(&self, uid: u32) -> Option<(String, String, String, String)> {
        let map = self.sessions.lock().unwrap();
        map.values().find(|e| e.uid == uid).map(|e| {
            (
                e.session_id.clone(),
                e.account_id.clone(),
                e.instance_id.clone(),
                e.user_id.clone(),
            )
        })
    }

    /// Resolve a `session_id` to its trusted attribution tags (account /
    /// instance / user) for the AC-B2.2 usage signing proxy. The guest agent
    /// owns this mapping; the in-VM plugin may name a `session_id` but may NOT
    /// supply/spoof account/instance/user — those come from here. Returns
    /// `None` for an unknown session so the proxy can reject it.
    pub fn identity_tags(&self, session_id: &str) -> Option<(String, String, String)> {
        let map = self.sessions.lock().unwrap();
        map.get(session_id).map(|e| {
            (
                e.account_id.clone(),
                e.instance_id.clone(),
                e.user_id.clone(),
            )
        })
    }

    /// Remove a session (on close/exit) and decrement the active counter.
    pub fn remove(&self, session_id: &str) -> Option<SessionEntry> {
        let mut map = self.sessions.lock().unwrap();
        let removed = map.remove(session_id);
        if removed.is_some() {
            self.runtime.decr_sessions();
        }
        removed
    }
}
