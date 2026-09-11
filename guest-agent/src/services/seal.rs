//! Artifact sealing (VM-Sites §7 B1 "Seal only declared deployable output").
//!
//! Walks `outputDir` (which must resolve inside `workdir`) and returns a
//! deterministic manifest `[{path, size, sha256}]` sorted by path (byte
//! order, `/` separators), skipping dot-prefixed entries and symlinks. Bounds
//! (`maxFiles`, `maxBytes`) are enforced while walking so an oversized tree
//! is refused with a typed error before it is fully hashed.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::paths::{has_no_traversal, is_under};

/// One sealed file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SealedFile {
    /// Relative to `outputDir`, `/`-separated.
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// The manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SealManifest {
    pub files: Vec<SealedFile>,
    pub total_bytes: u64,
}

#[derive(Debug)]
pub enum SealError {
    /// Bad `outputDir` (escape, missing, not a directory, traversal).
    Invalid(String),
    /// `maxFiles` / `maxBytes` exceeded.
    Bounds(String),
    Io(String),
}

impl std::fmt::Display for SealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SealError::Invalid(e) | SealError::Bounds(e) | SealError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for SealError {}

/// Resolve `output_dir` (absolute or relative to `workdir`) and prove it is
/// inside the canonical `workdir`. Returns the canonical output dir.
pub fn resolve_output_dir(workdir: &Path, output_dir: &Path) -> Result<PathBuf, SealError> {
    if !has_no_traversal(output_dir) {
        return Err(SealError::Invalid(format!(
            "outputDir {} contains '..' traversal",
            output_dir.display()
        )));
    }
    let joined = if output_dir.is_absolute() {
        output_dir.to_path_buf()
    } else {
        workdir.join(output_dir)
    };
    let canon_wd = std::fs::canonicalize(workdir).map_err(|e| {
        SealError::Invalid(format!("workdir {} unavailable: {e}", workdir.display()))
    })?;
    let canon = std::fs::canonicalize(&joined).map_err(|e| {
        SealError::Invalid(format!("outputDir {} unavailable: {e}", joined.display()))
    })?;
    if !canon.is_dir() {
        return Err(SealError::Invalid(format!(
            "outputDir {} is not a directory",
            joined.display()
        )));
    }
    if !is_under(&canon_wd, &canon) {
        return Err(SealError::Invalid(format!(
            "outputDir {} resolves outside workdir",
            joined.display()
        )));
    }
    Ok(canon)
}

/// Seal `output_dir`. `max_files`/`max_bytes` are the effective bounds (the
/// caller already clamped them to the configured ceilings).
pub fn seal(
    output_dir: &Path,
    max_files: usize,
    max_bytes: u64,
) -> Result<SealManifest, SealError> {
    // Collect candidate paths first (sorted), then hash — the file list is
    // bounded before any hashing happens.
    let mut rel_paths: Vec<PathBuf> = Vec::new();
    collect(output_dir, Path::new(""), &mut rel_paths, max_files)?;
    rel_paths.sort_by(|a, b| rel_string(a).as_bytes().cmp(rel_string(b).as_bytes()));

    let mut files = Vec::with_capacity(rel_paths.len());
    let mut total: u64 = 0;
    let mut buf = vec![0u8; 64 * 1024];
    for rel in rel_paths {
        let abs = output_dir.join(&rel);
        // Re-check at open time: a symlink swapped in after the walk is still
        // refused (symlink_metadata never follows).
        let meta = std::fs::symlink_metadata(&abs)
            .map_err(|e| SealError::Io(format!("{}: {e}", rel.display())))?;
        if !meta.is_file() {
            continue;
        }
        let mut f = std::fs::File::open(&abs)
            .map_err(|e| SealError::Io(format!("{}: {e}", rel.display())))?;
        let mut hasher = Sha256::new();
        let mut size: u64 = 0;
        loop {
            let n = f
                .read(&mut buf)
                .map_err(|e| SealError::Io(format!("{}: {e}", rel.display())))?;
            if n == 0 {
                break;
            }
            size += n as u64;
            if total + size > max_bytes {
                return Err(SealError::Bounds(format!(
                    "output exceeds maxBytes {max_bytes}"
                )));
            }
            hasher.update(&buf[..n]);
        }
        total += size;
        files.push(SealedFile {
            path: rel_string(&rel),
            size,
            sha256: hex::encode(hasher.finalize()),
        });
    }
    Ok(SealManifest {
        files,
        total_bytes: total,
    })
}

