//! Trusted project-scope resolution (T33).
//!
//! The **model never chooses the project**. The canonical project key is
//! derived exclusively from trusted, host/local-controlled sources:
//!
//! 1. `SYNAPS_PROJECT_ROOT` — set by a Synaps host that forwards the
//!    session's project root to the extension environment.
//! 2. `AXEL_PROJECT_ROOT` — local override for tests / power users.
//! 3. The `project_root` key in the host-owned plugin config file
//!    (`$SYNAPS_BASE_DIR/plugins/axel-memory-manager/config`) — written via
//!    the Synaps settings UI, never by the model.
//!
//! When none of these yields a usable directory, there is **no trusted
//! project scope** and every memory tool fails closed with an explicit
//! error. A model-supplied `project` argument may only *confirm* the
//! derived canonical key — any mismatch is an error.

use std::path::{Path, PathBuf};

use crate::settings::Settings;

/// A resolved trusted project scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectScope {
    /// Canonicalized project root directory.
    pub root: PathBuf,
    /// Stable canonical key: `proj_` + first 16 hex of SHA-256(root path).
    pub key: String,
}

/// Derive the canonical project key for a canonicalized root path.
pub fn canonical_key(root: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(root.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    format!("proj_{}", hex::encode(&digest[..8]))
}

/// Resolve the trusted project scope, or `None` (fail closed).
///
/// The path must exist and be a directory; it is canonicalized (symlink
/// safe: two spellings of the same directory produce the same key).
pub fn resolve(settings: &Settings) -> Option<ProjectScope> {
    let raw = std::env::var_os("SYNAPS_PROJECT_ROOT")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("AXEL_PROJECT_ROOT").map(PathBuf::from))
        .or_else(|| settings.project_root.as_ref().map(PathBuf::from))?;
    let root = std::fs::canonicalize(&raw).ok()?;
    if !root.is_dir() {
        return None;
    }
    let key = canonical_key(&root);
    Some(ProjectScope { root, key })
}

/// Validate an optional model-supplied `project` argument against the
/// derived canonical key. `None`/empty = implicit confirmation.
pub fn confirm_project(scope: &ProjectScope, supplied: Option<&str>) -> Result<(), String> {
    match supplied {
        None => Ok(()),
        Some(s) if s.trim().is_empty() => Ok(()),
        Some(s) if s == scope.key => Ok(()),
        Some(s) => Err(format!(
            "project mismatch: supplied {s:?} but the trusted project scope for this \
             session is {:?} (derived from the host-configured project root; the model \
             cannot widen or switch project scope)",
            scope.key
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_key_is_stable_and_prefixed() {
        let k1 = canonical_key(Path::new("/tmp/some/project"));
        let k2 = canonical_key(Path::new("/tmp/some/project"));
        assert_eq!(k1, k2);
        assert!(k1.starts_with("proj_"));
        assert_eq!(k1.len(), 5 + 16);
        assert_ne!(k1, canonical_key(Path::new("/tmp/other/project")));
    }

    #[test]
    fn confirm_project_accepts_exact_or_absent_only() {
        let scope = ProjectScope {
            root: PathBuf::from("/x"),
            key: "proj_0011223344556677".into(),
        };
        assert!(confirm_project(&scope, None).is_ok());
        assert!(confirm_project(&scope, Some("")).is_ok());
        assert!(confirm_project(&scope, Some("proj_0011223344556677")).is_ok());
        assert!(confirm_project(&scope, Some("proj_ffffffffffffffff")).is_err());
        assert!(confirm_project(&scope, Some("/tmp/other")).is_err());
    }
}
