//! fsmon control-socket wire types — the guest-agent peer of
//! `pria-fsmon-plugin/extensions/synaps-fsmon/src/control.rs` and `policy.rs`.
//!
//! These structs MUST stay serde-compatible with the fsmon crate (snake_case,
//! tagged `ControlRequest`). The fsmon crate has no published `[lib]`, so the
//! wire contract is mirrored here; the round-trip is asserted in tests and by
//! the GA-B9 integration check against the real daemon.

use serde::{Deserialize, Serialize};

/// Mirrors `fsmon::policy::Decision`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Deny,
}

/// Mirrors `fsmon::policy::Op`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    OpenWrite,
    OpenRead,
    Access,
}

/// Mirrors `fsmon::policy::Principal`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Principal {
    pub uid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vm_id: Option<String>,
    #[serde(default)]
    pub instance_roots: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_root: Option<String>,
}

/// Mirrors `fsmon::policy::Rule`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<u32>,
    pub path_prefix: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<Op>,
    pub decision: Decision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Mirrors `fsmon::policy::PolicyDoc`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyDoc {
    pub default_decision: Decision,
    #[serde(default)]
    pub immutable_prefixes: Vec<String>,
    #[serde(default)]
    pub dlp_substrings: Vec<String>,
    #[serde(default)]
    pub rules: Vec<Rule>,
    #[serde(default)]
    pub principals: Vec<Principal>,
    #[serde(default)]
    pub high_risk_prefixes: Vec<String>,
}

impl Default for PolicyDoc {
    fn default() -> Self {
        Self {
            default_decision: Decision::Allow,
            immutable_prefixes: Vec::new(),
            dlp_substrings: Vec::new(),
            rules: Vec::new(),
            principals: Vec::new(),
            high_risk_prefixes: Vec::new(),
        }
    }
}

/// Mirrors `fsmon::control::ControlRequest`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlRequest {
    PolicyApply { policy: PolicyDoc },
    Ping,
    Stats,
    SetDegraded { degraded: bool },
}

/// Mirrors `fsmon::control::ControlResponse`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlResponse {
    Ok {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_len: Option<usize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        principals: Option<usize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        degraded: Option<bool>,
    },
    Error {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_apply_serialises_like_fsmon_expects() {
        let req = ControlRequest::PolicyApply {
            policy: PolicyDoc {
                default_decision: Decision::Deny,
                principals: vec![Principal {
                    uid: 12001,
                    instance_roots: vec!["/srv/x".into()],
                    ..Default::default()
                }],
                ..Default::default()
            },
        };
        let s = serde_json::to_string(&req).unwrap();
        // Tag + snake_case fields exactly as fsmon's control.rs test expects.
        assert!(s.contains("\"type\":\"policy_apply\""));
        assert!(s.contains("\"default_decision\":\"deny\""));
        assert!(s.contains("\"uid\":12001"));
    }

    #[test]
    fn response_ok_roundtrips() {
        let line = r#"{"type":"ok","cache_len":3,"principals":2}"#;
        let resp: ControlResponse = serde_json::from_str(line).unwrap();
        match resp {
            ControlResponse::Ok { cache_len, .. } => assert_eq!(cache_len, Some(3)),
            _ => panic!("wrong variant"),
        }
    }
}
