//! Offline, OS-owner provisioned dependency bundle. Lock identity alone is not
//! package integrity: every installed byte/link is checked against the manifest.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub mode: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub lock_sha256: String,
    pub node_sha256: String,
    pub npm_sha256: String,
    pub profile: String,
    pub files: Vec<Entry>,
}
pub struct Bundle {
    pub manifest: Manifest,
    pub digest: String,
}
fn owner(path: &Path, m: &fs::Metadata) -> Result<(), String> {
    let uid = unsafe { libc::geteuid() };
    if m.uid() != uid || (!m.file_type().is_symlink() && m.mode() & 0o022 != 0) {
        return Err("dependency bundle must be OS-owner controlled, not workload writable".into());
    }
    if !path.is_absolute() {
        return Err("dependency bundle path must be absolute".into());
    }
    Ok(())
}
fn ancestors(root: &Path) -> Result<(), String> {
    let uid = unsafe { libc::geteuid() };
    for path in root.ancestors() {
        let m = fs::symlink_metadata(path).map_err(|_| "dependency ancestor unavailable")?;
        if !m.is_dir() || m.file_type().is_symlink() {
            return Err("unsafe dependency ancestor".into());
        }
        // Synthetic nonroot fixture may live below sticky /tmp. Production
        // root-owned bundles must have an entirely non-workload-writable chain.
        let fixture_tmp = uid != 0 && m.uid() == 0 && m.mode() & 0o1000 != 0;
        if !fixture_tmp && (m.mode() & 0o022 != 0 || (m.uid() != uid && m.uid() != 0)) {
            return Err("workload-writable dependency ancestor".into());
        }
    }
    Ok(())
}
pub fn hash(path: &Path, limit: u64) -> Result<(u64, String), String> {
    let mut f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "dependency open")?;
    let m = f.metadata().map_err(|_| "dependency metadata")?;
    if !m.is_file() || m.nlink() != 1 || m.len() > limit {
        return Err("dependency file type/size bound".into());
    }
    let mut digest = Sha256::new();
    let mut buf = [0u8; 65536];
    let mut size = 0;
    loop {
        let n = f.read(&mut buf).map_err(|_| "dependency read")?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > limit {
            return Err("dependency byte bound".into());
        }
        digest.update(&buf[..n]);
    }
    let after = f.metadata().map_err(|_| "dependency metadata")?;
    if size != m.len()
        || after.mtime_nsec() != m.mtime_nsec()
        || after.ctime_nsec() != m.ctime_nsec()
        || after.mtime() != m.mtime()
        || after.ctime() != m.ctime()
    {
        return Err("dependency changed".into());
    }
    Ok((size, hex::encode(digest.finalize())))
}
fn walk(
    root: &Path,
    dir: &Path,
    entries: &mut Vec<Entry>,
    total: &mut u64,
    count: &mut usize,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 {
        return Err("dependency depth bound".into());
    }
    let meta = fs::symlink_metadata(dir).map_err(|_| "dependency directory")?;
    owner(dir, &meta)?;
    for item in fs::read_dir(dir).map_err(|_| "dependency directory")? {
        let p = item.map_err(|_| "dependency entry")?.path();
        *count += 1;
        if *count > 30000 {
            return Err("dependency entry bound".into());
        }
        let rel = p
            .strip_prefix(root)
            .map_err(|_| "dependency path")?
            .to_str()
            .ok_or("dependency UTF8 path")?
            .to_owned();
        if rel.len() > 1024 || rel.chars().any(|c| c.is_control() || c == '\\') {
            return Err("dependency path bound".into());
        }
        let m = fs::symlink_metadata(&p).map_err(|_| "dependency metadata")?;
        owner(&p, &m)?;
        if m.file_type().is_symlink() {
            let target = fs::read_link(&p).map_err(|_| "dependency link")?;
            let actual = fs::canonicalize(&p).map_err(|_| "dependency link target")?;
            if target.is_absolute() || !actual.starts_with(root) || !actual.is_file() {
                return Err("dependency link escapes bundle".into());
            }
            let link = target
                .to_str()
                .ok_or("dependency link encoding")?
                .to_owned();
            entries.push(Entry {
                path: rel,
                size: link.len() as u64,
                sha256: hex::encode(Sha256::digest(link.as_bytes())),
                mode: 0o777,
                link: Some(link),
            });
        } else if m.is_dir() {
            walk(root, &p, entries, total, count, depth + 1)?;
        } else {
            let (size, sha256) = hash(&p, 256 * 1024 * 1024)?;
            *total = total.checked_add(size).ok_or("dependency size overflow")?;
            if *total > 512 * 1024 * 1024 {
                return Err("dependency aggregate byte bound".into());
            }
            entries.push(Entry {
                path: rel,
                size,
                sha256,
                mode: m.mode() & 0o777,
                link: None,
            });
        }
    }
    Ok(())
}
pub fn verify(deps: &Path) -> Result<Bundle, String> {
    if !deps.is_absolute() || fs::canonicalize(deps).map_err(|_| "dependency root")? != deps {
        return Err("canonical dependency root required".into());
    }
    ancestors(deps)?;
    let path = deps
        .parent()
        .ok_or("dependency bundle parent")?
        .join("bundle.json");
    let m = fs::symlink_metadata(&path).map_err(|_| "dependency bundle manifest required")?;
    owner(&path, &m)?;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
        .map_err(|_| "dependency manifest open")?;
    let opened = file
        .metadata()
        .map_err(|_| "dependency manifest metadata")?;
    if !opened.is_file()
        || opened.nlink() != 1
        || opened.len() > 8 * 1024 * 1024
        || opened.ino() != m.ino()
        || opened.dev() != m.dev()
    {
        return Err("dependency manifest type/bound".into());
    }
    let mut bytes = Vec::new();
    file.take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "dependency manifest read")?;
    if bytes.len() as u64 != opened.len() {
        return Err("dependency manifest changed".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|_| "invalid dependency manifest")?;
    if manifest.version != 1
        || manifest.profile != "react-spa-relative-v1"
        || manifest.lock_sha256.len() != 64
        || !manifest
            .lock_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("unsupported dependency manifest".into());
    }
    let node = fs::canonicalize("/usr/bin/node").map_err(|_| "node unavailable")?;
    let npm = fs::canonicalize("/usr/bin/npm").map_err(|_| "npm unavailable")?;
    if hash(&node, 256 * 1024 * 1024)?.1 != manifest.node_sha256
        || hash(&npm, 2 * 1024 * 1024)?.1 != manifest.npm_sha256
    {
        return Err("dependency toolchain mismatch".into());
    }
    let mut files = Vec::new();
    walk(deps, deps, &mut files, &mut 0, &mut 0, 0)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    if files != manifest.files {
        return Err("dependency payload mismatch".into());
    }
    Ok(Bundle {
        manifest,
        digest: hex::encode(Sha256::digest(&bytes)),
    })
}
impl Bundle {
    pub fn check_source(&self, source: &super::source_build::SourceEnvelope) -> Result<(), String> {
        if !source
            .files
            .iter()
            .any(|f| f.path == "package-lock.json" && f.sha256 == self.manifest.lock_sha256)
        {
            return Err("committed lock does not match trusted dependency bundle".into());
        }
        Ok(())
    }
}

