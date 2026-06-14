//! Version detection (HS-9 mitigation).
//!
//! SynapsCLI exposes no stable "report versions" core API; scraping internals
//! would be fragile core coupling. Instead the guest agent derives versions from
//! the installed binaries' `--version` output and the plugin-bundle manifest
//! files (read-only). This keeps the guest agent fully outside SynapsCLI core.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

use crate::config::Config;

/// The guest-agent crate version (compile-time).
pub const GUEST_AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize)]
pub struct Versions {
    pub guest_agent_version: String,
    pub synaps_version: Option<String>,
    pub fsmon_version: Option<String>,
    pub plugin_bundle_version: Option<String>,
}

/// Run `<bin> --version` and return the trimmed first line (best-effort).
fn binary_version(bin: &Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.lines().next().map(|l| l.trim().to_string())
}

/// Read a plugin-bundle manifest version from a `plugin.json` (read-only).
fn bundle_version(plugin_dir: &Path) -> Option<String> {
    // Look for a top-level bundle manifest; tolerate either a single plugin.json
    // or a bundle manifest with a `version` field.
    for name in ["bundle.json", "plugin.json", ".synaps-plugin/plugin.json"] {
        let path = plugin_dir.join(name);
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(ver) = v.get("version").and_then(|x| x.as_str()) {
                    return Some(ver.to_string());
                }
            }
        }
    }
    None
}

impl Versions {
    /// Detect versions from the configured binaries/bundle. Never fails — any
    /// component that cannot be probed is reported as `None`.
    pub fn detect(config: &Config) -> Self {
        let synaps_version = binary_version(&config.synaps.binary);
        let plugin_bundle_version = config.synaps.plugin_dir.as_deref().and_then(bundle_version);
        Versions {
            guest_agent_version: GUEST_AGENT_VERSION.to_string(),
            synaps_version,
            // fsmon version is probed lazily via its control socket / binary; the
            // guest agent reports None until fsmon status is wired (GA-B8).
            fsmon_version: None,
            plugin_bundle_version,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_agent_version_is_present() {
        assert!(!GUEST_AGENT_VERSION.is_empty());
    }

    #[test]
    fn missing_binary_yields_none() {
        assert_eq!(binary_version(Path::new("/nonexistent/xyzzy")), None);
    }

    #[test]
    fn bundle_version_reads_manifest() {
        let dir = std::env::temp_dir().join(format!("ga-bundle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("bundle.json"), r#"{"version":"2.3.4"}"#).unwrap();
        assert_eq!(bundle_version(&dir), Some("2.3.4".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }
}
