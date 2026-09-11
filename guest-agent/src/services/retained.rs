//! Trusted static adapter. No release request resolves a workload executable or
//! reopens workload paths. Files are read once through no-follow directory FDs.
use super::{logs::now_ts, ServiceKind, ServiceSnapshot, ServiceState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawFd, FromRawFd},
    },
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Packaging {
    pub profile: String,
    pub navigation_paths: Vec<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactDescriptor {
    pub revision_id: String,
    pub artifact_digest: String,
    pub files: usize,
    pub base: String,
    #[serde(default)]
    pub navigation_paths: Vec<String>,
    #[serde(default)]
    pub packaging: Option<Packaging>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<super::source_build::SourceEnvelope>,
    pub files: Vec<super::seal::SealedFile>,
    pub total_bytes: u64,
    pub artifact_digest: String,
    pub revision_id: String,
    #[serde(default)]
    pub packaging: Option<Packaging>,
}
#[derive(Serialize, Deserialize)]
struct Artifact {
    #[serde(default)]
    candidate_expires_at: i64,
    receipt: Receipt,
    bytes: BTreeMap<String, Vec<u8>>,
}
/// Node-authorized attribution. Credits are accounted by Node, never guest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hosting {
    pub sponsor_id: String,
    pub account_id: String,
    pub expires_at: i64,
    pub max_cost_units: u64,
}
impl Hosting {
    pub fn validate(&self) -> Result<(), String> {
        if !safe_id(&self.sponsor_id)
            || !safe_id(&self.account_id)
            || self.max_cost_units == 0
            || self.max_cost_units > 9_007_199_254_740_991
            || self.expires_at <= chrono::Utc::now().timestamp_millis()
        {
            return Err("invalid or expired hosting policy".into());
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Binding {
    #[serde(default)]
    hosting: Option<Hosting>,
    #[serde(default)]
    hosting_started_ms: i64,
    #[serde(default)]
    intent_id: Option<String>,
    descriptor: ArtifactDescriptor,
    generation: u64,
    stopped: bool,
    adopted: bool,
    expires_at: i64,
    since: String,
}
pub struct RetainedStore {
    root: PathBuf,
    lock: Mutex<()>,
    process_lock: Mutex<Option<File>>,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn safe_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn safe_name(s: &str) -> bool {
    !s.starts_with('.')
        && !s.ends_with(".map")
        && !s.contains(['\\', '%', ':'])
        && s != "node_modules"
        && !s.to_ascii_lowercase().contains("secret")
        && !s.ends_with(".pem")
        && !s.ends_with(".key")
        && !s.ends_with(".env")
        && !s.to_ascii_lowercase().contains("credential")
        && s.bytes().all(|b| b >= 0x20 && b < 0x7f)
}
fn open_at(dir: &File, name: &str, directory: bool) -> Result<File, String> {
    let name = std::ffi::CString::new(name).map_err(err)?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(err(std::io::Error::last_os_error()));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn open_dir(path: &Path) -> Result<File, String> {
    if !path.is_absolute() {
        return Err("absolute path required".into());
    }
    let mut dir = File::open("/").map_err(err)?;
    for c in path.components() {
        match c {
            std::path::Component::RootDir => {}
            std::path::Component::Normal(n) => {
                dir = open_at(&dir, n.to_str().ok_or("non UTF8 path")?, true)?;
            }
            _ => return Err("unsafe path".into()),
        }
    }
    Ok(dir)
}
fn walk(
    dir: &File,
    prefix: &str,
    bytes: &mut BTreeMap<String, Vec<u8>>,
    total: &mut u64,
    max_files: usize,
    max_bytes: u64,
    entries_left: &mut usize,
) -> Result<(), String> {
    if prefix.len() > 1024 || prefix.matches('/').count() > 32 {
        return Err("artifact path bounds exceeded".into());
    }
    let before = dir.metadata().map_err(err)?;
    for (entry_count, ent) in fs::read_dir(format!("/proc/self/fd/{}", dir.as_raw_fd()))
        .map_err(err)?
        .enumerate()
    {
        if entry_count >= max_files {
            return Err("artifact bounds exceeded".into());
        }
        if *entries_left == 0 {
            return Err("artifact bounds exceeded".into());
        }
        *entries_left -= 1;
        let ent = ent.map_err(err)?;
        let name = ent.file_name().into_string().map_err(|_| "non UTF8 path")?;
        if !safe_name(&name) {
            return Err("unsafe artifact path".into());
        }
        let mut f = open_at(dir, &name, false)?;
        let meta = f.metadata().map_err(err)?;
        let path = format!("{prefix}{name}");
        if meta.is_dir() {
            walk(
                &f,
                &format!("{path}/"),
                bytes,
                total,
                max_files,
                max_bytes,
                entries_left,
            )?;
        } else {
            if !meta.is_file() || meta.nlink() != 1 {
                return Err("artifact must contain only unlinked regular files".into());
            }
            if bytes.len() >= max_files || meta.len() > max_bytes.saturating_sub(*total) {
                return Err("artifact bounds exceeded".into());
            }
            let mut data = Vec::new();
            (&mut f)
                .take(max_bytes.saturating_sub(*total) + 1)
                .read_to_end(&mut data)
                .map_err(err)?;
            let after = f.metadata().map_err(err)?;
            if data.len() as u64 != meta.len()
                || after.ctime() != meta.ctime()
                || after.ctime_nsec() != meta.ctime_nsec()
                || after.mtime_nsec() != meta.mtime_nsec()
                || after.mtime() != meta.mtime()
                || after.nlink() != 1
            {
                return Err("artifact changed during seal".into());
            }
            // Defense in depth, not a substitute for build environment isolation.
            if data.windows(11).any(|w| w == b"PRIVATE KEY") {
                return Err("secret material in artifact".into());
            }
            *total += data.len() as u64;
            bytes.insert(path, data);
        }
    }
    let after = dir.metadata().map_err(err)?;
    if before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err("artifact directory changed during seal".into());
    }
    Ok(())
}
fn validate_packaging(p: &Packaging) -> Result<(), String> {
    if p.profile != "react-spa-relative-v1"
        || p.navigation_paths.len() > 128
        || !p.navigation_paths.iter().any(|s| s == "/")
        || p.navigation_paths.iter().any(|s| {
            !s.starts_with('/')
                || s.len() > 1024
                || s.contains(['%', '?', '#', '\\'])
                || s.split('/').skip(1).any(|v| v.starts_with('.'))
        })
    {
        return Err("unsupported packaging or invalid navigation paths".into());
    }
    Ok(())
}
/// Conservative supported profile, not a JS/HTML rewriter. A reviewed blocking
/// bootstrap must precede modules; unsupported absolute local asset references
/// fail sealing. Arbitrary runtime JS behavior still requires gateway/browser receipts.
fn validate_relative_html(bytes: &BTreeMap<String, Vec<u8>>) -> Result<(), String> {
    let html = std::str::from_utf8(bytes.get("index.html").ok_or("index missing")?).map_err(err)?;
    let bootstrap = "<script src=\"/_pria/v1/pria-agentspace-react.js\"></script>";
    let position = html
        .find(bootstrap)
        .ok_or("relative profile requires blocking trusted React base bootstrap")?;
    // Deliberately narrow canonical HTML profile, not an HTML parser. Reject
    // parser-state constructs that could make lexical template checks misleading.
    let lower = html.to_ascii_lowercase();
    for forbidden in [
        "<!--",
        "<![",
        "<base",
        "<noscript",
        "<textarea",
        "<title",
        "<xmp",
        "<iframe",
        "<noembed",
        "<noframes",
        "<plaintext",
        "<svg",
        "<math",
        "<select",
        "<table",
    ] {
        // A normal title is common in Vite HTML; it cannot contain markup here.
        if forbidden == "<title" {
            for part in lower.split("<title").skip(1) {
                let text = part
                    .strip_prefix('>')
                    .and_then(|v| v.split_once("</title>"))
                    .ok_or("unsupported title shape")?
                    .0;
                if text.contains('<') {
                    return Err("markup in title unsupported".into());
                }
            }
            continue;
        }
        if lower.contains(forbidden) {
            return Err("unsupported relative HTML parser context".into());
        }
    }
    let open = "<template data-pria-react-entry=\"v1\">";
    let mut rest = html;
    let mut offset = 0;
    while let Some(i) = rest.find('<') {
        offset += i;
        rest = &rest[i..];
        let end = rest.find('>').ok_or("unterminated HTML tag")? + 1;
        let tag = &rest[..end];
        let tag_lower = tag.to_ascii_lowercase();
        if tag_lower.starts_with("<template") {
            if tag != open || offset < position + bootstrap.len() {
                return Err("inert entry must follow bootstrap".into());
            }
            let close = rest.find("</template>").ok_or("unclosed entry template")?;
            let canonical = rest[open.len()..close]
                .trim()
                .replace(" crossorigin=\"\"", " crossorigin");
            let entry = canonical.as_str();
            let (prefix, suffix) = if entry.starts_with("<script type=\"module\"") {
                let prefix = if entry.starts_with("<script type=\"module\" crossorigin ") {
                    "<script type=\"module\" crossorigin src=\""
                } else {
                    "<script type=\"module\" src=\""
                };
                (prefix, "\"></script>")
            } else if entry.starts_with("<link rel=\"stylesheet\"") {
                ("<link rel=\"stylesheet\" crossorigin href=\"", "\">")
            } else {
                ("<link rel=\"modulepreload\" crossorigin href=\"", "\">")
            };
            let asset = entry
                .strip_prefix(prefix)
                .and_then(|v| v.strip_suffix(suffix))
                .ok_or("unsupported inert entry shape")?;
            if !asset.starts_with("./assets/")
                || asset.contains("..")
                || asset
                    .bytes()
                    .any(|b| !(b.is_ascii_alphanumeric() || b"./_-".contains(&b)))
            {
                return Err("unsafe inert entry asset".into());
            }
            let consumed = close + "</template>".len();
            rest = &rest[consumed..];
            offset += consumed;
            continue;
        }
        if tag_lower.starts_with("<script") {
            let sdk = "<script src=\"/_pria/v1/pria-agentspace-sdk.js\"></script>";
            let allowed = if rest.starts_with(bootstrap) {
                bootstrap
            } else if rest.starts_with(sdk) && offset > position {
                sdk
            } else {
                return Err("active scripts outside inert entries unsupported".into());
            };
            rest = &rest[allowed.len()..];
            offset += allowed.len();
            continue;
        }
        if tag_lower.starts_with("<link") || tag_lower.starts_with("</template") {
            return Err("active links or unmatched templates unsupported".into());
        }
        // Attribute quoting containing markup is outside this canonical profile.
        if tag[1..tag.len() - 1].contains('<') {
            return Err("ambiguous HTML tag".into());
        }
        rest = &rest[end..];
        offset += end;
    }
    for marker in ["src=\"/", "href=\"/", "src='/", "href='/"] {
        let mut rest = html;
        while let Some(i) = rest.find(marker) {
            let value = &rest[i + marker.len() - 1..];
            let end = value.find(['\"', '\'']).ok_or("invalid asset reference")?;
            let path = &value[..end];
            if path != "/_pria/v1/pria-agentspace-react.js"
                && path != "/_pria/v1/pria-agentspace-sdk.js"
            {
                return Err("absolute assets unsupported by relative profile".into());
            }
            rest = &value[end + 1..];
        }
    }
    Ok(())
}
impl RetainedStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            lock: Mutex::new(()),
            process_lock: Mutex::new(None),
        }
    }
    pub fn prepare(&self) -> Result<(), String> {
        if !self.root.exists() {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&self.root)
                .map_err(err)?;
        }
        let d = open_dir(&self.root)?;
        let m = d.metadata().map_err(err)?;
        if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 {
            return Err("release store must be private to guest OS owner".into());
        }
        let mut held = self
            .process_lock
            .lock()
            .map_err(|_| "retained lock poisoned")?;
        if held.is_none() {
            let f = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(self.root.join("store.lock"))
                .map_err(err)?;
            let meta = f.metadata().map_err(err)?;
            if !meta.is_file()
                || meta.nlink() != 1
                || meta.uid() != unsafe { libc::geteuid() }
                || meta.mode() & 0o077 != 0
            {
                return Err("unsafe retained lock file".into());
            }
            if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err("retained store already owned by another supervisor".into());
            }
            *held = Some(f);
        }
        Ok(())
    }
    /// Fail closed on full storage, never evict references on ambiguous Node CAS.
    /// Limits include serialized source/output, binding and intent records.
    fn tombstone_path(&self, revision: &str) -> PathBuf {
        self.root.join(format!("expired-{revision}.json"))
    }
    fn candidate_live(&self, d: &ArtifactDescriptor) -> Result<(), String> {
        let artifact = self.artifact(d)?;
        // Legacy records with no lease are conservatively retained.
        if artifact.candidate_expires_at != 0
            && chrono::Utc::now().timestamp() >= artifact.candidate_expires_at
        {
            return Err("sealed candidate lease expired".into());
        }
        Ok(())
    }
    /// Same lock as start/adopt/seal. Adoption must succeed before Node CAS.
    /// Never delete any artifact referenced by an adopted binding, even stopped.
    pub fn collect_expired_candidates(&self) -> Result<usize, String> {
        let _g = self.lock.lock().unwrap();
        self.prepare()?;
        self.collect_locked(chrono::Utc::now().timestamp())
    }
    fn collect_locked(&self, now: i64) -> Result<usize, String> {
        let mut artifacts = Vec::new();
        let mut bindings: Vec<Binding> = Vec::new();
        for (i, entry) in fs::read_dir(&self.root).map_err(err)?.enumerate() {
            if i >= 4096 {
                return Err("retained record quota exceeded".into());
            }
            let path = entry.map_err(err)?.path();
            let name = path
                .file_name()
                .and_then(|p| p.to_str())
                .ok_or("retained entry encoding")?;
            if name.starts_with("service-") && name.ends_with(".json") {
                bindings.push(serde_json::from_slice(&fs::read(&path).map_err(err)?).map_err(err)?);
            } else if name.starts_with("artifact-") && name.ends_with(".json") {
                artifacts.push(path);
            }
        }
        let mut removed = 0;
        for path in artifacts {
            let artifact: Artifact =
                serde_json::from_slice(&fs::read(&path).map_err(err)?).map_err(err)?;
            let revision = &artifact.receipt.revision_id;
            if path.file_name().and_then(|p| p.to_str())
                != Some(format!("artifact-{revision}.json").as_str())
            {
                return Err("retained artifact filename identity mismatch".into());
            }
            if !safe_id(revision)
                || artifact.candidate_expires_at == 0
                || now < artifact.candidate_expires_at
            {
                continue;
            }
            if bindings
                .iter()
                .any(|b| b.descriptor.revision_id == *revision && (b.adopted || now < b.expires_at))
            {
                continue;
            }
            // Durable tombstone FIRST. Crash/retry cannot resurrect seal identity.
            let tombstone = self.tombstone_path(revision);
            if !tombstone.exists() {
                self.atomic(&tombstone, &serde_json::json!({"revisionId":revision,"state":"expired","artifactDigest":artifact.receipt.artifact_digest}), false)?;
            }
            fs::remove_file(path).map_err(err)?;
            File::open(&self.root)
                .map_err(err)?
                .sync_all()
                .map_err(err)?;
            removed += 1;
        }
        Ok(removed)
    }
    fn storage_admission(&self, path: &Path, incoming: u64) -> Result<(), String> {
        const MAX_RECORDS: usize = 4096;
        const MAX_BYTES: u64 = 512 * 1024 * 1024;
        if incoming > MAX_BYTES {
            return Err("retained storage quota exceeded".into());
        }
        let mut count = 0usize;
        let mut bytes = incoming;
        for entry in fs::read_dir(&self.root).map_err(err)? {
            let entry = entry.map_err(err)?;
            count += 1;
            if count > MAX_RECORDS {
                return Err("retained record quota exceeded".into());
            }
            let m = fs::symlink_metadata(entry.path()).map_err(err)?;
            if !m.is_file() || m.file_type().is_symlink() || m.nlink() != 1 {
                return Err("unsafe retained storage entry".into());
            }
            // Account for atomic replacement's temporary copy, not only net growth.
            bytes = bytes
                .checked_add(m.len())
                .ok_or("retained quota overflow")?;
            if bytes > MAX_BYTES {
                return Err("retained storage quota exceeded".into());
            }
        }
        if !path.exists() && count >= MAX_RECORDS {
            return Err("retained record quota exceeded".into());
        }
        Ok(())
    }
    fn atomic(&self, path: &Path, value: &impl Serialize, replace: bool) -> Result<(), String> {
        let data = serde_json::to_vec(value).map_err(err)?;
        self.storage_admission(path, data.len() as u64)?;
        let tmp = self.root.join(format!("tmp-{}", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut f = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o400)
                .open(&tmp)
                .map_err(err)?;
            f.write_all(&data).map_err(err)?;
            f.sync_all().map_err(err)?;
            if replace {
                fs::rename(&tmp, path).map_err(err)?;
            } else {
                fs::hard_link(&tmp, path).map_err(err)?;
            }
            File::open(&self.root)
                .map_err(err)?
                .sync_all()
                .map_err(err)?;
            Ok(())
        })();
        let _ = fs::remove_file(tmp);
        result
    }
    /// Persist before spawn. Existing intent after restart reports unavailable;
    /// it must never silently spawn a duplicate process.
    pub fn claim_intent(&self, id: &str, intent: &str) -> Result<bool, String> {
        let _g = self.lock.lock().unwrap();
        self.prepare()?;
        if !safe_id(id) {
            return Err("invalid service id".into());
        }
        let path = self.root.join(format!("intent-{id}.json"));
        if path.exists() {
            let old: String = serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?;
            if old != intent {
                return Err("service intent conflict".into());
            }
            return Ok(false);
        }
        self.atomic(&path, &intent, false)?;
        Ok(true)
    }
    /// Successful revision is an immutable idempotency key. Replay retained
    /// source/outcomes instead of rerunning nondeterministic build scripts.
    pub fn source_replay(
        &self,
        revision: &str,
        commands: &[Vec<String>],
        packaging: &Option<Packaging>,
    ) -> Result<Option<Receipt>, String> {
        self.prepare()?;
        if !safe_id(revision) {
            return Err("invalid revisionId".into());
        }
        if self.tombstone_path(revision).exists() {
            return Err("sealed candidate expired; new revision required".into());
        }
        let path = self.root.join(format!("artifact-{revision}.json"));
        if !path.exists() {
            return Ok(None);
        }
        let artifact: Artifact =
            serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?;
        let source = artifact
            .receipt
            .source
            .as_ref()
            .ok_or("revision has no trusted source lineage")?;
        if artifact.receipt.packaging != *packaging
            || source.phases.iter().map(|p| &p.command).collect::<Vec<_>>()
                != commands.iter().collect::<Vec<_>>()
        {
            return Err("revision build intent conflict".into());
        }
        Ok(Some(artifact.receipt))
    }
    pub fn seal(
        &self,
        output: &Path,
        revision: &str,
        max_files: usize,
        max_bytes: u64,
    ) -> Result<Receipt, String> {
        self.seal_packaged(output, revision, max_files, max_bytes, None)
    }
    pub fn seal_packaged(
        &self,
        output: &Path,
        revision: &str,
        max_files: usize,
        max_bytes: u64,
        packaging: Option<Packaging>,
    ) -> Result<Receipt, String> {
        self.seal_with_source(output, revision, max_files, max_bytes, packaging, None)
    }
    pub fn seal_with_source(
        &self,
        output: &Path,
        revision: &str,
        max_files: usize,
        max_bytes: u64,
        packaging: Option<Packaging>,
        source: Option<super::source_build::SourceEnvelope>,
    ) -> Result<Receipt, String> {
        if let Some(p) = &packaging {
            validate_packaging(p)?;
        }
        if !safe_id(revision) {
            return Err("invalid revisionId".into());
        }
        let _g = self.lock.lock().unwrap();
        self.prepare()?;
        self.collect_locked(chrono::Utc::now().timestamp())?;
        if output.starts_with(&self.root) || self.root.starts_with(output) {
            return Err("artifact root overlaps workload".into());
        }
        let mut bytes = BTreeMap::new();
        let mut total = 0;
        walk(
            &open_dir(output)?,
            "",
            &mut bytes,
            &mut total,
            max_files,
            max_bytes,
            &mut max_files.saturating_mul(2).max(1),
        )?;
        if !bytes.contains_key("index.html") {
            return Err("index.html required".into());
        }
        if packaging.is_some() {
            validate_relative_html(&bytes)?;
        }
        let files: Vec<_> = bytes
            .iter()
            .map(|(path, b)| super::seal::SealedFile {
                path: path.clone(),
                size: b.len() as u64,
                sha256: hex::encode(Sha256::digest(b)),
            })
            .collect();
        let tuples: Vec<_> = files.iter().map(|f| (&f.path, f.size, &f.sha256)).collect();
        let digest = hex::encode(Sha256::digest(serde_json::to_vec(&tuples).map_err(err)?));
        let receipt = Receipt {
            source: source.clone(),
            files,
            total_bytes: total,
            artifact_digest: digest,
            revision_id: revision.into(),
            packaging: packaging.clone(),
        };
        if self.tombstone_path(revision).exists() {
            return Err("sealed candidate expired; new revision required".into());
        }
        let path = self.root.join(format!("artifact-{revision}.json"));
        if path.exists() {
            let old: Artifact =
                serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?;
            if old.receipt.artifact_digest != receipt.artifact_digest
                || old.receipt.source != source
                || old.receipt.packaging != packaging
            {
                return Err("revision bytes conflict".into());
            }
            return Ok(old.receipt);
        }
        self.atomic(
            &path,
            &Artifact {
                candidate_expires_at: chrono::Utc::now().timestamp() + 86400,
                receipt: receipt.clone(),
                bytes,
            },
            false,
        )?;
        Ok(receipt)
    }
    fn artifact(&self, d: &ArtifactDescriptor) -> Result<Artifact, String> {
        self.prepare()?;
        if !safe_id(&d.revision_id) {
            return Err("invalid revisionId".into());
        }
        let a: Artifact = serde_json::from_slice(
            &fs::read(self.root.join(format!("artifact-{}.json", d.revision_id))).map_err(err)?,
        )
        .map_err(err)?;
        let tuples: Vec<_> = a
            .bytes
            .iter()
            .map(|(p, b)| (p, b.len(), hex::encode(Sha256::digest(b))))
            .collect();
        let digest = hex::encode(Sha256::digest(serde_json::to_vec(&tuples).map_err(err)?));
        if digest != d.artifact_digest
            || a.receipt.artifact_digest != digest
            || a.bytes.len() != d.files
            || a.receipt.packaging != d.packaging
        {
            return Err("retained artifact integrity mismatch".into());
        }
        Ok(a)
    }
    fn binding_path(&self, id: &str) -> Result<PathBuf, String> {
        if !safe_id(id) {
            return Err("invalid service id".into());
        }
        Ok(self.root.join(format!("service-{id}.json")))
    }
    fn binding(&self, id: &str) -> Result<Binding, String> {
        self.prepare()?;
        serde_json::from_slice(&fs::read(self.binding_path(id)?).map_err(err)?).map_err(err)
    }
    fn unavailable(b: &Binding) -> bool {
        let now = chrono::Utc::now().timestamp_millis();
        b.stopped
            || (!b.adopted && now / 1000 >= b.expires_at)
            || b.hosting.as_ref().is_some_and(|h| now >= h.expires_at)
    }
    fn snapshot(id: &str, b: &Binding) -> ServiceSnapshot {
        ServiceSnapshot {
            service_id: id.into(),
            kind: ServiceKind::Release,
            generation: b.generation,
            state: if Self::unavailable(b) {
                ServiceState::Stopped
            } else {
                ServiceState::Ready
            },
            port: 0,
            pid: 0,
            exit_code: None,
            signal: None,
            since: b.since.clone(),
            started_at: b.since.clone(),
            detail: None,
        }
    }
    pub fn status(&self, id: &str) -> Option<ServiceSnapshot> {
        self.binding(id).ok().map(|b| Self::snapshot(id, &b))
    }
    pub fn start(&self, id: &str, d: ArtifactDescriptor) -> Result<ServiceSnapshot, String> {
        self.start_hosted(id, d, None)
    }
    pub fn start_hosted(
        &self,
        id: &str,
        d: ArtifactDescriptor,
        hosting: Option<Hosting>,
    ) -> Result<ServiceSnapshot, String> {
        if let Some(ref h) = hosting {
            h.validate()?;
        }
        let _g = self.lock.lock().unwrap();
        self.prepare()?;
        if !self.binding_path(id)?.exists() {
            self.candidate_live(&d)?;
        }
        self.artifact(&d)?;
        if let Some(p) = &d.packaging {
            validate_packaging(p)?;
            if !d.navigation_paths.is_empty() {
                return Err("packaging conflicts with legacy navigationPaths".into());
            }
        }
        if d.navigation_paths.len() > 128
            || d.navigation_paths.iter().any(|p| {
                !p.starts_with('/')
                    || p.len() > 1024
                    || p.contains(['%', '?', '#', '\\'])
                    || p.split('/').skip(1).any(|s| s.starts_with('.'))
            })
        {
            return Err("invalid navigation declaration".into());
        }
        let path = self.binding_path(id)?;
        let generation = if path.exists() {
            let b = self.binding(id)?;
            if b.descriptor != d || b.hosting != hosting {
                return Err("service artifact conflict".into());
            }
            return Ok(Self::snapshot(id, &b));
        } else {
            1
        };
        let b = Binding {
            hosting,
            hosting_started_ms: chrono::Utc::now().timestamp_millis(),
            intent_id: None,
            descriptor: d,
            generation,
            stopped: false,
            adopted: false,
            expires_at: chrono::Utc::now().timestamp() + 1800,
            since: now_ts(),
        };
        self.atomic(&path, &b, true)?;
        Ok(Self::snapshot(id, &b))
    }
    pub fn stop(&self, id: &str, generation: u64) -> Result<ServiceSnapshot, String> {
        let _g = self.lock.lock().unwrap();
        let mut b = self.binding(id)?;
        if generation != b.generation {
            return Err("generation mismatch".into());
        }
        b.stopped = true;
        self.atomic(&self.binding_path(id)?, &b, true)?;
        Ok(Self::snapshot(id, &b))
    }
    pub fn adopt(
        &self,
        id: &str,
        generation: u64,
        revision: &str,
        digest: &str,
    ) -> Result<ServiceSnapshot, String> {
        self.adopt_hosted(id, generation, revision, digest, None, None)
    }
    pub fn adopt_hosted(
        &self,
        id: &str,
        generation: u64,
        revision: &str,
        digest: &str,
        hosting: Option<Hosting>,
        intent_id: Option<String>,
    ) -> Result<ServiceSnapshot, String> {
        if let Some(ref h) = hosting {
            h.validate()?;
        }
        if hosting.is_some()
            && !intent_id
                .as_ref()
                .is_some_and(|i| i.len() == 64 && i.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("hosting adoption requires intentId".into());
        }
        let _g = self.lock.lock().unwrap();
        let mut b = self.binding(id)?;
        if b.generation != generation
            || b.descriptor.revision_id != revision
            || b.descriptor.artifact_digest != digest
            || Self::unavailable(&b)
            || b.hosting != hosting
        {
            return Err("adoption identity unavailable".into());
        }
        if !b.adopted {
            self.candidate_live(&b.descriptor)?;
        }
        self.artifact(&b.descriptor)?;
        b.adopted = true;
        b.intent_id = intent_id;
        self.atomic(&self.binding_path(id)?, &b, true)?;
        Ok(Self::snapshot(id, &b))
    }
    pub fn serve_html(
        &self,
        id: &str,
        generation: u64,
        path: &str,
        html: bool,
    ) -> Result<(u16, String, Vec<u8>), String> {
        let result = self.serve(id, generation, path)?;
        if result.0 == 404 && html && !path.rsplit('/').next().unwrap_or("").contains('.') {
            let b = self.binding(id)?;
            if b.descriptor
                .packaging
                .as_ref()
                .map(|p| &p.navigation_paths)
                .unwrap_or(&b.descriptor.navigation_paths)
                .iter()
                .any(|p| p == &format!("/{}", path.trim_start_matches('/')))
            {
                return self.serve(id, generation, "");
            }
        }
        Ok(result)
    }
    pub fn serve(
        &self,
        id: &str,
        generation: u64,
        path: &str,
    ) -> Result<(u16, String, Vec<u8>), String> {
        let b = self.binding(id)?;
        if Self::unavailable(&b) || generation != b.generation {
            return Err("service generation unavailable".into());
        }
        let a = self.artifact(&b.descriptor)?;
        let path = path.trim_start_matches('/');
        let path = if path.is_empty() { "index.html" } else { path };
        if path.split('/').any(|p| !safe_name(p) || p.is_empty()) {
            return Err("unsafe path".into());
        }
        // No implicit SPA fallback: navigation declarations are not yet in the contract.
        match a.bytes.get(path) {
            Some(data) => {
                let mime = match path.rsplit('.').next().unwrap_or("") {
                    "html" => "text/html; charset=utf-8",
                    "js" | "mjs" => "text/javascript; charset=utf-8",
                    "css" => "text/css; charset=utf-8",
                    "json" => "application/json",
                    "svg" => "image/svg+xml",
                    "png" => "image/png",
                    "jpg" | "jpeg" => "image/jpeg",
                    "woff2" => "font/woff2",
                    _ => "application/octet-stream",
                };
                Ok((200, mime.into(), data.clone()))
            }
            None => Ok((404, "text/plain".into(), b"Not found".to_vec())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn root_flock_refuses_second_store_and_external_process_until_drop() {
        let root = std::env::temp_dir().join(format!("store-lock-{}", uuid::Uuid::new_v4()));
        let first = RetainedStore::new(root.clone());
        first.prepare().unwrap();
        let second = RetainedStore::new(root.clone());
        assert!(second.prepare().is_err());
        let probe = || {
            std::process::Command::new("/usr/bin/flock")
                .args(["-n"])
                .arg(root.join("store.lock"))
                .arg("/usr/bin/true")
                .status()
                .unwrap()
        };
        assert!(!probe().success());
        drop(first);
        assert!(probe().success());
        second.prepare().unwrap();
        drop(second);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn expired_unadopted_collection_tombstones_but_adopted_unknown_survives() {
        let root = std::env::temp_dir().join(format!("retention-{}", uuid::Uuid::new_v4()));
        let output = root.join("dist");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("index.html"), "private exact").unwrap();
        let store = RetainedStore::new(root.join("private"));
        for (revision, adopt) in [("unknown_winner", true), ("unused", false)] {
            let r = store.seal(&output, revision, 10, 1000).unwrap();
            let d = ArtifactDescriptor {
                revision_id: revision.into(),
                artifact_digest: r.artifact_digest.clone(),
                files: 1,
                base: "/".into(),
                navigation_paths: vec![],
                packaging: None,
            };
            store.start(revision, d).unwrap();
            if adopt {
                store
                    .adopt(revision, 1, revision, &r.artifact_digest)
                    .unwrap();
            }
            let path = store.root.join(format!("artifact-{revision}.json"));
            let mut artifact: Artifact = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            artifact.candidate_expires_at = 1;
            store.atomic(&path, &artifact, true).unwrap();
            let mut binding = store.binding(revision).unwrap();
            binding.expires_at = 1;
            store
                .atomic(&store.binding_path(revision).unwrap(), &binding, true)
                .unwrap();
        }
        assert_eq!(store.collect_expired_candidates().unwrap(), 1);
        assert!(!store.root.join("artifact-unused.json").exists());
        assert!(store.root.join("expired-unused.json").exists());
        assert!(store.root.join("service-unused.json").exists());
        assert!(store.seal(&output, "unused", 10, 1000).is_err());
        assert_eq!(
            store.serve("unknown_winner", 1, "").unwrap().2,
            b"private exact"
        );
        drop(store);
        let store = RetainedStore::new(root.join("private"));
        assert_eq!(store.collect_expired_candidates().unwrap(), 0);
        assert!(store.seal(&output, "unused", 10, 1000).is_err());
        assert!(store.root.join("artifact-unknown_winner.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn aggregate_quota_refuses_without_damaging_prior_data() {
        let root = std::env::temp_dir().join(format!("quota-{}", uuid::Uuid::new_v4()));
        let store = RetainedStore::new(root.clone());
        store.prepare().unwrap();
        let prior = root.join("intent-prior.json");
        fs::write(&prior, b"prior").unwrap();
        let large = root.join("quota-fixture");
        let file = File::create(&large).unwrap();
        file.set_len(512 * 1024 * 1024).unwrap(); // sparse disposable test, no giant allocation
        assert!(store.claim_intent("new", "new").is_err());
        assert_eq!(fs::read(prior).unwrap(), b"prior");
        assert!(!root.join("intent-new.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn hosted_budget_expiry_restart_and_uncertain_adoption_preserve_bytes() {
        let root = std::env::temp_dir().join(format!("hosting-{}", uuid::Uuid::new_v4()));
        let output = root.join("dist");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("index.html"), "exact").unwrap();
        let store = RetainedStore::new(root.join("private"));
        let r = store.seal(&output, "revision", 10, 1000).unwrap();
        let d = ArtifactDescriptor {
            revision_id: "revision".into(),
            artifact_digest: r.artifact_digest.clone(),
            files: 1,
            base: "/".into(),
            navigation_paths: vec![],
            packaging: None,
        };
        let hosting = Hosting {
            sponsor_id: "sponsor".into(),
            account_id: "account".into(),
            expires_at: chrono::Utc::now().timestamp_millis() + 60_000,
            max_cost_units: 30,
        };
        store
            .start_hosted("hosted_service", d.clone(), Some(hosting.clone()))
            .unwrap();
        store
            .adopt_hosted(
                "hosted_service",
                1,
                "revision",
                &r.artifact_digest,
                Some(hosting.clone()),
                Some("a".repeat(64)),
            )
            .unwrap();
        assert!(store
            .adopt_hosted(
                "hosted_service",
                1,
                "revision",
                &r.artifact_digest,
                Some(hosting.clone()),
                Some("b".repeat(64))
            )
            .is_ok());
        // Unknown Node CAS does not stop adopted winner or remove immutable data.
        drop(store);
        let store = RetainedStore::new(root.join("private"));
        assert_eq!(store.serve("hosted_service", 1, "").unwrap().2, b"exact");
        let mut b = store.binding("hosted_service").unwrap();
        b.hosting.as_mut().unwrap().expires_at = chrono::Utc::now().timestamp_millis() - 1;
        store
            .atomic(&store.binding_path("hosted_service").unwrap(), &b, true)
            .unwrap();
        assert!(store.serve("hosted_service", 1, "").is_err());
        assert_eq!(
            store.status("hosted_service").unwrap().state,
            ServiceState::Stopped
        );
        assert!(store
            .start_hosted("hosted_service", d, Some(hosting))
            .is_err());
        assert!(root.join("private/artifact-revision.json").is_file());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn empty_directory_fanout_is_bounded_and_does_not_damage_peer_release() {
        let root = std::env::temp_dir().join(format!("bounded-seal-{}", uuid::Uuid::new_v4()));
        let output = root.join("dist");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("index.html"), b"peer").unwrap();
        let store = RetainedStore::new(root.join("private"));
        let receipt = store.seal(&output, "peer", 10, 1000).unwrap();
        store
            .start(
                "peer_service",
                ArtifactDescriptor {
                    revision_id: "peer".into(),
                    artifact_digest: receipt.artifact_digest,
                    files: 1,
                    base: "/".into(),
                    navigation_paths: vec![],
                    packaging: None,
                },
            )
            .unwrap();
        for i in 0..10 {
            fs::create_dir(output.join(format!("empty{i}"))).unwrap();
        }
        assert!(store.seal(&output, "oversized", 10, 1000).is_err());
        assert!(!root.join("private/artifact-oversized.json").exists());
        assert_eq!(store.serve("peer_service", 1, "").unwrap().2, b"peer");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retained_mutation_adoption_restart_and_fencing() {
        let root = std::env::temp_dir().join(format!("retained-{}", uuid::Uuid::new_v4()));
        let output = root.join("workspace/dist");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("index.html"), b"exact bytes").unwrap();
        let store = RetainedStore::new(root.join("private"));
        let receipt = store.seal(&output, "revision_1", 10, 1000).unwrap();
        let descriptor = ArtifactDescriptor {
            revision_id: receipt.revision_id.clone(),
            artifact_digest: receipt.artifact_digest.clone(),
            files: 1,
            base: "/p/r/revision_1/".into(),
            navigation_paths: vec!["/about/team".into()],
            packaging: None,
        };
        assert_eq!(
            store
                .start("service_1", descriptor.clone())
                .unwrap()
                .generation,
            1
        );
        fs::write(output.join("index.html"), b"changed").unwrap();
        assert!(store.seal(&output, "revision_1", 10, 1000).is_err());
        assert_eq!(store.serve("service_1", 1, "").unwrap().2, b"exact bytes");
        assert_eq!(store.serve("service_1", 1, "missing.js").unwrap().0, 404);
        assert_eq!(store.serve("service_1", 1, "navigation").unwrap().0, 404);
        assert_eq!(
            store
                .serve_html("service_1", 1, "about/team", true)
                .unwrap()
                .2,
            b"exact bytes"
        );
        assert_eq!(
            store
                .serve_html("service_1", 1, "about/team", false)
                .unwrap()
                .0,
            404
        );
        assert!(store.serve("service_1", 2, "").is_err());
        assert!(store.serve("other", 1, "").is_err());
        assert!(store
            .adopt("service_1", 2, "revision_1", &receipt.artifact_digest)
            .is_err());
        store
            .adopt("service_1", 1, "revision_1", &receipt.artifact_digest)
            .unwrap();
        fs::remove_dir_all(root.join("workspace")).unwrap();
        drop(store);
        let store = RetainedStore::new(root.join("private"));
        assert_eq!(
            store
                .start("service_1", descriptor.clone())
                .unwrap()
                .generation,
            1
        );
        assert_eq!(store.serve("service_1", 1, "").unwrap().2, b"exact bytes");
        store.stop("service_1", 1).unwrap();
        assert!(store.serve("service_1", 1, "").is_err());
        assert_eq!(
            store.start("service_1", descriptor).unwrap().state,
            ServiceState::Stopped
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_links_secrets_and_expired_candidates() {
        let root = std::env::temp_dir().join(format!("retained-{}", uuid::Uuid::new_v4()));
        let output = root.join("dist");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("index.html"), b"hi").unwrap();
        let store = RetainedStore::new(root.join("private"));
        for name in [".env", "secret.txt", "app.js.map", "private.pem"] {
            fs::write(output.join(name), b"x").unwrap();
            assert!(store.seal(&output, "r1", 10, 1000).is_err());
            fs::remove_file(output.join(name)).unwrap();
        }
        fs::hard_link(output.join("index.html"), output.join("hard.html")).unwrap();
        assert!(store.seal(&output, "r1", 10, 1000).is_err());
        fs::remove_file(output.join("hard.html")).unwrap();
        std::os::unix::fs::symlink(output.join("index.html"), output.join("link.html")).unwrap();
        assert!(store.seal(&output, "r1", 10, 1000).is_err());
        fs::remove_file(output.join("link.html")).unwrap();
        let r = store.seal(&output, "r1", 10, 1000).unwrap();
        store
            .start(
                "service_1",
                ArtifactDescriptor {
                    revision_id: "r1".into(),
                    artifact_digest: r.artifact_digest.clone(),
                    files: 1,
                    base: "/".into(),
                    navigation_paths: vec![],
                    packaging: None,
                },
            )
            .unwrap();
        let mut b = store.binding("service_1").unwrap();
        b.expires_at = 0;
        store
            .atomic(&store.binding_path("service_1").unwrap(), &b, true)
            .unwrap();
        assert!(store.serve("service_1", 1, "").is_err());
        assert!(store
            .adopt("service_1", 1, "r1", &r.artifact_digest)
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn relative_profile_requires_inert_entries() {
        let bootstrap = "<script src=\"/_pria/v1/pria-agentspace-react.js\"></script>";
        let module = "<script type=\"module\" crossorigin=\"\" src=\"./assets/app.js\"></script>";
        let inert = format!("<template data-pria-react-entry=\"v1\">{module}</template>");
        let check = |html: String| {
            validate_relative_html(&BTreeMap::from([("index.html".into(), html.into_bytes())]))
        };
        assert!(check(format!("{bootstrap}{inert}")).is_ok());
        assert!(check(format!("{bootstrap}{module}")).is_err());
        assert!(check(format!(
            "{bootstrap}<link rel=\"stylesheet\" href=\"./assets/a.css\">"
        ))
        .is_err());
        assert!(check(format!("{inert}{bootstrap}")).is_err());
        assert!(check(format!(
            "{bootstrap}<template data-pria-react-entry=\"v1\">{module}{module}</template>"
        ))
        .is_err());
        assert!(check(format!("{bootstrap}<textarea>{inert}</textarea>")).is_err());
        assert!(check(format!(
            "{bootstrap}<SCRIPT SRC=\"./assets/app.js\"></SCRIPT>"
        ))
        .is_err());
    }
    #[test]
    fn packaged_relative_navigation_is_bound_at_seal() {
        let root = std::env::temp_dir().join(format!("packaging-{}", uuid::Uuid::new_v4()));
        let output = root.join("dist");
        fs::create_dir_all(&output).unwrap();
        let html=b"<html><head><script src=\"/_pria/v1/pria-agentspace-react.js\"></script><template data-pria-react-entry=\"v1\"><script type=\"module\" crossorigin src=\"./assets/app.js\"></script></template></head></html>";
        fs::write(output.join("index.html"), html).unwrap();
        let store = RetainedStore::new(root.join("private"));
        let packaging = Packaging {
            profile: "react-spa-relative-v1".into(),
            navigation_paths: vec!["/".into(), "/about/team".into()],
        };
        let receipt = store
            .seal_packaged(&output, "rev", 10, 10000, Some(packaging.clone()))
            .unwrap();
        let mut descriptor = ArtifactDescriptor {
            revision_id: "rev".into(),
            artifact_digest: receipt.artifact_digest,
            files: 1,
            base: "./".into(),
            navigation_paths: vec![],
            packaging: None,
        };
        assert!(store.start("service_1", descriptor.clone()).is_err());
        descriptor.packaging = Some(packaging.clone());
        store.start("service_1", descriptor.clone()).unwrap();
        assert_eq!(
            store
                .serve_html("service_1", 1, "about/team", true)
                .unwrap()
                .2,
            html
        );
        assert_eq!(
            store
                .serve_html("service_1", 1, "about/team", false)
                .unwrap()
                .0,
            404
        );
        assert_eq!(
            store
                .serve_html("service_1", 1, "missing.css", true)
                .unwrap()
                .0,
            404
        );
        fs::write(
            output.join("index.html"),
            b"<script src=\"/assets/app.js\"></script>",
        )
        .unwrap();
        assert!(store
            .seal_packaged(&output, "bad", 10, 10000, Some(packaging))
            .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn transport_proof_vector_and_binding() {
        let h = crate::hmac::HmacVerifier::new(b"test-secret".to_vec(), "a", "v", 300, 600);
        let proof = h.service_proof("nonce-vector-01", "service_vector01", 2, 200, b"hello");
        assert_eq!(
            proof,
            "28041485966e999c4d0f641a48f4853c08b5a372b1acbfab0cdca7a5a07bf51f"
        );
        assert_ne!(
            proof,
            h.service_proof("other", "service_vector01", 2, 200, b"hello")
        );
        assert_ne!(
            proof,
            h.service_proof("nonce-vector-01", "service_vector01", 2, 404, b"hello")
        );
        assert_ne!(
            proof,
            h.service_proof("nonce-vector-01", "service_vector01", 2, 200, b"changed")
        );
    }
}