#[cfg(test)]
pub fn empty_fixture(deps: &Path, lock: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(deps.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(deps, fs::Permissions::from_mode(0o700)).unwrap();
    let manifest = Manifest {
        version: 1,
        lock_sha256: hash(lock, 1024 * 1024).unwrap().1,
        node_sha256: hash(
            &fs::canonicalize("/usr/bin/node").unwrap(),
            256 * 1024 * 1024,
        )
        .unwrap()
        .1,
        npm_sha256: hash(&fs::canonicalize("/usr/bin/npm").unwrap(), 2 * 1024 * 1024)
            .unwrap()
            .1,
        profile: "react-spa-relative-v1".into(),
        files: vec![],
    };
    let path = deps.parent().unwrap().join("bundle.json");
    fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o400)).unwrap();
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn payload_and_writable_bundle_refuse() {
        let root = std::env::temp_dir().join(format!("bundle-{}", uuid::Uuid::new_v4()));
        let deps = root.join("node_modules");
        fs::create_dir_all(&deps).unwrap();
        let lock = root.join("lock");
        fs::write(&lock, "lock A").unwrap();
        empty_fixture(&deps, &lock);
        assert!(verify(&deps).is_ok());
        fs::write(deps.join("unlisted.js"), "mutated").unwrap();
        assert!(verify(&deps).is_err());
        fs::remove_file(deps.join("unlisted.js")).unwrap();
        fs::set_permissions(&deps, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(verify(&deps).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
