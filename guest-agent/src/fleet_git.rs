//! F7 — the guest's structural git legs (VM-FLEET W5, plan §2.6; charter
//! /tmp/synaps-skills-f7-charter.md; rulings R-F7-1..3).
//!
//! WHY THIS EXISTS. A workspace-bound fleet task runs inside a REAL git
//! working tree cloned from Pria's base bundle, and the result rides back as
//! a thin git bundle the receive ladder (`agentFleetGitReceive`) can judge.
//! This module owns the git plumbing and NOTHING else — the fleet lifecycle
//! (`FleetBindings`) drives it; it never talks to Pria, never reads the wire,
//! never decides policy.
//!
//! TRUST SHAPE (mirrors the Pria-side receive):
//!   * clone_from_bundle — materialize a working tree from bundle BYTES (the
//!     fleet-git-fetch answer). Bundles carry no remotes and no credentials
//!     (C-7): the clone is a standalone repo rooted at the session's scratch.
//!   * commit_if_dirty — `git add -A && commit` IFF the tree is dirty; a clean
//!     tree is a no-op (the caller then skips the push and answers ok:true —
//!     no fabricated artifact, Pria's R-W5-3 terminal law).
//!   * make_result_bundle — `git bundle create <tmp> <baseOid>..HEAD`: THIN,
//!     connectivity to baseOid REQUIRED (Pria refuses unrelated history), and
//!     byte-bounded. Empty range (no work) ⇒ error (the caller skips push).
//!
//! GIT DISCIPLINE: every invocation is `std::process::Command` with an argv
//! array — NEVER a shell, never string interpolation into a command line, and
//! every path is a `&Path` the caller jails (the session's scratch dir).

use std::path::{Path, PathBuf};
use std::process::Command;

/// A git-leg failure (non-fatal — the fleet lifecycle maps it to an honest
/// workspace-less / push_refused outcome, never a crash).
#[derive(Debug)]
pub struct GitError(String);

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for GitError {}

fn err(msg: impl Into<String>) -> GitError {
    GitError(msg.into())
}

/// Run `git <args>` in `cwd`, returning trimmed stdout. argv-array only.
fn git(args: &[&str], cwd: &Path) -> Result<String, GitError> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| err(format!("git spawn failed: {e}")))?;
    if !out.status.success() {
        return Err(err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The result of a successful clone: the working tree path and the base oid
/// the clone's HEAD sits on (the connectivity anchor for the result bundle).
#[derive(Debug, Clone)]
pub struct CloneOutcome {
    pub base_oid: String,
    pub work_dir: PathBuf,
}

/// The result bundle bytes plus the tip they carry.
#[derive(Debug, Clone)]
pub struct BundleOutcome {
    pub bytes: Vec<u8>,
    pub tip: String,
}

/// Materialize a REAL git working tree at `dest` from bundle `bytes`.
///
/// The bundle is Pria's seed of `refs/sync/<slug>/main` (a single tip). We
/// init a fresh repo, write the bundle to a temp file inside it, fetch the
/// bundle's tip, and check it out. No remote is configured (bundles carry no
/// remotes — credentials never enter the clone). Returns the base oid (the
/// fetched HEAD) so the caller can anchor the result bundle's thin range.
pub fn clone_from_bundle(bytes: &[u8], dest: &Path) -> Result<CloneOutcome, GitError> {
    if bytes.is_empty() {
        return Err(err("empty bundle"));
    }
    std::fs::create_dir_all(dest).map_err(|e| err(format!("mkdir dest: {e}")))?;
    git(&["init", "-q", "-b", "main"], dest)?;
    git(&["config", "user.email", "fleet@guest"], dest)?;
    git(&["config", "user.name", "pria-fleet-guest"], dest)?;
    let bundle_file = dest.join(".git").join("incoming.bundle");
    std::fs::write(&bundle_file, bytes).map_err(|e| err(format!("write bundle: {e}")))?;
    let bf = bundle_file.to_string_lossy().to_string();
    // Structural integrity + the tip it carries. A garbage bundle fails here.
    git(&["bundle", "verify", &bf], dest)?;
    // Fetch the bundle's HEAD (whatever ref it carries) into FETCH_HEAD.
    git(&["fetch", "-q", &bf, "HEAD"], dest)
        .or_else(|_| git(&["fetch", "-q", &bf, "main"], dest))?;
    git(&["checkout", "-q", "FETCH_HEAD"], dest)?;
    let base_oid = git(&["rev-parse", "HEAD"], dest)?;
    std::fs::remove_file(&bundle_file).ok();
    Ok(CloneOutcome {
        base_oid,
        work_dir: dest.to_path_buf(),
    })
}

/// Is the working tree clean (no staged/unstaged/untracked changes)?
pub fn clean_tree(work_dir: &Path) -> Result<bool, GitError> {
    let status = git(&["status", "--porcelain"], work_dir)?;
    Ok(status.is_empty())
}

/// `git add -A && git commit -m <message>` IFF the tree is dirty. Returns the
/// new commit oid, or `None` when the tree was clean (no commit created).
pub fn commit_if_dirty(work_dir: &Path, message: &str) -> Result<Option<String>, GitError> {
    if clean_tree(work_dir)? {
        return Ok(None);
    }
    git(&["add", "-A"], work_dir)?;
    git(&["commit", "-q", "--allow-empty", "-m", message], work_dir)?;
    let oid = git(&["rev-parse", "HEAD"], work_dir)?;
    Ok(Some(oid))
}

/// Produce the THIN result bundle `<base_oid>..HEAD` for the result ref.
///
/// The range excludes the base history (Pria's receive ladder requires
/// connectivity to baseOid and caps bytes). An empty range — HEAD == base,
/// no work — is an error: the caller skips the push and answers ok:true.
pub fn make_result_bundle(work_dir: &Path, base_oid: &str) -> Result<BundleOutcome, GitError> {
    let tip = git(&["rev-parse", "HEAD"], work_dir)?;
    if tip == base_oid {
        return Err(err("no work: HEAD == base_oid"));
    }
    // The declared result ref rides the bundle so the fetch side can name it.
    let range = format!("{base_oid}..HEAD");
    let bundle_file = work_dir.join(".git").join("result.bundle");
    let bf = bundle_file.to_string_lossy().to_string();
    git(&["bundle", "create", &bf, &range], work_dir)?;
    let bytes = std::fs::read(&bundle_file).map_err(|e| err(format!("read bundle: {e}")))?;
    std::fs::remove_file(&bundle_file).ok();
    if bytes.is_empty() {
        return Err(err("empty result bundle"));
    }
    Ok(BundleOutcome { bytes, tip })
}
