//! F7-O — ownership immunity for the guest's git legs (W5 staging finding
//! fj-b6107573).
//!
//! THE INCIDENT. The write-reachability fix (40b4ba4) chowns the fleet clone
//! to the SESSION uid so the SynapsCLI agent (dropped to uid) can write it —
//! but the guest-agent daemon runs as ROOT, so every git invocation it makes
//! AFTER the chown operates on a tree git considers foreign-owned. git's
//! `safe.directory` guard (git ≥2.35.2) then refuses with "detected dubious
//! ownership", `commit_if_dirty` errored at the result moment, and the old
//! fail-open mapped it to a silent clean: `result {ok:true}`, zero push, no
//! resultOid — a fabricated no-artifact success.
//!
//! THE LAW. Every `fleet_git` invocation must be immune to the ownership
//! guard for exactly the jailed worktree it is handed — `-c
//! safe.directory=<cwd>` on the argv (protected "command" scope, honored
//! since git 2.38; never a global-config mutation, never `*`).
//!
//! THE LEVER. `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` is git's OWN test lever for
//! exactly this state (setup.c `ensure_valid_ownership`): it makes git treat
//! every discovered repo as foreign-owned, reproducing the root-vs-uid split
//! hermetically. This file stays a SINGLE test: the lever is process-global
//! env, and the clone below must run before it flips on.
//!
//! Run: cargo test --test fleet_git_ownership_tests f7o

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use pria_guest_agent::fleet_git::{
    clean_tree, clone_from_bundle, commit_if_dirty, make_result_bundle,
};

// ── hermetic git helpers (the F7-G idiom — REAL git in temp dirs) ────────────

fn tmp(prefix: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&d).unwrap();
    d
}

fn git(args: &[&str], cwd: &Path) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap_or_else(|e| panic!("git spawn failed: {e}"));
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A "server-side" base repo with one commit, and a git bundle of its main
/// ref — the bytes Pria's fleet-git-fetch streams to the guest.
fn make_base() -> (PathBuf, String, Vec<u8>) {
    let dir = tmp("f7o-base");
    git(&["init", "-q", "-b", "main"], &dir);
    git(&["config", "user.email", "srv@pria"], &dir);
    git(&["config", "user.name", "pria"], &dir);
    fs::write(dir.join("README.md"), "base\n").unwrap();
    git(&["add", "-A"], &dir);
    git(&["commit", "-q", "-m", "base"], &dir);
    let base_oid = git(&["rev-parse", "HEAD"], &dir);
    let bundle_file = tmp("f7o-bundle").join("base.bundle");
    git(
        &["bundle", "create", bundle_file.to_str().unwrap(), "main"],
        &dir,
    );
    let bytes = fs::read(&bundle_file).unwrap();
    (dir, base_oid, bytes)
}

/// Unsets the lever even on panic — a leaked env var must never poison a
/// rerun in the same process.
struct EnvGuard;
impl Drop for EnvGuard {
    fn drop(&mut self) {
        std::env::remove_var("GIT_TEST_ASSUME_DIFFERENT_OWNER");
    }
}

// ── F7-O1: the full result-moment chain survives a foreign-owned worktree ────

/// The staging fj-b6107573 shape end-to-end: clone as ourselves (the daemon
/// clones BEFORE the chown, so ownership matches at birth), flip the tree to
/// foreign-owned, then drive the ENTIRE result-moment chain — status, add,
/// commit, rev-parse, bundle create — and demand every leg survives.
#[test]
fn f7o1_result_moment_chain_survives_foreign_owned_worktree() {
    let (_base, base_oid, bundle) = make_base();
    let dest = tmp("f7o-clone").join("worktree");
    let clone = clone_from_bundle(&bundle, &dest).expect("clone (self-owned at birth) succeeds");
    assert_eq!(clone.base_oid, base_oid);

    // The chown moment: from here on, git sees the worktree as foreign-owned.
    std::env::set_var("GIT_TEST_ASSUME_DIFFERENT_OWNER", "1");
    let _guard = EnvGuard;

    assert!(
        clean_tree(&clone.work_dir).expect("clean_tree must survive foreign ownership"),
        "fresh clone reports clean"
    );

    fs::write(clone.work_dir.join("curated.md"), "the agent's work\n").unwrap();
    assert!(
        !clean_tree(&clone.work_dir).expect("dirty-detection must survive foreign ownership"),
        "a write lands as dirty"
    );

    let oid = commit_if_dirty(&clone.work_dir, "fleet fj-o1")
        .expect("commit must survive foreign ownership — NEVER a silent clean")
        .expect("dirty tree mints a commit");

    let out = make_result_bundle(&clone.work_dir, &clone.base_oid)
        .expect("result bundle must survive foreign ownership");
    assert_eq!(out.tip, oid, "the bundle carries the minted commit");
    assert!(!out.bytes.is_empty(), "real bundle bytes");
}