fn rel_string(p: &Path) -> String {
    p.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn collect(
    root: &Path,
    rel: &Path,
    out: &mut Vec<PathBuf>,
    max_files: usize,
) -> Result<(), SealError> {
    let dir = root.join(rel);
    let entries = std::fs::read_dir(&dir)
        .map_err(|e| SealError::Io(format!("read {}: {e}", dir.display())))?;
    for entry in entries {
        let entry = entry.map_err(|e| SealError::Io(e.to_string()))?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        let ft = entry
            .file_type()
            .map_err(|e| SealError::Io(e.to_string()))?;
        if ft.is_symlink() {
            continue;
        }
        let child_rel = rel.join(&name);
        if ft.is_dir() {
            collect(root, &child_rel, out, max_files)?;
        } else if ft.is_file() {
            out.push(child_rel);
            if out.len() > max_files {
                return Err(SealError::Bounds(format!(
                    "output exceeds maxFiles {max_files}"
                )));
            }
        }
        // Other types (sockets, fifos, devices) are never sealed.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("ga-seal-{}", uuid::Uuid::new_v4()));
        let wd = base.join("work");
        let dist = wd.join("dist");
        std::fs::create_dir_all(dist.join("assets")).unwrap();
        std::fs::create_dir_all(dist.join(".hidden")).unwrap();
        std::fs::write(dist.join("index.html"), "<html>hi</html>").unwrap();
        std::fs::write(dist.join("assets/app.js"), "console.log(1)").unwrap();
        std::fs::write(dist.join(".DS_Store"), "junk").unwrap();
        std::fs::write(dist.join(".hidden/secret"), "junk").unwrap();
        std::fs::write(base.join("outside.txt"), "outside").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("outside.txt"), dist.join("link.txt")).unwrap();
            std::os::unix::fs::symlink(&base, wd.join("escape")).unwrap();
        }
        (wd, dist)
    }

    #[test]
    fn manifest_is_sorted_deterministic_and_skips_dot_and_symlinks() {
        let (wd, _) = fixture();
        let out = resolve_output_dir(&wd, Path::new("dist")).unwrap();
        let m1 = seal(&out, 100, 1 << 20).unwrap();
        let m2 = seal(&out, 100, 1 << 20).unwrap();
        assert_eq!(m1, m2, "sealing is deterministic");
        let paths: Vec<&str> = m1.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["assets/app.js", "index.html"]);
        assert_eq!(m1.total_bytes, 14 + 15);
        // sha256("<html>hi</html>")
        assert_eq!(
            m1.files[1].sha256,
            hex::encode(Sha256::digest(b"<html>hi</html>"))
        );
        assert_eq!(m1.files[1].size, 15);
        std::fs::remove_dir_all(wd.parent().unwrap()).ok();
    }

    #[test]
    fn bounds_are_typed() {
        let (wd, _) = fixture();
        let out = resolve_output_dir(&wd, Path::new("dist")).unwrap();
        assert!(matches!(seal(&out, 1, 1 << 20), Err(SealError::Bounds(_))));
        assert!(matches!(seal(&out, 100, 10), Err(SealError::Bounds(_))));
        assert!(seal(&out, 2, 29).is_ok());
        std::fs::remove_dir_all(wd.parent().unwrap()).ok();
    }

    #[test]
    fn output_dir_must_resolve_inside_workdir() {
        let (wd, dist) = fixture();
        assert!(resolve_output_dir(&wd, &dist).is_ok(), "absolute inside ok");
        assert!(resolve_output_dir(&wd, Path::new("../")).is_err());
        assert!(resolve_output_dir(&wd, Path::new("dist/../..")).is_err());
        assert!(resolve_output_dir(&wd, Path::new("/etc")).is_err());
        assert!(resolve_output_dir(&wd, Path::new("missing")).is_err());
        assert!(
            resolve_output_dir(&wd, Path::new("dist/index.html")).is_err(),
            "a file is not an output dir"
        );
        #[cfg(unix)]
        assert!(
            resolve_output_dir(&wd, Path::new("escape")).is_err(),
            "symlink to outside must be refused"
        );
        std::fs::remove_dir_all(wd.parent().unwrap()).ok();
    }
}
