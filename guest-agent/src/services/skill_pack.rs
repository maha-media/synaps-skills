//! Trusted installed payload attestation. No model-selected path or digest.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillPack {
    pub name: String,
    pub version: String,
    pub profile: String,
    pub digest: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor {
    name: String,
    version: String,
    profile: String,
    protocol_version: u32,
    digest_algorithm: String,
    digest: String,
    files: Vec<(String, String)>,
}
pub struct VerifiedPack {
    pub identity: SkillPack,
    files: BTreeMap<String, String>,
}
fn metadata(path: &Path) -> Result<fs::Metadata, String> {
    let m = fs::symlink_metadata(path).map_err(|_| "skill pack unavailable")?;
    // Production daemon is root; non-root fixture requires its own UID. Never
    // accept group/world writable payload, links, or special files.
    if m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o022 != 0
        || m.file_type().is_symlink()
        || (!m.is_file() && !m.is_dir())
        || (m.is_file() && m.nlink() != 1)
    {
        return Err("unsafe skill pack ownership or type".into());
    }
    Ok(m)
}
fn read(path: &Path, total: &mut u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let m = metadata(path)?;
    if !m.is_file() || m.len() > 2 * 1024 * 1024 {
        return Err("skill pack file bound".into());
    }
    *total += m.len();
    if *total > 16 * 1024 * 1024 {
        return Err("skill pack byte bound".into());
    }
    let mut f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "skill pack open")?;
    let opened = f.metadata().map_err(|_| "skill pack metadata")?;
    if opened.ino() != m.ino() || opened.dev() != m.dev() {
        return Err("skill pack changed".into());
    }
    let mut bytes = Vec::new();
    (&mut f)
        .take(m.len() + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "skill pack read")?;
    if bytes.len() as u64 != m.len() {
        return Err("skill pack changed".into());
    }
    Ok(bytes)
}
fn walk(
    root: &Path,
    dir: &Path,
    files: &mut Vec<(String, String)>,
    count: &mut usize,
    total: &mut u64,
    depth: usize,
) -> Result<(), String> {
    if depth > 16 {
        return Err("skill pack depth bound".into());
    }
    metadata(dir)?;
    for entry in fs::read_dir(dir).map_err(|_| "skill pack directory")? {
        let path = entry.map_err(|_| "skill pack entry")?.path();
        *count += 1;
        if *count > 512 {
            return Err("skill pack entry bound".into());
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|_| "skill pack path")?
            .to_str()
            .ok_or("skill pack path encoding")?
            .to_owned();
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("skill pack name")?;
        // Same non-payload exclusions as S's pack.py.
        if ["__pycache__", "tests", ".git"].contains(&name)
            || name.ends_with(".pyc")
            || rel == "pack.json"
        {
            continue;
        }
        if rel.len() > 1024 || rel.chars().any(|c| c.is_control() || c == '\\') {
            return Err("skill pack path bound".into());
        }
        let m = metadata(&path)?;
        if m.is_dir() {
            walk(root, &path, files, count, total, depth + 1)?;
        } else {
            files.push((rel, hex::encode(Sha256::digest(read(&path, total)?))));
        }
    }
    Ok(())
}
pub fn verify(root: Option<&Path>) -> Result<VerifiedPack, String> {
    let root = root.ok_or("skill pack root not configured")?;
    if !root.is_absolute() || fs::canonicalize(root).map_err(|_| "skill pack root")? != root {
        return Err("skill pack root must be canonical".into());
    }
    metadata(root)?;
    let mut total = 0;
    let descriptor: Descriptor =
        serde_json::from_slice(&read(&root.join("pack.json"), &mut total)?)
            .map_err(|_| "invalid skill pack descriptor")?;
    if descriptor.name != "pria-app-builder"
        || descriptor.profile != "react-spa-relative-v1"
        || descriptor.protocol_version != 1
        || descriptor.digest_algorithm != "sha256-path-content-tuples-v1"
        || descriptor.version.is_empty()
        || descriptor.version.len() > 64
        || !descriptor
            .version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-+".contains(&b))
    {
        return Err("unsupported skill pack descriptor".into());
    }
    let mut files = Vec::new();
    walk(root, root, &mut files, &mut 0, &mut total, 0)?;
    files.sort();
    let digest = hex::encode(Sha256::digest(
        serde_json::to_vec(&files).map_err(|_| "skill pack digest")?,
    ));
    if files != descriptor.files || digest != descriptor.digest {
        return Err("skill pack payload mismatch".into());
    }
    let manifest: serde_json::Value =
        serde_json::from_slice(&read(&root.join(".synaps-plugin/plugin.json"), &mut total)?)
            .map_err(|_| "skill pack manifest")?;
    if manifest["name"] != descriptor.name || manifest["version"] != descriptor.version {
        return Err("skill pack manifest mismatch".into());
    }
    let files: BTreeMap<_, _> = files.into_iter().collect();
    for required in ["adapters/vite-react.mjs", "adapters/opaque-dev-runtime.js"] {
        if !files.contains_key(required) {
            return Err("skill pack adapter missing".into());
        }
    }
    Ok(VerifiedPack {
        identity: SkillPack {
            name: descriptor.name,
            version: descriptor.version,
            profile: descriptor.profile,
            digest,
        },
        files,
    })
}
impl VerifiedPack {
    pub fn check_source(&self, source: &super::source_build::SourceEnvelope) -> Result<(), String> {
        for required in ["adapters/vite-react.mjs", "adapters/opaque-dev-runtime.js"] {
            let expected = self
                .files
                .get(required)
                .ok_or("skill pack adapter missing")?;
            // Preparation may rename the adapter; exact bytes, not caller hash,
            // are already attested by frozen Git export. Both must be present.
            if !source.files.iter().any(|f| &f.sha256 == expected) {
                return Err("source does not contain installed skill pack adapters".into());
            }
        }
        Ok(())
    }
}

