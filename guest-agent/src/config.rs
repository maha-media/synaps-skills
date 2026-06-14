//! Configuration loader (spec §14).
//!
//! The config is YAML loaded from `PRIA_GUEST_AGENT_CONFIG`. Secrets are read
//! from files referenced by the config (never inlined — spec §16.3): the HMAC
//! secret comes from `pria.hmac_secret_file`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode, GuestAgentError};
use crate::ids::{AccountId, VmId};

fn default_route_prefix() -> String {
    "/guest/v1".to_string()
}

fn default_heartbeat_interval() -> u64 {
    15
}

fn default_skew() -> u64 {
    300
}

fn default_nonce_cache() -> u64 {
    300
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListenConfig {
    pub host: String,
    pub port: u16,
}

impl Default for ListenConfig {
    fn default() -> Self {
        Self {
            host: "0.0.0.0".to_string(),
            port: 47831,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriaConfig {
    pub base_url: String,
    pub hmac_key_id: String,
    pub hmac_secret_file: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathsConfig {
    pub efs_root: PathBuf,
    pub run_root: PathBuf,
    pub policy_dir: PathBuf,
    pub audit_spool_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SynapsConfig {
    pub binary: PathBuf,
    #[serde(default)]
    pub plugin_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsmonConfig {
    /// Control socket the guest agent connects to push policy (peer of
    /// `pria-fsmon-plugin/.../control.rs`).
    pub socket: PathBuf,
    /// Socket fsmon connects back to with NDJSON audit envelopes (GA-B8).
    #[serde(default)]
    pub forward_socket: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatConfig {
    #[serde(default = "default_heartbeat_interval")]
    pub interval_seconds: u64,
}

impl Default for HeartbeatConfig {
    fn default() -> Self {
        Self {
            interval_seconds: default_heartbeat_interval(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityConfig {
    #[serde(default = "default_skew")]
    pub max_timestamp_skew_seconds: u64,
    #[serde(default = "default_nonce_cache")]
    pub nonce_cache_seconds: u64,
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            max_timestamp_skew_seconds: default_skew(),
            nonce_cache_seconds: default_nonce_cache(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub mode: String,
    pub account_id: AccountId,
    pub vm_id: VmId,
    pub replica_id: String,
    #[serde(default)]
    pub listen: ListenConfig,
    #[serde(default = "default_route_prefix")]
    pub route_prefix: String,
    pub pria: PriaConfig,
    pub paths: PathsConfig,
    pub synaps: SynapsConfig,
    pub fsmon: FsmonConfig,
    #[serde(default)]
    pub heartbeat: HeartbeatConfig,
    #[serde(default)]
    pub security: SecurityConfig,
}

impl Config {
    /// Load a config from a YAML file path.
    pub fn load_from(path: impl AsRef<Path>) -> Result<Self, GuestAgentError> {
        let path = path.as_ref();
        let raw = std::fs::read_to_string(path).map_err(|e| {
            GuestAgentError::new(
                ErrorCode::InternalError,
                format!("failed to read config {}: {e}", path.display()),
            )
        })?;
        Self::from_yaml(&raw)
    }

    /// Parse a config from a YAML string.
    pub fn from_yaml(raw: &str) -> Result<Self, GuestAgentError> {
        serde_yaml::from_str(raw).map_err(|e| {
            GuestAgentError::new(ErrorCode::InvalidRequest, format!("invalid config: {e}"))
        })
    }

    /// Read the HMAC secret from the configured secret file.
    pub fn load_hmac_secret(&self) -> Result<Vec<u8>, GuestAgentError> {
        let raw = std::fs::read_to_string(&self.pria.hmac_secret_file).map_err(|e| {
            GuestAgentError::new(
                ErrorCode::InternalError,
                format!(
                    "failed to read hmac secret {}: {e}",
                    self.pria.hmac_secret_file.display()
                ),
            )
        })?;
        Ok(raw.trim().as_bytes().to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub const SAMPLE: &str = r#"
mode: local-virsh
account_id: acct_123
vm_id: vm_456
replica_id: replica_0
listen:
  host: 0.0.0.0
  port: 47831
pria:
  base_url: http://host.libvirt.internal:3000
  hmac_key_id: key_123
  hmac_secret_file: /etc/pria/guest-agent.hmac
paths:
  efs_root: /efs/accounts/acct_123
  run_root: /run/pria
  policy_dir: /efs/accounts/acct_123/policy
  audit_spool_dir: /efs/accounts/acct_123/audit-spool
synaps:
  binary: /usr/local/bin/synaps
  plugin_dir: /opt/synaps/plugins
fsmon:
  socket: /run/pria/fsmon.sock
heartbeat:
  interval_seconds: 15
security:
  max_timestamp_skew_seconds: 300
  nonce_cache_seconds: 300
"#;

    #[test]
    fn parses_spec_section_14_config() {
        let cfg = Config::from_yaml(SAMPLE).unwrap();
        assert_eq!(cfg.mode, "local-virsh");
        assert_eq!(cfg.account_id.as_str(), "acct_123");
        assert_eq!(cfg.vm_id.as_str(), "vm_456");
        assert_eq!(cfg.listen.port, 47831);
        assert_eq!(cfg.route_prefix, "/guest/v1");
        assert_eq!(cfg.heartbeat.interval_seconds, 15);
        assert_eq!(cfg.security.max_timestamp_skew_seconds, 300);
        assert_eq!(cfg.pria.hmac_key_id, "key_123");
    }

    #[test]
    fn defaults_apply_for_optional_blocks() {
        let minimal = r#"
mode: local-virsh
account_id: acct_1
vm_id: vm_1
replica_id: r0
pria:
  base_url: http://x
  hmac_key_id: k
  hmac_secret_file: /tmp/s
paths:
  efs_root: /efs
  run_root: /run/pria
  policy_dir: /efs/policy
  audit_spool_dir: /efs/spool
synaps:
  binary: /bin/true
fsmon:
  socket: /run/fsmon.sock
"#;
        let cfg = Config::from_yaml(minimal).unwrap();
        assert_eq!(cfg.listen.port, 47831);
        assert_eq!(cfg.heartbeat.interval_seconds, 15);
        assert_eq!(cfg.security.nonce_cache_seconds, 300);
    }
}
