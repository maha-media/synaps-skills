//! First functional source profile: committed Git blobs, no live worktree copy.
//! Local same-UID operation is functional evidence, NOT multi-user isolation.
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub mode: u32,
    pub content_base64: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceEnvelope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency_bundle_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_pack: Option<super::skill_pack::SkillPack>,
    pub version: u8,
    pub digest: String,
    pub files: Vec<SourceFile>,
    pub commit_oid: String,
    #[serde(default)]
    pub phases: Vec<super::build_sandbox::PhaseReceipt>,
}
pub struct Build {
    root: PathBuf,
    pub source: SourceEnvelope,
}
impl Build {
    pub fn output(&self) -> PathBuf {
        self.root.join("output")
    }
}
impl Drop for Build {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
async fn git(
    repo: &Path,
    args: &[&str],
    bound: usize,
    identity: Option<&super::RunAs>,
    cgroup_root: &Path,
) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncReadExt;
    let cgroup = super::build_cgroup::BuildCgroup::create(cgroup_root)?;
    let procs = cgroup.procs()?;
    let mut command = tokio::process::Command::new("/usr/bin/bwrap");
    command
        .args([
            "--unshare-all",
            "--die-with-parent",
            "--new-session",
            "--cap-drop",
            "ALL",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind",
            "/lib",
            "/lib",
            "--ro-bind",
            "/lib64",
            "/lib64",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--ro-bind",
        ])
        .arg(repo)
        .arg("/repo")
        .args(["--chdir", "/repo", "--", "/usr/bin/git"]);
    let identity = identity.cloned();
    unsafe {
        command.pre_exec(move || {
            use std::os::fd::AsRawFd;
            if libc::write(procs.as_raw_fd(), b"0".as_ptr().cast(), 1) != 1 {
                return Err(std::io::Error::last_os_error());
            }
            if let Some(ref id) = identity {
                if id.uid == 0
                    || id.gid == 0
                    || libc::setgroups(0, std::ptr::null()) != 0
                    || libc::setgid(id.gid) != 0
                    || libc::setuid(id.uid) != 0
                {
                    return Err(std::io::Error::from_raw_os_error(libc::EPERM));
                }
            } else if libc::geteuid() == 0 {
                return Err(std::io::Error::from_raw_os_error(libc::EPERM));
            }
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .env_clear()
        .env("PATH", "/usr/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ALLOW_PROTOCOL", "")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "safe.directory=/repo",
            "-c",
            "protocol.allow=never",
            "-c",
            "core.fsmonitor=false",
            "-C",
        ])
        .arg("/repo")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(10),
        child
            .stdout
            .take()
            .unwrap()
            .take(bound as u64 + 1)
            .read_to_end(&mut out),
    )
    .await
    .map_err(|_| "git timeout")?
    .map_err(|e| e.to_string())?;
    if out.len() > bound {
        return Err("Git source bounds exceeded".into());
    }
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
        .await
        .map_err(|_| "git timeout")?
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Git source unavailable".into());
    }
    Ok(out)
}
fn source_path(path: &str) -> bool {
    path.len() <= 1024
        && !path.is_empty()
        && path.split('/').enumerate().all(|(index, s)| {
            !s.is_empty()
                && s.len() <= 255
                && (!s.starts_with('.') || index + 1 == path.split('/').count())
                && s != "."
                && s != ".."
                && s != ".git"
                && !s.eq_ignore_ascii_case("node_modules")
                && !["id_rsa", "id_ed25519", "credentials"]
                    .contains(&s.to_ascii_lowercase().as_str())
                && s != "dist"
                && (!s.starts_with('.')
                    || [
                        ".gitignore",
                        ".gitattributes",
                        ".editorconfig",
                        ".prettierrc",
                        ".prettierignore",
                        ".eslintrc.json",
                        ".eslintrc",
                        ".npmrc",
                        ".env.example",
                    ]
                    .contains(&s))
                && (!s.to_ascii_lowercase().starts_with(".env") || s == ".env.example")
                && !s.to_ascii_lowercase().contains("secret")
                && !s.to_ascii_lowercase().contains("credential")
                && !s.ends_with(".pem")
                && ![".pem", ".key", ".p12", ".pfx"]
                    .iter()
                    .any(|suffix| s.to_ascii_lowercase().ends_with(suffix))
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-@".contains(&b))
        })
}
fn validate_dot_content(path: &str, bytes: &[u8]) -> Result<(), String> {
    let leaf = path.rsplit('/').next().unwrap_or("");
    if !leaf.starts_with('.') {
        return Ok(());
    }
    if bytes.len() > 65536 {
        return Err("source configuration bound".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "source config must be UTF8")?;
    if text
        .bytes()
        .any(|b| b < 0x20 && !b"\r\n\t".contains(&b) || b == 0x7f)
    {
        return Err("source config control byte".into());
    }
    let lower = text.to_ascii_lowercase();
    let credential_assignment = ["password", "token", "secret"].iter().any(|word| {
        lower
            .match_indices(word)
            .any(|(i, _)| lower[i + word.len()..].trim_start().starts_with([':', '=']))
    });
    let credential_url = ["http://", "https://"].iter().any(|scheme| {
        lower.split(scheme).skip(1).any(|tail| {
            tail.split(|c: char| c == '/' || c.is_whitespace())
                .next()
                .unwrap_or("")
                .contains('@')
        })
    });
    if leaf != ".env.example"
        && (lower.contains("_auth")
            || credential_assignment
            || lower.contains("private key")
            || credential_url)
    {
        return Err("source config credentials refused".into());
    }
    for line in text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        if leaf == ".npmrc"
            && !line.starts_with(';')
            && line != "registry=https://registry.npmjs.org/"
        {
            return Err("unsupported npm config".into());
        }
        if leaf == ".env.example" {
            let key = line
                .strip_suffix('=')
                .ok_or("env example values forbidden")?;
            if key.is_empty()
                || !key.bytes().enumerate().all(|(i, b)| {
                    b == b'_' || b.is_ascii_alphabetic() || i > 0 && b.is_ascii_digit()
                })
            {
                return Err("invalid env example key".into());
            }
        }
    }
    Ok(())
}

