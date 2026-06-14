//! Structured audit emission for the file-write monitor (B7/B8).
//!
//! Emits records matching docs/contract.md §2.3 (`file.write.allowed` /
//! `file.write.denied`) with `source: "synaps-sidecar"`. Records go to a local
//! JSONL spool (durable buffer) and stdout JSONL (supervisor capture). The B8
//! control layer forwards them to the Pria ingest endpoint.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::policy::{Decision, Op, Principal, Verdict};

pub const SCHEMA_VERSION: u32 = 1;
pub const SOURCE: &str = "synaps-sidecar";

/// A file-write decision record (contract §2.3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRecord {
    pub schema_version: u32,
    pub event_id: String,
    /// `file.write.allowed` | `file.write.denied`
    pub kind: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vm_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub linux_uid: u32,
    pub path: String,
    pub op: String,
    pub decision: String,
    pub reason: String,
    pub timestamp: String,
}

fn now_rfc3339() -> String {
    // Minimal RFC3339 (UTC) without pulling a date crate.
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();
    // days since epoch -> civil date (Howard Hinnant's algorithm).
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z"
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn event_id() -> String {
    // Monotonic-ish unique id without an external uuid dep.
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("evt_{:x}{:x}", dur.as_nanos(), std::process::id())
}

impl AuditRecord {
    pub fn from_verdict(
        uid: u32,
        path: &str,
        op: Op,
        verdict: &Verdict,
        principal: Option<&Principal>,
    ) -> Self {
        let kind = match verdict.decision {
            Decision::Allow => "file.write.allowed",
            Decision::Deny => "file.write.denied",
        };
        AuditRecord {
            schema_version: SCHEMA_VERSION,
            event_id: event_id(),
            kind: kind.to_string(),
            source: SOURCE.to_string(),
            account_id: principal.and_then(|p| p.account_id.clone()),
            instance_id: principal.and_then(|p| p.instance_id.clone()),
            user_id: principal.and_then(|p| p.user_id.clone()),
            vm_id: principal.and_then(|p| p.vm_id.clone()),
            session_id: principal.and_then(|p| p.session_id.clone()),
            linux_uid: uid,
            path: path.to_string(),
            op: op.as_str().to_string(),
            decision: verdict.decision.as_str().to_string(),
            reason: verdict.reason.as_str().to_string(),
            timestamp: now_rfc3339(),
        }
    }

    pub fn to_json_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

/// Append-only JSONL audit spool.
pub struct AuditSpool {
    path: PathBuf,
}

impl AuditSpool {
    pub fn new<P: AsRef<Path>>(path: P) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }

    pub fn emit(&self, record: &AuditRecord) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(f, "{}", record.to_json_line())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{Policy, PolicyDoc};

    fn principal() -> Principal {
        Principal {
            uid: 12001,
            account_id: Some("acct_123".into()),
            instance_id: Some("inst_456".into()),
            user_id: Some("user_789".into()),
            session_id: Some("sess_def".into()),
            vm_id: Some("vm_abc".into()),
            instance_roots: vec!["/srv/accounts/acme/instances/x".into()],
            home_root: Some("/home/alice".into()),
        }
    }

    #[test]
    fn timestamp_is_rfc3339_z() {
        let ts = now_rfc3339();
        assert!(ts.ends_with('Z'), "ts={ts}");
        assert_eq!(ts.len(), "2026-06-14T00:00:00.000Z".len());
        assert!(ts.starts_with("20"));
    }

    #[test]
    fn denied_record_carries_ids() {
        let mut pol = Policy::new(PolicyDoc {
            principals: vec![principal()],
            ..PolicyDoc::default()
        });
        let v = pol.decide(12001, "/srv/accounts/acme/instances/other/x", Op::OpenWrite);
        let rec = AuditRecord::from_verdict(
            12001,
            "/srv/accounts/acme/instances/other/x",
            Op::OpenWrite,
            &v,
            pol.principal(12001),
        );
        assert_eq!(rec.kind, "file.write.denied");
        assert_eq!(rec.reason, "cross_instance_write");
        assert_eq!(rec.account_id.as_deref(), Some("acct_123"));
        assert_eq!(rec.session_id.as_deref(), Some("sess_def"));
        assert_eq!(rec.source, "synaps-sidecar");
    }

    #[test]
    fn spool_writes_jsonl() {
        let dir = std::env::temp_dir().join(format!("fsmon-spool-{}", std::process::id()));
        let path = dir.join("audit.jsonl");
        let spool = AuditSpool::new(&path);
        let mut pol = Policy::new(PolicyDoc {
            principals: vec![principal()],
            ..PolicyDoc::default()
        });
        let v = pol.decide(12001, "/home/alice/x", Op::OpenWrite);
        let rec =
            AuditRecord::from_verdict(12001, "/home/alice/x", Op::OpenWrite, &v, pol.principal(12001));
        spool.emit(&rec).unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        let parsed: AuditRecord = serde_json::from_str(body.trim()).unwrap();
        assert_eq!(parsed.kind, "file.write.allowed");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
