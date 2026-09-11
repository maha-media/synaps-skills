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

fn default_fleet_heartbeat_interval() -> u64 {
    30
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
    /// Root of the short, per-UID socket dir handed to Synaps RPC.
    ///
    /// Defaults to `/run/user`, which is what production uses and what the
    /// 108-byte AF_UNIX path limit demands. It is overridable ONLY so tests can
    /// exercise `/sessions/start` against a temp dir: chmod/chown on the real
    /// `/run/user` needs root, which made the whole start handler — including
    /// the RPC readiness handshake — unreachable in CI.
    #[serde(default = "default_synaps_runtime_root")]
    pub synaps_runtime_root: PathBuf,
}

fn default_synaps_runtime_root() -> PathBuf {
    PathBuf::from("/run/user")
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

/// Fleet callback config (W3.7-G): heartbeat cadence for bound fleet tasks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FleetConfig {
    #[serde(default = "default_fleet_heartbeat_interval")]
    pub heartbeat_interval_seconds: u64,
}

impl Default for FleetConfig {
    fn default() -> Self {
        Self {
            heartbeat_interval_seconds: default_fleet_heartbeat_interval(),
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

fn default_app_port_range_start() -> u16 {
    43000
}

fn default_app_port_range_end() -> u16 {
    43999
}

/// Default executable allowlist for `/services/start` `command[0]`.
pub fn default_app_command_allowlist() -> Vec<String> {
    [
        "npm", "pnpm", "yarn", "node", "npx", "python3", "vite", "serve",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn default_app_stop_grace_ms() -> u64 {
    5000
}

fn default_app_start_wait_ms() -> u64 {
    1500
}

fn default_app_max_readiness_timeout_ms() -> u64 {
    120_000
}

fn default_app_max_runtime_sec() -> u64 {
    21_600
}

fn default_app_max_services() -> usize {
    16
}

fn default_app_log_ring_max_bytes() -> usize {
    1024 * 1024
}

fn default_app_log_ring_max_entries() -> usize {
    5000
}

fn default_app_log_batch_max_entries() -> usize {
    200
}

fn default_app_log_batch_interval_ms() -> u64 {
    1000
}

fn default_app_seal_max_files() -> usize {
    4096
}

fn default_app_seal_max_bytes() -> u64 {
    64 * 1024 * 1024
}

/// App-service supervisor config (VM-Sites: managed dev/release processes,
/// `/guest/v1/services/*` + `/guest/v1/artifacts/seal`). Every value has a
/// bounded default so an omitted block is safe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppServicesConfig {
    /// Trusted installed plugin payload, production root-owned and not group writable.
    #[serde(default)]
    pub skill_pack_root: Option<PathBuf>,
    /// Trusted prepared dependencies; never selected by the request.
    #[serde(default)]
    pub source_build_dependencies: Option<PathBuf>,
    /// Predelegated cgroup v2 parent; never modifies its controller policy.
    #[serde(default)]
    pub source_build_cgroup_root: Option<PathBuf>,

    /// Trusted OS-owner storage, outside disposable sessions and /run.
    #[serde(default = "default_retained_root")]
    pub retained_root: PathBuf,
    /// First port (inclusive) of the private loopback range handed to services.
    #[serde(default = "default_app_port_range_start")]
    pub port_range_start: u16,
    /// Last port (inclusive) of the range.
    #[serde(default = "default_app_port_range_end")]
    pub port_range_end: u16,
    /// Bare executable names accepted as `command[0]` (never shell-interpreted).
    #[serde(default = "default_app_command_allowlist")]
    pub command_allowlist: Vec<String>,
    /// Root every `workdir` must resolve under (symlinks resolved). Defaults to
    /// `paths.efs_root` when omitted.
    #[serde(default)]
    pub workspace_root: Option<PathBuf>,
    /// SIGTERM → SIGKILL escalation window for stop/readiness-failure kills.
    #[serde(default = "default_app_stop_grace_ms")]
    pub stop_grace_ms: u64,
    /// How long `/services/start` waits for a readiness verdict before
    /// answering `starting` (keeps the caller under its own request timeout).
    #[serde(default = "default_app_start_wait_ms")]
    pub start_wait_ms: u64,
    /// Ceiling for the request's `readiness.timeoutMs`.
    #[serde(default = "default_app_max_readiness_timeout_ms")]
    pub max_readiness_timeout_ms: u64,
    /// Ceiling (and default) for the request's `limits.maxRuntimeSec`.
    #[serde(default = "default_app_max_runtime_sec")]
    pub max_runtime_sec: u64,
    /// Maximum number of concurrently live (non-terminal) services.
    #[serde(default = "default_app_max_services")]
    pub max_services: usize,
    /// Per-service log ring byte cap (ceiling for `limits.maxLogBytes`).
    #[serde(default = "default_app_log_ring_max_bytes")]
    pub log_ring_max_bytes: usize,
    /// Per-service log ring entry cap.
    #[serde(default = "default_app_log_ring_max_entries")]
    pub log_ring_max_entries: usize,
    /// `app-log` callback batching: flush at this many entries…
    #[serde(default = "default_app_log_batch_max_entries")]
    pub log_batch_max_entries: usize,
    /// …or after this many milliseconds since the first buffered entry.
    #[serde(default = "default_app_log_batch_interval_ms")]
    pub log_batch_interval_ms: u64,
    /// Ceiling for `/artifacts/seal` `maxFiles`.
    #[serde(default = "default_app_seal_max_files")]
    pub seal_max_files: usize,
    /// Ceiling for `/artifacts/seal` `maxBytes`.
    #[serde(default = "default_app_seal_max_bytes")]
    pub seal_max_bytes: u64,
}

fn default_retained_root() -> PathBuf {
    PathBuf::from("/var/lib/pria-guest-agent/retained-artifacts")
}

impl Default for AppServicesConfig {
    fn default() -> Self {
        Self {
            skill_pack_root: None,
            source_build_dependencies: None,
            source_build_cgroup_root: None,
            retained_root: default_retained_root(),
            port_range_start: default_app_port_range_start(),
            port_range_end: default_app_port_range_end(),
            command_allowlist: default_app_command_allowlist(),
            workspace_root: None,
            stop_grace_ms: default_app_stop_grace_ms(),
            start_wait_ms: default_app_start_wait_ms(),
            max_readiness_timeout_ms: default_app_max_readiness_timeout_ms(),
            max_runtime_sec: default_app_max_runtime_sec(),
            max_services: default_app_max_services(),
            log_ring_max_bytes: default_app_log_ring_max_bytes(),
            log_ring_max_entries: default_app_log_ring_max_entries(),
            log_batch_max_entries: default_app_log_batch_max_entries(),
            log_batch_interval_ms: default_app_log_batch_interval_ms(),
            seal_max_files: default_app_seal_max_files(),
            seal_max_bytes: default_app_seal_max_bytes(),
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
    pub fleet: FleetConfig,
    #[serde(default)]
    pub security: SecurityConfig,
    /// App-service supervisor (VM-Sites). Omitted block → bounded defaults.
    #[serde(default)]
    pub app_services: AppServicesConfig,
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
        // app_services block omitted → bounded defaults.
        assert_eq!(cfg.app_services.port_range_start, 43000);
        assert_eq!(cfg.app_services.port_range_end, 43999);
        assert!(cfg
            .app_services
            .command_allowlist
            .iter()
            .any(|c| c == "vite"));
        assert!(cfg.app_services.workspace_root.is_none());
        assert_eq!(cfg.app_services.stop_grace_ms, 5000);
        assert_eq!(cfg.app_services.max_services, 16);
    }

    #[test]
    fn example_config_parses_with_app_services_defaults() {
        let raw = include_str!("../config.example.yaml");
        let cfg = Config::from_yaml(raw).unwrap();
        assert_eq!(cfg.app_services, AppServicesConfig::default());
    }

    #[test]
    fn app_services_block_overrides_defaults() {
        let yaml = format!(
            "{SAMPLE}
app_services:
  port_range_start: 50000
  port_range_end: 50010
  command_allowlist: [node, sleep]
  workspace_root: /efs/ws
  stop_grace_ms: 250
"
        );
        let cfg = Config::from_yaml(&yaml).unwrap();
        assert_eq!(cfg.app_services.port_range_start, 50000);
        assert_eq!(cfg.app_services.port_range_end, 50010);
        assert_eq!(cfg.app_services.command_allowlist, vec!["node", "sleep"]);
        assert_eq!(
            cfg.app_services.workspace_root.as_deref(),
            Some(Path::new("/efs/ws"))
        );
        assert_eq!(cfg.app_services.stop_grace_ms, 250);
        // Untouched keys keep their defaults.
        assert_eq!(cfg.app_services.max_readiness_timeout_ms, 120_000);
    }
}
