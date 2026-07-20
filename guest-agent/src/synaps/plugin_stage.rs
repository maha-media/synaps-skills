//! Extension staging: validate, resolve, and symlink plugins into a per-session
//! `synaps-base/plugins/` directory, then set `SYNAPS_BASE_DIR` so the synaps
//! child discovers them (agent-runtime contract §Q2).
//!
//! Discovery path used by the runtime:
//!   `$SYNAPS_BASE_DIR/plugins/<name>/.synaps-plugin/plugin.json`
//!
//! This module creates:
//!   `<session_dir>/synaps-base/plugins/<name>` → `<plugin_store>/<name>`
//!   (symlink; the whole bundle including compiled binaries is preserved.)

use std::path::{Path, PathBuf};

use crate::api::sessions::ExtensionRef;
use crate::error::{ErrorCode, GuestAgentError};

/// Regex-equivalent name rule: `^[a-z0-9][a-z0-9-]{0,63}$`.
///
/// Enforced character-by-character to avoid pulling in a regex crate.
fn is_valid_extension_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    let mut chars = name.chars();
    // First char: [a-z0-9]
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    // Remaining: [a-z0-9-]
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Stage each extension from `plugin_store` into `<session_dir>/synaps-base/plugins/`.
///
/// Creates `<session_dir>/synaps-base/` (mode 0700, owned by `uid`) and
/// `<session_dir>/synaps-base/plugins/` with a symlink per extension pointing
/// to the bundle in `plugin_store`.
///
/// Returns the `synaps-base` directory path, which the caller exports as
/// `SYNAPS_BASE_DIR` in the session environment.
///
/// # Errors
/// - `InvalidRequest` if any name fails the `^[a-z0-9][a-z0-9-]{0,63}$` check.
/// - `InvalidRequest` if the plugin bundle or its manifest is absent in `plugin_store`.
/// - `InternalError` if filesystem operations fail.
pub fn stage_extensions(
    extensions: &[ExtensionRef],
    session_dir: &Path,
    plugin_store: &Path,
    uid: u32,
) -> Result<PathBuf, GuestAgentError> {
    let synaps_base = session_dir.join("synaps-base");
    let plugins_dir = synaps_base.join("plugins");

    // Validate all names first — fail early before touching the filesystem.
    for ext in extensions {
        if !is_valid_extension_name(&ext.name) {
            return Err(GuestAgentError::new(
                ErrorCode::InvalidRequest,
                format!(
                    "extension name {:?} is invalid; must match ^[a-z0-9][a-z0-9-]{{0,63}}$",
                    ext.name
                ),
            ));
        }
    }

    // Validate bundles exist in the plugin store.
    for ext in extensions {
        let bundle = plugin_store.join(&ext.name);
        let manifest = bundle.join(".synaps-plugin").join("plugin.json");
        if !manifest.exists() {
            return Err(GuestAgentError::new(
                ErrorCode::InvalidRequest,
                format!(
                    "extension {:?}: manifest not found at {}",
                    ext.name,
                    manifest.display()
                ),
            ));
        }
    }

    // Create <session_dir>/synaps-base/plugins/.
    std::fs::create_dir_all(&plugins_dir).map_err(|e| {
        GuestAgentError::internal(format!(
            "failed to create plugins dir {}: {e}",
            plugins_dir.display()
        ))
    })?;
    // The hardened runtime umask (077) would leave plugins/ at 0700 root — the
    // dropped-privilege synaps process could then neither list the staged
    // symlinks nor resolve them. 0755: world-readable staging index; the
    // bundles behind the symlinks live in the root-owned read-only store.
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&plugins_dir, std::fs::Permissions::from_mode(0o755)).map_err(
            |e| {
                GuestAgentError::internal(format!(
                    "failed to set mode on plugins dir {}: {e}",
                    plugins_dir.display()
                ))
            },
        )?;
    }

    // Symlink each extension bundle.
    for ext in extensions {
        let target = plugin_store.join(&ext.name);
        let link = plugins_dir.join(&ext.name);

        // Remove a stale link if it already exists (idempotent re-staging).
        if link.exists() || link.symlink_metadata().is_ok() {
            std::fs::remove_file(&link).map_err(|e| {
                GuestAgentError::internal(format!(
                    "failed to remove stale link {}: {e}",
                    link.display()
                ))
            })?;
        }

        std::os::unix::fs::symlink(&target, &link).map_err(|e| {
            GuestAgentError::internal(format!(
                "failed to symlink {} → {}: {e}",
                link.display(),
                target.display()
            ))
        })?;
    }

    // chown <session_dir>/synaps-base to uid; gid u32::MAX == (gid_t)-1 = unchanged.
    // SAFETY: valid NUL-terminated path; gid u32::MAX == (gid_t)-1 = unchanged.
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&synaps_base, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| {
                GuestAgentError::internal(format!(
                    "failed to set mode on synaps-base {}: {e}",
                    synaps_base.display()
                ))
            })?;
        let c_path =
            std::ffi::CString::new(synaps_base.as_os_str().as_encoded_bytes()).map_err(|e| {
                GuestAgentError::internal(format!("synaps-base path contains NUL byte: {e}"))
            })?;
        let _ = unsafe { libc::chown(c_path.as_ptr(), uid, u32::MAX) };
    }

    Ok(synaps_base)
}
