//! Daemon orchestration: ties the policy engine, audit spool, audit forwarder
//! and control protocol together. The fanotify hot path (Linux) and the unit
//! tests both drive [`Daemon::decide_and_audit`].

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::sync::Mutex;

use crate::audit::{AuditRecord, AuditSpool};
use crate::control::{ControlRequest, ControlResponse};
use crate::policy::{Op, Policy, Verdict};

/// Forwards audit records off the hot path. The default forwards NDJSON to the
/// guest agent's audit socket (which performs the authenticated ingest POST);
/// failures are swallowed (the JSONL spool is the durable buffer).
pub trait Forwarder: Send + Sync {
    fn forward(&self, record: &AuditRecord);
}

/// No-op forwarder (spool-only mode).
pub struct NullForwarder;
impl Forwarder for NullForwarder {
    fn forward(&self, _record: &AuditRecord) {}
}

/// Streams NDJSON to the guest agent's audit Unix socket.
pub struct SocketForwarder {
    socket_path: String,
}

impl SocketForwarder {
    pub fn new(socket_path: impl Into<String>) -> Self {
        Self {
            socket_path: socket_path.into(),
        }
    }
}

impl Forwarder for SocketForwarder {
    fn forward(&self, record: &AuditRecord) {
        // Best-effort: connect, write one NDJSON envelope, drop. Never blocks the
        // hot path on the network — the guest agent does the real HTTPS POST.
        if let Ok(mut stream) = UnixStream::connect(&self.socket_path) {
            let envelope = crate::control::AuditForwardEnvelope {
                source: crate::audit::SOURCE.to_string(),
                events: vec![serde_json::from_str(&record.to_json_line())
                    .unwrap_or(serde_json::Value::Null)],
            };
            if let Ok(line) = serde_json::to_string(&envelope) {
                let _ = writeln!(stream, "{line}");
            }
        }
    }
}

/// Test forwarder that records everything it receives.
#[cfg(test)]
#[derive(Default)]
pub struct CapturingForwarder {
    pub records: Mutex<Vec<AuditRecord>>,
}

#[cfg(test)]
impl Forwarder for CapturingForwarder {
    fn forward(&self, record: &AuditRecord) {
        self.records.lock().unwrap().push(record.clone());
    }
}

pub struct Daemon {
    policy: Mutex<Policy>,
    spool: AuditSpool,
    forwarder: Box<dyn Forwarder>,
}

impl Daemon {
    pub fn new(policy: Policy, spool: AuditSpool, forwarder: Box<dyn Forwarder>) -> Self {
        Self {
            policy: Mutex::new(policy),
            spool,
            forwarder,
        }
    }

    /// The hot path: decide, then emit + forward the audit record. Returns the
    /// verdict so the fanotify loop can answer ALLOW/DENY inline.
    pub fn decide_and_audit(&self, uid: u32, path: &str, op: Op) -> Verdict {
        let (verdict, record) = {
            let mut policy = self.policy.lock().unwrap();
            let verdict = policy.decide(uid, path, op);
            let record =
                AuditRecord::from_verdict(uid, path, op, &verdict, policy.principal(uid));
            (verdict, record)
        };
        // Spool is durable; ignore IO errors (never crash the monitor).
        let _ = self.spool.emit(&record);
        self.forwarder.forward(&record);
        verdict
    }

