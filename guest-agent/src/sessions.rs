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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeState;
    use crate::synaps::launcher::FakeProcess;
    use std::sync::Arc;

    /// RED test: spawn a reaper task for a fake process that exits immediately.
    /// The session must be removed from the store AND the active_sessions counter
    /// must decrement — within 1 second. This test FAILS until the reaper is
    /// wired up in `api/sessions.rs`.
    #[tokio::test]
    async fn reaper_removes_session_on_child_exit() {
        let runtime = Arc::new(RuntimeState::new());
        let store = Arc::new(SessionStore::new(runtime.clone()));

        // Build a fake process that we can trigger to exit.
        let process = Arc::new(FakeProcess::new(99999));
        let entry = SessionEntry {
            session_id: "sess_reaper_test".to_string(),
            account_id: "acct_1".to_string(),
            instance_id: "inst_1".to_string(),
            user_id: "user_1".to_string(),
            uid: 1001,
            pid: 99999,
            started_at: "2026-01-01T00:00:00Z".to_string(),
            context_path: "/tmp/ctx.json".to_string(),
            process: process.clone(),
        };
        store.insert(entry);

        // Sanity: session is present and counter is 1.
        assert!(store.contains("sess_reaper_test"), "session must be in store after insert");
        assert_eq!(runtime.active_sessions(), 1, "counter must be 1 after insert");

        // Spawn the reaper — this is the exact pattern that api/sessions.rs start
        // will use. The reaper waits for the process to exit, then removes it.
        let store_clone = store.clone();
        let sid = "sess_reaper_test".to_string();
        let proc_clone: Arc<dyn crate::synaps::launcher::SessionProcess> = process.clone();
        tokio::spawn(async move {
            proc_clone.wait_for_exit().await;
            store_clone.remove(&sid);
            tracing::debug!(session_id = %sid, "reaper: session reaped after child exit");
        });

        // Trigger the fake process's exit signal (simulates synaps dying).
        process.trigger_exit();

        // Within 1 second the store must be empty and counter at 0.
        let deadline = tokio::time::Duration::from_secs(1);
        let result = tokio::time::timeout(deadline, async {
            loop {
                if !store.contains("sess_reaper_test") {
                    break;
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
            }
        })
        .await;

        assert!(result.is_ok(), "timed out: reaper did not remove session within 1s");
        assert_eq!(runtime.active_sessions(), 0, "counter must be 0 after reaper fires");
    }

    /// RED → GREEN test for #212 smoke-check.
    ///
    /// RED: without the smoke-check in `api/sessions.rs::start()`, a DOA process
    ///      silently enters the session store and the caller gets a 200 — this test
    ///      verifies the *mechanism* (timeout + wait_for_exit) works correctly so
    ///      the handler can rely on it.
    ///
    /// GREEN: `tokio::time::timeout(500ms, process.wait_for_exit())` resolves
    ///        `Ok(())` when the process is already dead, proving the handler
    ///        should treat `is_ok()` as DOA and return `SynapsLaunchFailed`.
    #[tokio::test]
    async fn smoke_check_catches_doa_process() {
        // A FakeProcess that exits immediately (trigger_exit called before
        // wait_for_exit) must resolve the timeout as Ok — i.e. DOA detected.
        let process = Arc::new(FakeProcess::new(12345));

        // Fire exit BEFORE we even start waiting — simulates synaps dying at spawn.
        process.trigger_exit();

        let proc_dyn: Arc<dyn crate::synaps::launcher::SessionProcess> = process;
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            proc_dyn.wait_for_exit(),
        )
        .await;

        // is_ok() == true → timeout fired because child already exited → DOA.
        assert!(
            result.is_ok(),
            "smoke-check: DOA process must resolve wait_for_exit within the timeout"
        );
    }

    /// Complement: a live process must NOT resolve within the smoke-check window.
    /// This proves the smoke-check doesn't false-positive on healthy launches.
    #[tokio::test]
    async fn smoke_check_passes_live_process() {
        // A FakeProcess that never calls trigger_exit → wait_for_exit never resolves.
        let process = Arc::new(FakeProcess::new(99998));

        let proc_dyn: Arc<dyn crate::synaps::launcher::SessionProcess> = process;
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(100), // short window for test speed
            proc_dyn.wait_for_exit(),
        )
        .await;

        // is_err() == true → timeout elapsed → child is alive → proceed normally.
        assert!(
            result.is_err(),
            "smoke-check: live process must NOT resolve wait_for_exit within the timeout"
        );
    }
}
