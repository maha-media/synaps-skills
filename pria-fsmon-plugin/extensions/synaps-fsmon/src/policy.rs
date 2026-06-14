//! Policy engine + L1 decision cache for the file-write monitor (B7).
//!
//! Decisions are served from an in-memory L1 cache keyed by `(uid, path, op)`
//! so the hot path never makes a synchronous network call (spec §4.7). Central
//! policy is pushed into this engine via the control socket (B8); the cache is
//! cleared on every policy apply so stale decisions never linger.
//!
//! Fail posture: when the monitor cannot positively authorise a write to a
//! protected/owned path it **denies** (fail-closed). See [`Policy::decide`].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Filesystem operation classes mirrored from fanotify permission events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    OpenWrite,
    OpenRead,
    Access,
}

impl Op {
    pub fn is_write(self) -> bool {
        matches!(self, Op::OpenWrite)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Op::OpenWrite => "open_write",
            Op::OpenRead => "open_read",
            Op::Access => "access",
        }
    }
}

/// Allow / deny outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Deny,
}

impl Decision {
    pub fn as_str(self) -> &'static str {
        match self {
            Decision::Allow => "allow",
            Decision::Deny => "deny",
        }
    }
}

/// Reason codes (match docs/contract.md §2.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Allowed,
    CrossInstanceWrite,
    OutOfHome,
    ImmutablePath,
    DlpMatch,
    PolicyDefaultDeny,
    MonitorDegraded,
    PolicyRule,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Allowed => "allowed",
            Reason::CrossInstanceWrite => "cross_instance_write",
            Reason::OutOfHome => "out_of_home",
            Reason::ImmutablePath => "immutable_path",
            Reason::DlpMatch => "dlp_match",
            Reason::PolicyDefaultDeny => "policy_default_deny",
            Reason::MonitorDegraded => "monitor_degraded",
            Reason::PolicyRule => "policy_rule",
        }
    }
}

/// A resolved decision plus the reason and the principal (for audit tagging).
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub decision: Decision,
    pub reason: Reason,
}

impl Verdict {
    pub fn allow(reason: Reason) -> Self {
        Self { decision: Decision::Allow, reason }
    }
    pub fn deny(reason: Reason) -> Self {
        Self { decision: Decision::Deny, reason }
    }
}

/// Per-uid principal/context record pushed by the guest agent (B8). Carries the
/// allowed write subtrees and the IDs used to tag audit records.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Principal {
    pub uid: u32,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub vm_id: Option<String>,
    /// Allowed write subtrees for this principal (instance workspaces).
    #[serde(default)]
    pub instance_roots: Vec<String>,
    /// The principal's home directory root.
    #[serde(default)]
    pub home_root: Option<String>,
}

/// An explicit central policy rule (first match wins, before built-in guards).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    /// Match this uid (None = any).
    #[serde(default)]
    pub uid: Option<u32>,
    /// Match paths under this prefix.
    pub path_prefix: String,
    /// Match this op (None = any).
    #[serde(default)]
    pub op: Option<Op>,
    pub decision: Decision,
    #[serde(default)]
    pub reason: Option<Reason>,
}

/// The full pushed policy document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyDoc {
    #[serde(default = "default_allow")]
    pub default_decision: Decision,
    #[serde(default)]
    pub immutable_prefixes: Vec<String>,
    #[serde(default)]
    pub dlp_substrings: Vec<String>,
    #[serde(default)]
    pub rules: Vec<Rule>,
    #[serde(default)]
    pub principals: Vec<Principal>,
    /// High-risk path prefixes that must fail CLOSED when the monitor degrades.
    #[serde(default)]
    pub high_risk_prefixes: Vec<String>,
}

fn default_allow() -> Decision {
    Decision::Allow
}

impl Default for PolicyDoc {
    fn default() -> Self {
        Self {
            default_decision: Decision::Allow,
            immutable_prefixes: vec![
                "/srv/synaps/policy".to_string(),
                "/srv/synaps/account.json".to_string(),
                "/srv/synaps/instance.json".to_string(),
                "/srv/synaps/vm.json".to_string(),
            ],
            dlp_substrings: Vec::new(),
            rules: Vec::new(),
            principals: Vec::new(),
            high_risk_prefixes: vec![
                "/srv/synaps".to_string(),
                "/etc".to_string(),
            ],
        }
    }
}