    /// Handle one control request (policy push / stats / degraded toggle).
    pub fn handle_control(&self, req: ControlRequest) -> ControlResponse {
        let mut policy = self.policy.lock().unwrap();
        match req {
            ControlRequest::PolicyApply { policy: doc } => {
                policy.apply(doc);
                ControlResponse::Ok {
                    cache_len: Some(policy.cache_len()),
                    principals: None,
                    degraded: None,
                }
            }
            ControlRequest::Ping => ControlResponse::ok(),
            ControlRequest::Stats => ControlResponse::Ok {
                cache_len: Some(policy.cache_len()),
                principals: None,
                degraded: None,
            },
            ControlRequest::SetDegraded { degraded } => {
                policy.set_degraded(degraded);
                ControlResponse::Ok {
                    cache_len: Some(policy.cache_len()),
                    principals: None,
                    degraded: Some(degraded),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{Decision, PolicyDoc, Principal, Reason};

    fn principal(uid: u32) -> Principal {
        Principal {
            uid,
            account_id: Some("acct_123".into()),
            instance_id: Some("inst_456".into()),
            user_id: Some("user_789".into()),
            session_id: Some("sess_def".into()),
            vm_id: Some("vm_abc".into()),
            instance_roots: vec!["/srv/accounts/acme/instances/x".into()],
            home_root: Some("/home/alice".into()),
        }
    }

    fn daemon() -> (Daemon, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "fsmon-daemon-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let spool_path = dir.join("audit.jsonl");
        let policy = Policy::new(PolicyDoc {
            principals: vec![principal(12001)],
            ..PolicyDoc::default()
        });
        let d = Daemon::new(
            policy,
            AuditSpool::new(&spool_path),
            Box::new(NullForwarder),
        );
        (d, spool_path)
    }

    #[test]
    fn cross_instance_write_denied_and_audited() {
        let cap = std::sync::Arc::new(CapturingForwarder::default());
        let recs = cap;
        // Build a daemon with a capturing forwarder via a thin wrapper.
        let dir = std::env::temp_dir().join(format!("fsmon-cap-{}", std::process::id()));
        let policy = Policy::new(PolicyDoc {
            principals: vec![principal(12001)],
            ..PolicyDoc::default()
        });

        struct ArcForwarder(std::sync::Arc<CapturingForwarder>);
        impl Forwarder for ArcForwarder {
            fn forward(&self, r: &AuditRecord) {
                self.0.forward(r);
            }
        }
        let d = Daemon::new(
            policy,
            AuditSpool::new(dir.join("a.jsonl")),
            Box::new(ArcForwarder(recs.clone())),
        );

        let v = d.decide_and_audit(
            12001,
            "/srv/accounts/acme/instances/other/secret.env",
            Op::OpenWrite,
        );
        assert_eq!(v.decision, Decision::Deny);
        assert_eq!(v.reason, Reason::CrossInstanceWrite);
        let captured = recs.records.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].kind, "file.write.denied");
        assert_eq!(captured[0].account_id.as_deref(), Some("acct_123"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn allowed_write_passes() {
        let (d, spool) = daemon();
        let v = d.decide_and_audit(12001, "/home/alice/notes.md", Op::OpenWrite);
        assert_eq!(v.decision, Decision::Allow);
        let _ = std::fs::remove_dir_all(spool.parent().unwrap());
    }

    #[test]
    fn policy_apply_refreshes_without_restart() {
        let (d, spool) = daemon();
        // Warm the cache.
        d.decide_and_audit(12001, "/home/alice/x", Op::OpenWrite);
        // Push a deny-all default with no principals.
        let resp = d.handle_control(ControlRequest::PolicyApply {
            policy: PolicyDoc {
                default_decision: Decision::Deny,
                principals: vec![],
                immutable_prefixes: vec![],
                high_risk_prefixes: vec![],
                ..PolicyDoc::default()
            },
        });
        assert!(matches!(resp, ControlResponse::Ok { .. }));
        // The previously-allowed path is now denied (cache was cleared).
        let v = d.decide_and_audit(12001, "/home/alice/x", Op::OpenWrite);
        assert_eq!(v.decision, Decision::Deny);
        let _ = std::fs::remove_dir_all(spool.parent().unwrap());
    }

    #[test]
    fn set_degraded_fails_closed_high_risk() {
        let (d, spool) = daemon();
        d.handle_control(ControlRequest::SetDegraded { degraded: true });
        let v = d.decide_and_audit(12001, "/srv/synaps/x", Op::OpenWrite);
        assert_eq!(v.decision, Decision::Deny);
        assert_eq!(v.reason, Reason::MonitorDegraded);
        let _ = std::fs::remove_dir_all(spool.parent().unwrap());
    }
}
