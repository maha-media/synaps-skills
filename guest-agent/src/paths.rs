//! Path-safety helpers (spec §13.5, §16.1).
//!
//! Reused by principal home-dir validation (GA-B5) and session/workspace dir
//! validation (GA-B6). Validation is lexical (no filesystem access) so it cannot
//! be defeated by symlink races at check time — callers additionally create dirs
//! with explicit ownership.

use std::path::{Component, Path, PathBuf};

/// Lexically normalise a path, resolving `.`/`..` without touching the FS.
/// A leading `..` that would escape the root is dropped (cannot ascend above /).
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// True if `path` contains no `..` traversal component (raw, before normalise).
pub fn has_no_traversal(path: &Path) -> bool {
    !path.components().any(|c| matches!(c, Component::ParentDir))
}

/// True if (the normalised) `path` is `root` or strictly under `root`.
pub fn is_under(root: &Path, path: &Path) -> bool {
    let root = normalize(root);
    let path = normalize(path);
    path == root || path.starts_with(&root)
}

/// Validate that `path` is absolute, traversal-free, and under `root`.
pub fn ensure_under(root: &Path, path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!("path {} must be absolute", path.display()));
    }
    if !has_no_traversal(path) {
        return Err(format!("path {} contains '..' traversal", path.display()));
    }
    if !is_under(root, path) {
        return Err(format!(
            "path {} is outside allowed root {}",
            path.display(),
            root.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_resolves_dot_segments() {
        assert_eq!(
            normalize(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
    }

    #[test]
    fn traversal_detected() {
        assert!(!has_no_traversal(Path::new("/a/../b")));
        assert!(has_no_traversal(Path::new("/a/b/c")));
    }

    #[test]
    fn is_under_respects_boundaries() {
        let root = Path::new("/efs/accounts/acct_1");
        assert!(is_under(root, Path::new("/efs/accounts/acct_1/sessions/x")));
        assert!(!is_under(root, Path::new("/efs/accounts/acct_2/x")));
    }

    #[test]
    fn ensure_under_rejects_escape_and_relative() {
        let root = Path::new("/efs/acct_1");
        assert!(ensure_under(root, Path::new("/efs/acct_1/w")).is_ok());
        assert!(ensure_under(root, Path::new("/efs/acct_1/../acct_2")).is_err());
        assert!(ensure_under(root, Path::new("relative/x")).is_err());
        assert!(ensure_under(root, Path::new("/etc/passwd")).is_err());
    }
}