/// Normalise a path lexically (no filesystem access) to defeat `..` traversal.
pub fn normalize(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let absolute = path.starts_with('/');
    for comp in path.split('/') {
        match comp {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    let joined = out.join("/");
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

fn under(path: &str, prefix: &str) -> bool {
    let p = normalize(prefix);
    path == p || path.starts_with(&format!("{}/", p.trim_end_matches('/')))
}

/// The policy engine: holds the active policy + the L1 decision cache.
pub struct Policy {
    doc: PolicyDoc,
    principals: HashMap<u32, Principal>,
    cache: HashMap<(u32, String, Op), Verdict>,
    /// When true, the fanotify hot path is unavailable — fail closed on high-risk
    /// paths and degrade to log-only elsewhere.
    degraded: bool,
}

impl Policy {
    pub fn new(doc: PolicyDoc) -> Self {
        let principals = doc.principals.iter().map(|p| (p.uid, p.clone())).collect();
        Self {
            doc,
            principals,
            cache: HashMap::new(),
            degraded: false,
        }
    }

    /// Construct an empty (default-policy) engine. Public API used by callers
    /// that build a daemon before the first policy push (B8).
    #[allow(dead_code)]
    pub fn empty() -> Self {
        Self::new(PolicyDoc::default())
    }

    /// Replace the active policy (B8 hot push) and clear the L1 cache.
    pub fn apply(&mut self, doc: PolicyDoc) {
        self.principals = doc.principals.iter().map(|p| (p.uid, p.clone())).collect();
        self.doc = doc;
        self.cache.clear();
    }

    pub fn set_degraded(&mut self, degraded: bool) {
        if self.degraded != degraded {
            self.cache.clear();
        }
        self.degraded = degraded;
    }

    pub fn principal(&self, uid: u32) -> Option<&Principal> {
        self.principals.get(&uid)
    }

    pub fn cache_len(&self) -> usize {
        self.cache.len()
    }

    /// Decide, serving from the L1 cache when possible.
    pub fn decide(&mut self, uid: u32, path: &str, op: Op) -> Verdict {
        let norm = normalize(path);
        let key = (uid, norm.clone(), op);
        if let Some(v) = self.cache.get(&key) {
            return v.clone();
        }
        let verdict = self.compute(uid, &norm, op);
        self.cache.insert(key, verdict.clone());
        verdict
    }

    fn compute(&self, uid: u32, path: &str, op: Op) -> Verdict {
        // 0. Degraded posture: fail closed on high-risk paths for writes.
        if self.degraded {
            if op.is_write()
                && self.doc.high_risk_prefixes.iter().any(|p| under(path, p))
            {
                return Verdict::deny(Reason::MonitorDegraded);
            }
            // low-risk: degrade to log-only (allow), caller logs an alert.
        }

        // 1. Immutable policy/identity files — deny writes (mirror `chattr +i`).
        if op.is_write()
            && self.doc.immutable_prefixes.iter().any(|p| under(path, p))
        {
            return Verdict::deny(Reason::ImmutablePath);
        }

        // 2. Explicit central rules (first match wins).
        for rule in &self.doc.rules {
            if rule.uid.map(|u| u == uid).unwrap_or(true)
                && rule.op.map(|o| o == op).unwrap_or(true)
                && under(path, &rule.path_prefix)
            {
                return Verdict {
                    decision: rule.decision,
                    reason: rule.reason.unwrap_or(Reason::PolicyRule),
                };
            }
        }

        // 3. DLP path rules.
        if op.is_write()
            && self.doc.dlp_substrings.iter().any(|s| path.contains(s.as_str()))
        {
            return Verdict::deny(Reason::DlpMatch);
        }

        // 4. Built-in containment guard for writes: must stay inside the
        //    principal's instance workspace(s) or home. Fail-closed if we have
        //    no principal record for a write.
        if op.is_write() {
            match self.principals.get(&uid) {
                Some(principal) => {
                    let mut roots: Vec<&String> = principal.instance_roots.iter().collect();
                    if let Some(home) = &principal.home_root {
                        roots.push(home);
                    }
                    let inside = roots.iter().any(|r| under(path, r));
                    if !inside {
                        // Distinguish cross-instance vs out-of-home for audit.
                        let reason = if principal
                            .home_root
                            .as_ref()
                            .map(|h| under(path, h))
                            .unwrap_or(false)
                        {
                            Reason::OutOfHome
                        } else {
                            Reason::CrossInstanceWrite
                        };
                        return Verdict::deny(reason);
                    }
                    return Verdict::allow(Reason::Allowed);
                }
                None => {
                    // No principal mapping for a writing uid -> fail closed
                    // on managed trees, otherwise honour default.
                    if self.doc.high_risk_prefixes.iter().any(|p| under(path, p)) {
                        return Verdict::deny(Reason::CrossInstanceWrite);
                    }
                }
            }
        }

        // 5. Policy default.
        match self.doc.default_decision {
            Decision::Allow => Verdict::allow(Reason::Allowed),
            Decision::Deny => Verdict::deny(Reason::PolicyDefaultDeny),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn principal(uid: u32) -> Principal {
        Principal {
            uid,
            account_id: Some("acct_123".into()),
            instance_id: Some("inst_456".into()),
            user_id: Some("user_789".into()),
            session_id: Some("sess_def".into()),
            vm_id: Some("vm_abc".into()),
            instance_roots: vec![
                "/srv/accounts/acme-school/instances/tutor-bot-7".into(),
            ],
            home_root: Some("/home/alice_acme".into()),
        }
    }

    fn doc_with_principal() -> PolicyDoc {
        PolicyDoc {
            principals: vec![principal(12001)],
            ..PolicyDoc::default()
        }
    }

    #[test]
    fn normalize_defeats_traversal() {
        assert_eq!(
            normalize("/srv/accounts/a/instances/x/workspace/../../y/z"),
            "/srv/accounts/a/instances/y/z"
        );
        assert_eq!(normalize("/a/./b//c"), "/a/b/c");
    }

    #[test]
    fn allows_in_instance_write() {
        let mut p = Policy::new(doc_with_principal());
        let v = p.decide(
            12001,
            "/srv/accounts/acme-school/instances/tutor-bot-7/workspace/a.txt",
            Op::OpenWrite,
        );
        assert_eq!(v, Verdict::allow(Reason::Allowed));
    }

    #[test]
    fn denies_cross_instance_write() {
        let mut p = Policy::new(doc_with_principal());
        let v = p.decide(
            12001,
            "/srv/accounts/acme-school/instances/lab-grader-2/workspace/secret.env",
            Op::OpenWrite,
        );
        assert_eq!(v.decision, Decision::Deny);
        assert_eq!(v.reason, Reason::CrossInstanceWrite);
    }

    #[test]
    fn denies_traversal_escape() {
        let mut p = Policy::new(doc_with_principal());
        let v = p.decide(
            12001,
            "/srv/accounts/acme-school/instances/tutor-bot-7/workspace/../../lab-grader-2/x",
            Op::OpenWrite,
        );
        assert_eq!(v.decision, Decision::Deny);
    }

    #[test]
    fn allows_home_write() {
        let mut p = Policy::new(doc_with_principal());
        let v = p.decide(12001, "/home/alice_acme/notes.md", Op::OpenWrite);
        assert_eq!(v.decision, Decision::Allow);
    }

    #[test]
    fn denies_immutable_policy_write() {
        let mut p = Policy::new(doc_with_principal());
        let v = p.decide(12001, "/srv/synaps/policy/rules.md", Op::OpenWrite);
        assert_eq!(v.reason, Reason::ImmutablePath);
        assert_eq!(v.decision, Decision::Deny);
    }

    #[test]
    fn reads_are_allowed_by_default() {
        let mut p = Policy::new(doc_with_principal());
        let v = p.decide(12001, "/etc/hosts", Op::OpenRead);
        assert_eq!(v.decision, Decision::Allow);
    }

    #[test]
    fn unknown_uid_write_fails_closed_on_managed_tree() {
        let mut p = Policy::new(PolicyDoc::default());
        let v = p.decide(99999, "/srv/synaps/secret", Op::OpenWrite);
        assert_eq!(v.decision, Decision::Deny);
    }

    #[test]
    fn degraded_fails_closed_high_risk_only() {
        let mut p = Policy::new(doc_with_principal());
        p.set_degraded(true);
        let high = p.decide(12001, "/srv/synaps/x", Op::OpenWrite);
        assert_eq!(high.decision, Decision::Deny);
        assert_eq!(high.reason, Reason::MonitorDegraded);
        // low-risk path that is normally allowed (inside home) stays allowed:
        // degraded only forces deny on high-risk prefixes.
        let low = p.decide(12001, "/home/alice_acme/scratch", Op::OpenWrite);
        assert_eq!(low.decision, Decision::Allow);
    }

    #[test]
    fn cache_serves_repeat_decisions_and_clears_on_apply() {
        let mut p = Policy::new(doc_with_principal());
        let path = "/home/alice_acme/x";
        p.decide(12001, path, Op::OpenWrite);
        assert_eq!(p.cache_len(), 1);
        p.decide(12001, path, Op::OpenWrite);
        assert_eq!(p.cache_len(), 1); // served from cache, no new entry
        p.apply(doc_with_principal());
        assert_eq!(p.cache_len(), 0);
    }

    #[test]
    fn empty_policy_allows_unmanaged_reads() {
        let mut p = Policy::empty();
        assert_eq!(p.decide(0, "/tmp/x", Op::OpenRead).decision, Decision::Allow);
    }

    #[test]
    fn explicit_rule_wins() {
        let mut doc = doc_with_principal();
        doc.rules.push(Rule {
            uid: None,
            path_prefix: "/srv/accounts/acme-school/instances/tutor-bot-7/workspace/blocked"
                .into(),
            op: Some(Op::OpenWrite),
            decision: Decision::Deny,
            reason: Some(Reason::DlpMatch),
        });
        let mut p = Policy::new(doc);
        let v = p.decide(
            12001,
            "/srv/accounts/acme-school/instances/tutor-bot-7/workspace/blocked/x",
            Op::OpenWrite,
        );
        assert_eq!(v.decision, Decision::Deny);
        assert_eq!(v.reason, Reason::DlpMatch);
    }
}
