//! `SYNAPS_SESSION_CONTEXT` file writer (spec §8; A0/B0 path; HS-2/HS-7).
//!
//! The guest agent writes the context as a FILE keyed by `session_id` because
//! SynapsCLI strips env vars at extension spawn (`env_clear()` + 5-var
//! allowlist, `process.rs:643-648`) — confirmed in `docs/contract.md` §3. The
//! `pria-session-context` plugin reads this exact file on `on_session_start`.
//!
//! Canonical write path (plugin resolution order #1):
//!   `${XDG_RUNTIME_DIR}/synaps/sessions/<id>/context.json`
//! Fallback when `XDG_RUNTIME_DIR` is unset:
//!   `<run_root>/sessions/<id>/context.json` (the spec §6.4 `context_path`),
//!   additionally mirrored to `${HOME}/.synaps-cli/sessions/<id>/context.json`.

use std::path::{Path, PathBuf};

use chrono::{Duration, Utc};
use serde::Serialize;
use serde_json::Value;

use crate::error::{ErrorCode, GuestAgentError};

/// The session context written to disk. Satisfies
/// `pria-session-context-plugin/docs/session-context.schema.json`.
#[derive(Debug, Clone, Serialize)]
pub struct SessionContext {
    pub account_id: String,
    pub instance_id: String,
    pub user_id: String,
    pub vm_id: String,
    pub replica_id: String,
    pub session_id: String,
    pub linux_username: String,
    pub linux_uid: u32,
    pub linux_gid: u32,
    pub roles: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_hash: Option<String>,
    pub pria_base_url: String,
    pub audit_endpoint: String,
    pub credential_broker_endpoint: String,
    pub transport: Value,
    pub issued_at: String,
    pub expires_at: String,
    pub created_at: String,
}

/// Where the context was written + the env value to set on the synaps parent.
#[derive(Debug, Clone)]
pub struct WrittenContext {
    /// Primary path (also used as the spec §6.4 `context_path` response field).
    pub path: PathBuf,
    /// All paths written (primary + mirrors).
    pub mirrors: Vec<PathBuf>,
}

impl SessionContext {
    /// Validate that no long-lived secret leaks into the context (spec §16.3).
    fn assert_no_secrets(&self) -> Result<(), GuestAgentError> {
        // The struct is closed; transport.token must never be an inline secret.
        if let Some(obj) = self.transport.as_object() {
            if obj.contains_key("token") || obj.contains_key("secret") {
                return Err(GuestAgentError::new(
                    ErrorCode::InvalidRequest,
                    "session context transport must not carry inline secrets",
                ));
            }
        }
        Ok(())
    }
}

/// Compute the candidate context paths (primary first), honoring
/// `XDG_RUNTIME_DIR`/`HOME` exactly as the plugin's resolver does.
pub fn context_paths(
    session_id: &str,
    run_root: &Path,
    xdg_runtime_dir: Option<&str>,
    home: Option<&str>,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let rel = Path::new("synaps")
        .join("sessions")
        .join(session_id)
        .join("context.json");
    match xdg_runtime_dir {
        Some(xdg) if !xdg.is_empty() => paths.push(Path::new(xdg).join(&rel)),
        _ => paths.push(
            run_root
                .join("sessions")
                .join(session_id)
                .join("context.json"),
        ),
    }
    if let Some(h) = home {
        if !h.is_empty() {
            paths.push(
                Path::new(h)
                    .join(".synaps-cli")
                    .join("sessions")
                    .join(session_id)
                    .join("context.json"),
            );
        }
    }
    paths
}