/// Non-root fixture copy only; never changes shared plugin permissions.
/// Copy is bounded and checked against the descriptor afterwards.
pub fn fixture_copy(source: &Path, dest: &Path) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    fn copy(
        source: &Path,
        dest: &Path,
        count: &mut usize,
        bytes: &mut u64,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 16 {
            return Err("fixture pack depth".into());
        }
        fs::DirBuilder::new()
            .mode(0o700)
            .create(dest)
            .map_err(|_| "fixture pack destination must be new")?;
        for ent in fs::read_dir(source).map_err(|_| "fixture pack source")? {
            let p = ent.map_err(|_| "fixture pack entry")?.path();
            let name = p
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or("fixture pack name")?;
            if ["tests", "__pycache__", ".git"].contains(&name) || name.ends_with(".pyc") {
                continue;
            }
            *count += 1;
            if *count > 512 {
                return Err("fixture pack entry bound".into());
            }
            let m = fs::symlink_metadata(&p).map_err(|_| "fixture pack metadata")?;
            if m.file_type().is_symlink() {
                return Err("fixture pack symlink".into());
            }
            let target = dest.join(name);
            if m.is_dir() {
                copy(&p, &target, count, bytes, depth + 1)?;
            } else {
                if !m.is_file() || m.len() > 2 * 1024 * 1024 {
                    return Err("fixture pack file bound".into());
                }
                *bytes += m.len();
                if *bytes > 16 * 1024 * 1024 {
                    return Err("fixture pack bytes".into());
                }
                fs::copy(&p, &target).map_err(|_| "fixture pack copy")?;
                fs::set_permissions(
                    target,
                    fs::Permissions::from_mode(if m.mode() & 0o111 != 0 { 0o500 } else { 0o400 }),
                )
                .map_err(|_| "fixture pack permissions")?;
            }
        }
        Ok(())
    }
    if unsafe { libc::geteuid() } == 0 {
        return Err("fixture copy requires nonroot".into());
    }
    copy(source, dest, &mut 0, &mut 0, 0)?;
    verify(Some(dest))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn fixture() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("skill-pack-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".synaps-plugin")).unwrap();
        fs::create_dir(root.join("adapters")).unwrap();
        fs::write(
            root.join(".synaps-plugin/plugin.json"),
            r#"{"name":"pria-app-builder","version":"0.2.0"}"#,
        )
        .unwrap();
        fs::write(root.join("adapters/vite-react.mjs"), "adapter").unwrap();
        fs::write(root.join("adapters/opaque-dev-runtime.js"), "runtime").unwrap();
        for path in [&root, &root.join(".synaps-plugin"), &root.join("adapters")] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        for path in [
            ".synaps-plugin/plugin.json",
            "adapters/vite-react.mjs",
            "adapters/opaque-dev-runtime.js",
        ] {
            fs::set_permissions(root.join(path), fs::Permissions::from_mode(0o600)).unwrap();
        }
        let mut files = Vec::new();
        walk(&root, &root, &mut files, &mut 0, &mut 0, 0).unwrap();
        files.sort();
        let digest = hex::encode(Sha256::digest(serde_json::to_vec(&files).unwrap()));
        fs::write(root.join("pack.json"), serde_json::to_vec(&serde_json::json!({"name":"pria-app-builder", "version":"0.2.0", "profile":"react-spa-relative-v1", "protocolVersion":1,"digestAlgorithm":"sha256-path-content-tuples-v1","digest":digest,"files":files})).unwrap()).unwrap();
        fs::set_permissions(root.join("pack.json"), fs::Permissions::from_mode(0o600)).unwrap();
        root
    }
    #[test]
    fn descriptor_checks_actual_payload_and_owner_permissions() {
        assert!(verify(None).is_err());
        let root = fixture();
        assert_eq!(verify(Some(&root)).unwrap().identity.version, "0.2.0");
        fs::write(root.join("extra"), "unlisted payload").unwrap();
        assert!(verify(Some(&root)).is_err());
        fs::remove_file(root.join("extra")).unwrap();
        fs::set_permissions(root.join("pack.json"), fs::Permissions::from_mode(0o666)).unwrap();
        assert!(verify(Some(&root)).is_err());
        fs::set_permissions(root.join("pack.json"), fs::Permissions::from_mode(0o644)).unwrap();
        fs::remove_file(root.join("adapters/vite-react.mjs")).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", root.join("adapters/vite-react.mjs")).unwrap();
        assert!(verify(Some(&root)).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn installed_pack_opt_in_verifies_s_descriptor() {
        if let Some(root) = std::env::var_os("PRIA_TEST_SKILL_PACK_ROOT") {
            verify(Some(Path::new(&root))).unwrap();
        }
    }
}
