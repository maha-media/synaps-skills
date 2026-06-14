//! Compile the spec §6.6 `policy/apply` document into an fsmon [`PolicyDoc`].
//!
//! Validation is **fail-closed** (spec §16.3 "fail open on invalid policy =
//! never"): any structural problem returns an error and nothing is applied.

use serde::Deserialize;

use super::types::{Decision, PolicyDoc, Rule};

/// The spec §6.6 inbound policy document.
#[derive(Debug, Clone, Deserialize)]
pub struct ApplyPolicyRequest {
    pub account_id: String,
    #[serde(default)]
    pub policy_profile_id: Option<String>,
    #[serde(default)]
    pub policy_version: Option<u64>,
    pub policy_hash: String,
    #[serde(default)]
    pub compiled_from: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    pub rules: PolicyRules,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PolicyRules {
    #[serde(default)]
    pub filesystem: Option<FilesystemRules>,
    #[serde(default)]
    pub tools: Option<ToolRules>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FilesystemRules {
    pub default: String,
    #[serde(default)]
    pub deny: Vec<String>,
    #[serde(default)]
    pub observe: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolRules {
    #[serde(default)]
    pub credential_required: Vec<String>,
}

/// A compiled policy ready to apply + the validated hash.
#[derive(Debug, Clone)]
pub struct CompiledPolicy {
    pub doc: PolicyDoc,
    pub policy_hash: String,
    pub credential_required_tools: Vec<String>,
}

/// Validate + compile. Returns `Err(reason)` (fail-closed) on any problem.
pub fn compile(req: &ApplyPolicyRequest) -> Result<CompiledPolicy, String> {
    // 1. policy_hash must be present and look like a sha256 digest.
    let hash = req.policy_hash.trim();
    if hash.is_empty() {
        return Err("policy_hash is required".to_string());
    }
    if !(hash.starts_with("sha256:") && hash.len() > "sha256:".len()) {
        return Err("policy_hash must be a 'sha256:<hex>' value".to_string());
    }

    // 2. mode, if present, must be a known enforcement mode.
    if let Some(mode) = &req.mode {
        if !matches!(mode.as_str(), "block" | "observe" | "allow") {
            return Err(format!("unknown policy mode '{mode}'"));
        }
    }

    // 3. filesystem rules required + default must be allow/deny.
    let fs = req
        .rules
        .filesystem
        .as_ref()
        .ok_or_else(|| "rules.filesystem is required".to_string())?;
    let default_decision = match fs.default.as_str() {
        "allow" => Decision::Allow,
        "deny" => Decision::Deny,
        other => {
            return Err(format!(
                "filesystem.default must be allow|deny, got '{other}'"
            ))
        }
    };

    // 4. deny/observe entries must be absolute, non-empty paths or glob roots.
    let mut rules: Vec<Rule> = Vec::new();
    for pattern in &fs.deny {
        let prefix = glob_to_prefix(pattern)?;
        rules.push(Rule {
            uid: None,
            path_prefix: prefix,
            op: None,
            decision: Decision::Deny,
            reason: Some("policy_rule".to_string()),
        });
    }
    // observe entries are recorded as high-risk prefixes so the daemon logs them.
    let mut high_risk: Vec<String> = Vec::new();
    for pattern in &fs.observe {
        high_risk.push(glob_to_prefix(pattern)?);
    }

    let doc = PolicyDoc {
        default_decision,
        immutable_prefixes: Vec::new(),
        dlp_substrings: Vec::new(),
        rules,
        principals: Vec::new(),
        high_risk_prefixes: high_risk,
    };

    let credential_required_tools = req
        .rules
        .tools
        .as_ref()
        .map(|t| t.credential_required.clone())
        .unwrap_or_default();

    Ok(CompiledPolicy {
        doc,
        policy_hash: hash.to_string(),
        credential_required_tools,
    })
}

/// Convert a deny/observe glob like `/etc/**` or `/home/*/.ssh/**` into the
/// longest fixed path prefix the fsmon engine matches on. Rejects relative
/// paths (fail-closed).
fn glob_to_prefix(pattern: &str) -> Result<String, String> {
    if !pattern.starts_with('/') {
        return Err(format!("policy path '{pattern}' must be absolute"));
    }
    // Take components up to the first glob metacharacter.
    let mut prefix = String::new();
    for comp in pattern.split('/') {
        if comp.contains('*') || comp.contains('?') || comp.contains('[') {
            break;
        }
        if comp.is_empty() {
            continue;
        }
        prefix.push('/');
        prefix.push_str(comp);
    }
    if prefix.is_empty() {
        // pattern was something like `/**` — guard the whole tree.
        prefix.push('/');
    }
    Ok(prefix)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req(v: serde_json::Value) -> ApplyPolicyRequest {
        serde_json::from_value(v).unwrap()
    }

    fn valid() -> serde_json::Value {
        json!({
            "account_id": "acct_123",
            "policy_profile_id": "policy_default",
            "policy_version": 17,
            "policy_hash": "sha256:abc123",
            "compiled_from": "yaml",
            "mode": "block",
            "rules": {
                "filesystem": {"default": "allow", "deny": ["/etc/**", "/home/*/.ssh/**"], "observe": []},
                "tools": {"credential_required": ["slack", "github"]}
            }
        })
    }

    #[test]
    fn compiles_valid_policy() {
        let c = compile(&req(valid())).unwrap();
        assert_eq!(c.policy_hash, "sha256:abc123");
        assert_eq!(c.doc.default_decision, Decision::Allow);
        assert_eq!(c.doc.rules.len(), 2);
        assert_eq!(c.doc.rules[0].path_prefix, "/etc");
        assert_eq!(c.doc.rules[1].path_prefix, "/home");
        assert_eq!(c.credential_required_tools, vec!["slack", "github"]);
    }

    #[test]
    fn rejects_missing_hash() {
        let mut v = valid();
        v["policy_hash"] = json!("");
        assert!(compile(&req(v)).is_err());
    }

    #[test]
    fn rejects_bad_hash_shape() {
        let mut v = valid();
        v["policy_hash"] = json!("not-a-digest");
        assert!(compile(&req(v)).is_err());
    }

    #[test]
    fn rejects_unknown_mode() {
        let mut v = valid();
        v["mode"] = json!("nuke");
        assert!(compile(&req(v)).is_err());
    }

    #[test]
    fn rejects_bad_default() {
        let mut v = valid();
        v["rules"]["filesystem"]["default"] = json!("maybe");
        assert!(compile(&req(v)).is_err());
    }

    #[test]
    fn rejects_relative_deny_path() {
        let mut v = valid();
        v["rules"]["filesystem"]["deny"] = json!(["etc/passwd"]);
        assert!(compile(&req(v)).is_err());
    }
}