async fn export(
    repo: &Path,
    dest: &Path,
    identity: Option<&super::RunAs>,
    cgroup_root: &Path,
) -> Result<SourceEnvelope, String> {
    let oid = git(
        repo,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        128,
        identity,
        cgroup_root,
    )
    .await?;
    let oid = std::str::from_utf8(&oid).map_err(|e| e.to_string())?.trim();
    if !(oid.len() == 40 || oid.len() == 64) || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid commit oid".into());
    }
    // Validate stored object identity and graph before extracting pinned blobs.
    // Runs inside offline namespace as workload UID, never guest root.
    git(
        repo,
        &["fsck", "--strict", "--no-reflogs", oid],
        512 * 1024,
        identity,
        cgroup_root,
    )
    .await?;
    let tree = git(
        repo,
        &["ls-tree", "-r", "-z", "-l", oid],
        512 * 1024,
        identity,
        cgroup_root,
    )
    .await?;
    let mut files = Vec::new();
    let mut total = 0usize;
    for row in tree.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        if files.len() >= 2000 {
            return Err("source file bound".into());
        }
        let row = std::str::from_utf8(row).map_err(|e| e.to_string())?;
        let (meta, path) = row.split_once('\t').ok_or("invalid Git tree")?;
        if !source_path(path) {
            return Err("unsafe committed source path".into());
        }
        let fields: Vec<_> = meta.split_whitespace().collect();
        if fields.len() != 4
            || fields[1] != "blob"
            || !["100644", "100755"].contains(&fields[0])
            || !fields[2].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("nonregular Git source".into());
        }
        let size: usize = fields[3].parse().map_err(|_| "invalid blob size")?;
        total = total.checked_add(size).ok_or("source bound")?;
        if total > 4 * 1024 * 1024 {
            return Err("source byte bound".into());
        }
        let bytes = git(
            repo,
            &["cat-file", "blob", fields[2]],
            size,
            identity,
            cgroup_root,
        )
        .await?;
        if bytes.len() != size || bytes.windows(11).any(|b| b == b"PRIVATE KEY") {
            return Err("invalid source bytes".into());
        }
        validate_dot_content(path, &bytes)?;
        let mode = if fields[0] == "100755" { 493 } else { 420 };
        let target = dest.join(path);
        std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode))
            .map_err(|e| e.to_string())?;
        files.push(SourceFile {
            path: path.into(),
            size: size as u64,
            sha256: hex::encode(Sha256::digest(&bytes)),
            mode,
            content_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    for required in ["package.json", "package-lock.json"] {
        if !files.iter().any(|f| f.path == required) {
            return Err("prepared package and lockfile required".into());
        }
    }
    let tuples: Vec<_> = files.iter().map(|f| (&f.path, f.size, &f.sha256)).collect();
    let digest = hex::encode(Sha256::digest(
        serde_json::to_vec(&tuples).map_err(|e| e.to_string())?,
    ));
    Ok(SourceEnvelope {
        dependency_bundle_digest: None,
        skill_pack: None,
        version: 1,
        commit_oid: oid.into(),
        phases: vec![],
        digest,
        files,
    })
}
pub async fn build(
    repo: &Path,
    deps: &Path,
    commands: &[Vec<String>],
    identity: Option<super::RunAs>,
    cgroup_root: Option<&Path>,
) -> Result<Build, String> {
    build_with_pack(repo, deps, commands, identity, cgroup_root, None).await
}
pub async fn build_with_pack(
    repo: &Path,
    deps: &Path,
    commands: &[Vec<String>],
    identity: Option<super::RunAs>,
    cgroup_root: Option<&Path>,
    pack: Option<&super::skill_pack::VerifiedPack>,
) -> Result<Build, String> {
    let cgroup_root = cgroup_root.ok_or("source builds require delegated cgroup limits")?;
    // Refuse before any Git export or workload execution. Parent is never changed.
    drop(super::build_cgroup::BuildCgroup::create(cgroup_root)?);
    static ACTIVE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let _permit = ACTIVE.try_acquire().map_err(|_| "source build busy")?;
    tokio::time::timeout(
        Duration::from_secs(270),
        build_inner(repo, deps, commands, identity, Some(cgroup_root), pack),
    )
    .await
    .map_err(|_| "whole source build timeout")?
}
async fn build_inner(
    repo: &Path,
    deps: &Path,
    commands: &[Vec<String>],
    identity: Option<super::RunAs>,
    cgroup_root: Option<&Path>,
    pack: Option<&super::skill_pack::VerifiedPack>,
) -> Result<Build, String> {
    let bundle = super::dependency_bundle::verify(deps)?;
    let expected = vec![
        vec!["npm", "test", "--", "--run"],
        vec!["npm", "run", "build", "--", "--outDir", "/output"],
    ];
    if commands != expected {
        return Err("unsupported build commands: require npm test -- --run then npm run build -- --outDir /output".into());
    }
    let root = std::env::temp_dir().join(format!("pria-source-build-{}", uuid::Uuid::new_v4()));
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .map_err(|e| e.to_string())?;
    if let Some(ref id) = identity {
        let p = std::ffi::CString::new(root.as_os_str().as_encoded_bytes())
            .map_err(|e| e.to_string())?;
        // Guest owns the immutable root; only scoped group may traverse/read.
        if unsafe { libc::chown(p.as_ptr(), 0, id.gid) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o750))
            .map_err(|e| e.to_string())?;
    }
    let mut build = Build {
        root,
        source: SourceEnvelope {
            dependency_bundle_digest: None,
            skill_pack: None,
            version: 1,
            commit_oid: String::new(),
            phases: vec![],
            digest: String::new(),
            files: vec![],
        },
    };
    let source = build.root.join("source");
    std::fs::create_dir(&source).map_err(|e| e.to_string())?;
    build.source = export(
        repo,
        &source,
        identity.as_ref(),
        cgroup_root.ok_or("cgroup required")?,
    )
    .await?;
    bundle.check_source(&build.source)?;
    build.source.dependency_bundle_digest = Some(bundle.digest.clone());
    if let Some(pack) = pack {
        pack.check_source(&build.source)?;
        build.source.skill_pack = Some(pack.identity.clone());
    }
    std::fs::create_dir(source.join("node_modules")).map_err(|e| e.to_string())?;
    std::fs::create_dir(build.output()).map_err(|e| e.to_string())?;
    if let Some(ref id) = identity {
        let p = std::ffi::CString::new(build.output().as_os_str().as_encoded_bytes())
            .map_err(|e| e.to_string())?;
        if unsafe { libc::chown(p.as_ptr(), id.uid, id.gid) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    for command in commands {
        // Defensive recheck also catches accidental fixture/admin mutations.
        if super::dependency_bundle::verify(deps)?.digest != bundle.digest {
            return Err("dependency bundle changed between phases".into());
        }
        let phase = super::build_sandbox::run_scoped(
            &source,
            deps,
            &build.output(),
            command,
            Duration::from_secs(120),
            identity.clone(),
            cgroup_root,
        )
        .await?;
        build.source.phases.push(phase);
    }
    if super::dependency_bundle::verify(deps)?.digest != bundle.digest {
        return Err("dependency bundle changed during build".into());
    }
    // The mount is RO to build code; verify exact exported files/modes too.
    for f in &build.source.files {
        let p = source.join(&f.path);
        let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
        if hex::encode(Sha256::digest(bytes)) != f.sha256
            || std::fs::metadata(p)
                .map_err(|e| e.to_string())?
                .permissions()
                .mode()
                & 0o777
                != f.mode
        {
            return Err("source mutated during build".into());
        }
    }
    Ok(build)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn absent_cgroup_refuses_before_export() {
        let error = build(
            Path::new("/nonexistent"),
            Path::new("/nonexistent"),
            &[],
            None,
            None,
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("require delegated cgroup"));
    }
    #[test]
    fn source_dotconfigs_match_safe_node_profile() {
        for (path, content) in [
            (
                ".npmrc",
                "# prepared offline\nregistry=https://registry.npmjs.org/\n",
            ),
            (".env.example", "API_TOKEN=\n# no value\n"),
            ("config/.eslintrc", "{}"),
            (".gitignore", "secrets/\ntokens/\n"),
        ] {
            assert!(source_path(path), "{path}");
            assert!(
                validate_dot_content(path, content.as_bytes()).is_ok(),
                "{path}"
            );
        }
        for path in [
            ".npmrc/child",
            ".private/a",
            "a/.env",
            "a/credentials",
            "a/private.KEY",
        ] {
            assert!(!source_path(path), "{path}");
        }
        for (path, content) in [
            (".npmrc", "ignore-scripts=false"),
            (".env.example", "TOKEN=value"),
            (".eslintrc", "token : value"),
            (".gitignore", "https://user:pass@example.invalid/path"),
        ] {
            assert!(
                validate_dot_content(path, content.as_bytes()).is_err(),
                "{path}"
            );
        }
    }
    // Opt-in existing dependencies only: no npm install, network, or host writes.
    #[tokio::test]
    async fn actual_vite_build_with_private_pid_budget() {
        let Some(deps) = std::env::var_os("PRIA_TEST_VITE_DEPS") else {
            return;
        };
        let cgroup = std::env::var_os("PRIA_TEST_CGROUP_ROOT")
            .expect("Vite regression requires delegated cgroup");
        let root = std::env::temp_dir().join(format!("source-vite-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git_fixture(&repo, &["init", "-q"]);
        std::fs::write(
            repo.join("package.json"),
            r#"{"type":"module","scripts":{"test":"node check.cjs","build":"vite build"}}"#,
        )
        .unwrap();
        std::fs::write(repo.join("package-lock.json"), r#"{"lockfileVersion":3}"#).unwrap();
        std::fs::write(repo.join("check.cjs"), "if(process.env.RAYON_NUM_THREADS!=='2'||process.env.ROLLDOWN_WORKER_THREADS!=='2')process.exit(1)").unwrap();
        std::fs::write(
            repo.join("index.html"),
            "<html><body><script type=module src='./main.js'></script></body></html>",
        )
        .unwrap();
        std::fs::write(
            repo.join("main.js"),
            "document.body.dataset.built='real-vite';",
        )
        .unwrap();
        git_fixture(&repo, &["add", "."]);
        let tree = git_fixture(&repo, &["write-tree"]);
        let commit = git_fixture(
            &repo,
            &["commit-tree", &tree, "-m", "disposable Vite regression"],
        );
        git_fixture(&repo, &["update-ref", "HEAD", &commit]);
        let commands = vec![
            vec!["npm", "test", "--", "--run"],
            vec!["npm", "run", "build", "--", "--outDir", "/output"],
        ]
        .into_iter()
        .map(|v| v.into_iter().map(String::from).collect())
        .collect::<Vec<_>>();
        let deps = std::fs::canonicalize(deps).unwrap();
        let built = build(&repo, &deps, &commands, None, Some(Path::new(&cgroup)))
            .await
            .unwrap();
        assert!(built.output().join("index.html").is_file());
        assert!(built.output().join("assets").is_dir());
        assert_eq!(built.source.phases.len(), 2);
        assert!(built.source.phases[1].stdout.contains("vite v"));
        drop(built);
        std::fs::remove_dir_all(root).unwrap();
    }
    fn git_fixture(repo: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().into()
    }
    #[tokio::test]
    async fn committed_source_executes_and_failed_checks_never_produce_receipt() {
        let root = std::env::temp_dir().join(format!("source-build-test-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        let deps = root.join("dependencies");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir(&deps).unwrap();
        git_fixture(&repo, &["init", "-q"]);
        std::fs::write(
            repo.join("package.json"),
            r#"{"scripts":{"test":"node check.cjs","build":"node build.cjs"}}"#,
        )
        .unwrap();
        std::fs::write(repo.join("package-lock.json"), r#"{"lockfileVersion":3}"#).unwrap();
        super::super::dependency_bundle::empty_fixture(&deps, &repo.join("package-lock.json"));
        std::fs::write(repo.join("check.cjs"),"const fs=require('fs');if(fs.readFileSync('input','utf8')!=='committed')process.exit(1);try{fs.writeFileSync('input','bad');process.exit(2)}catch{};").unwrap();
        std::fs::write(repo.join("build.cjs"),"require('fs').writeFileSync('/output/index.html',require('fs').readFileSync('input'));").unwrap();
        std::fs::write(repo.join("input"), "committed").unwrap();
        std::fs::set_permissions(
            repo.join("build.cjs"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        // Synthetic objects in a disposable fixture only; no project commits.
        git_fixture(&repo, &["add", "."]);
        let tree = git_fixture(&repo, &["write-tree"]);
        let commit = git_fixture(&repo, &["commit-tree", &tree, "-m", "fixture"]);
        git_fixture(&repo, &["update-ref", "HEAD", &commit]);
        std::fs::write(repo.join("input"), "uncommitted writer").unwrap();
        let commands = vec![
            vec!["npm", "test", "--", "--run"],
            vec!["npm", "run", "build", "--", "--outDir", "/output"],
        ]
        .into_iter()
        .map(|v| v.into_iter().map(String::from).collect())
        .collect::<Vec<_>>();
        let Some(cgroup) = std::env::var_os("PRIA_TEST_CGROUP_ROOT") else {
            return;
        };
        let built = build(&repo, &deps, &commands, None, Some(Path::new(&cgroup)))
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(built.output().join("index.html")).unwrap(),
            "committed"
        );
        assert_eq!(
            built
                .source
                .files
                .iter()
                .find(|f| f.path == "build.cjs")
                .unwrap()
                .mode,
            493
        );
        let retained = super::super::retained::RetainedStore::new(root.join("retained"));
        let receipt = retained
            .seal_with_source(
                &built.output(),
                "revision",
                100,
                10000,
                None,
                Some(built.source.clone()),
            )
            .unwrap();
        assert_eq!(receipt.source.unwrap(), built.source);
        drop(built);
        std::fs::write(repo.join("package-lock.json"), r#"{"lockfileVersion":2}"#).unwrap();
        git_fixture(&repo, &["add", "."]);
        let tree = git_fixture(&repo, &["write-tree"]);
        let commit = git_fixture(&repo, &["commit-tree", &tree, "-m", "lock mismatch"]);
        git_fixture(&repo, &["update-ref", "HEAD", &commit]);
        let error = build(&repo, &deps, &commands, None, Some(Path::new(&cgroup)))
            .await
            .err()
            .unwrap();
        assert!(error.contains("committed lock does not match"), "{error}");
        std::fs::write(repo.join("package-lock.json"), r#"{"lockfileVersion":3}"#).unwrap();
        std::fs::write(repo.join("check.cjs"), "process.exit(9)").unwrap();
        git_fixture(&repo, &["add", "."]);
        let tree = git_fixture(&repo, &["write-tree"]);
        let commit = git_fixture(&repo, &["commit-tree", &tree, "-m", "failing fixture"]);
        git_fixture(&repo, &["update-ref", "HEAD", &commit]);
        assert!(
            build(&repo, &deps, &commands, None, Some(Path::new(&cgroup)))
                .await
                .is_err()
        );
        assert!(root.join("retained/artifact-revision.json").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }
}