/// Write the session context to its canonical path(s). Files are created 0600.
pub fn write_context(
    ctx: &SessionContext,
    run_root: &Path,
) -> Result<WrittenContext, GuestAgentError> {
    ctx.assert_no_secrets()?;

    let xdg = std::env::var("XDG_RUNTIME_DIR").ok();
    let home = std::env::var("HOME").ok();
    let paths = context_paths(&ctx.session_id, run_root, xdg.as_deref(), home.as_deref());

    let json = serde_json::to_vec_pretty(ctx)
        .map_err(|e| GuestAgentError::internal(format!("serialize context: {e}")))?;

    let mut written = Vec::new();
    for path in &paths {
        if let Some(parent) = path.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        if std::fs::write(path, &json).is_ok() {
            set_mode_0600(path);
            written.push(path.clone());
        }
    }

    if written.is_empty() {
        return Err(GuestAgentError::internal(
            "failed to write session context to any candidate path",
        ));
    }
    Ok(WrittenContext {
        path: written[0].clone(),
        mirrors: written,
    })
}

#[cfg(unix)]
fn set_mode_0600(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_mode_0600(_path: &Path) {}

/// Build a context with the standard issued/expiry/timestamps. `ttl_minutes`
/// bounds `expires_at`.
#[allow(clippy::too_many_arguments)]
pub fn now_timestamps(ttl_minutes: i64) -> (String, String, String) {
    let now = Utc::now();
    let exp = now + Duration::minutes(ttl_minutes.max(1));
    (now.to_rfc3339(), exp.to_rfc3339(), now.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample(session_id: &str) -> SessionContext {
        let (issued, expires, created) = now_timestamps(60);
        SessionContext {
            account_id: "acct_123".into(),
            instance_id: "inst_456".into(),
            user_id: "user_789".into(),
            vm_id: "vm_456".into(),
            replica_id: "replica_0".into(),
            session_id: session_id.into(),
            linux_username: "pria_u_104251".into(),
            linux_uid: 104251,
            linux_gid: 104251,
            roles: vec!["agent_operator".into()],
            policy_profile_id: Some("policy_default".into()),
            policy_version: Some(17),
            policy_hash: Some("sha256:abc".into()),
            pria_base_url: "https://pria.example".into(),
            audit_endpoint: "/internal/agentic-vm/audit".into(),
            credential_broker_endpoint: "/internal/agentic-vm/credential-request".into(),
            transport: json!({"kind": "pria-agent-websocket"}),
            issued_at: issued,
            expires_at: expires,
            created_at: created,
        }
    }

    #[test]
    fn primary_path_uses_xdg_when_present() {
        let p = context_paths(
            "sess_a",
            Path::new("/run/pria"),
            Some("/run/user/1000"),
            None,
        );
        assert_eq!(
            p[0],
            PathBuf::from("/run/user/1000/synaps/sessions/sess_a/context.json")
        );
    }

    #[test]
    fn primary_path_falls_back_to_run_root() {
        let p = context_paths("sess_a", Path::new("/run/pria"), None, Some("/home/x"));
        assert_eq!(
            p[0],
            PathBuf::from("/run/pria/sessions/sess_a/context.json")
        );
        assert_eq!(
            p[1],
            PathBuf::from("/home/x/.synaps-cli/sessions/sess_a/context.json")
        );
    }

    #[test]
    fn write_then_read_back_validates_required_fields() {
        let tmp = std::env::temp_dir().join(format!("ga-ctx-{}", uuid::Uuid::new_v4()));
        let ctx = sample("sess_w");
        let written = write_context(&ctx, &tmp).unwrap();
        let raw = std::fs::read_to_string(&written.path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        for f in [
            "account_id",
            "instance_id",
            "user_id",
            "linux_username",
            "linux_uid",
            "vm_id",
            "session_id",
            "roles",
            "issued_at",
            "expires_at",
        ] {
            assert!(v.get(f).is_some(), "missing required field {f}");
        }
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn rejects_inline_transport_secret() {
        let mut ctx = sample("sess_s");
        ctx.transport = json!({"kind": "x", "token": "long-lived-secret"});
        let tmp = std::env::temp_dir().join("ga-ctx-secret");
        assert!(write_context(&ctx, &tmp).is_err());
    }
}
