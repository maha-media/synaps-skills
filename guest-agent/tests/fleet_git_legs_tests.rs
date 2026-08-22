//! F7-G — the structural git legs (charter /tmp/synaps-skills-f7-charter.md).
//!
//! `src/fleet_git.rs` owns the REAL git plumbing for the guest's workspace
//! lifecycle: materialize a working tree from Pria's base bundle, commit the
//! agent's work iff the tree is dirty, and produce the thin result bundle
//! Pria's receive ladder expects (`<baseOid>..HEAD`, connectivity required,
//! bytes capped). Every git invocation is `std::process::Command` with argv
//! arrays — NEVER a shell, never string interpolation.
//!
//! Born-RED: fleet_git does not exist at birth. These rows drive REAL git in
//! hermetic temp dirs (the W5 Pria-side fleetGitTestUtil idiom, Rust-side).
//!
//! Run: cargo test --test fleet_git_legs_tests f7g

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use pria_guest_agent::fleet::parse_fleet_directive;
use pria_guest_agent::fleet_git::{
    clean_tree, clone_from_bundle, commit_if_dirty, make_result_bundle,
};

// ── F7-P: ws-token parse matrix ─────────────────────────────────────────────
//
// The fleet line grows an OPTIONAL 4th token `ws:<slug>` (slug charset
// `^[a-z0-9][a-z0-9_-]*$` — byte-twin of Pria's utils WORKSPACE_SLUG_RE).
// Absent ⇒ workspace-less binding (today's F6 behavior). Present+valid ⇒
// workspace-bound. Malformed ⇒ NO fleet binding at all (fail-closed).

#[test]
fn f7p_absent_ws_token_parses_workspace_less() {
    let d = parse_fleet_directive("set_task vault-curator@1\ndigest sha256:ab\nfleet fj-a 1")
        .expect("3-token fleet line still binds");
    assert_eq!(d.handle_id, "fj-a");
    assert_eq!(d.generation, 1);
    assert_eq!(d.workspace_slug(), None, "no ws token ⇒ workspace-less");
}

#[test]
fn f7p_valid_ws_token_binds_the_slug() {
    let d = parse_fleet_directive("set_task vault-curator@1\nfleet fj-a 1 ws:brandsite")
        .expect("ws-bound fleet line binds");
    assert_eq!(d.handle_id, "fj-a");
    assert_eq!(d.generation, 1);
    assert_eq!(d.workspace_slug(), Some("brandsite".to_string()));
}

#[test]
fn f7p_slug_charset_matrix() {
    for slug in ["a", "brandsite", "my-site", "my_site", "s1", "a1-b_c"] {
        let text = format!("set_task t@1\nfleet fj-a 1 ws:{slug}");
        let d = parse_fleet_directive(&text).unwrap_or_else(|| panic!("slug {slug} should bind"));
        assert_eq!(d.workspace_slug().as_deref(), Some(slug));
    }
}

#[test]
fn f7p_malformed_ws_token_fails_closed_no_binding() {
    for text in [
        "set_task t@1\nfleet fj-a 1 ws:",
        "set_task t@1\nfleet fj-a 1 ws:Upper",
        "set_task t@1\nfleet fj-a 1 ws:-leading",
        "set_task t@1\nfleet fj-a 1 ws:_leading",
        "set_task t@1\nfleet fj-a 1 ws:has space",
        "set_task t@1\nfleet fj-a 1 ws:dot.dot",
        "set_task t@1\nfleet fj-a 1 ws:slash/x",
        "set_task t@1\nfleet fj-a 1 ws:..",
        "set_task t@1\nfleet fj-a 1 ws:a\u{0}b",
        "set_task t@1\nfleet fj-a 1 wrong:brandsite",
        "set_task t@1\nfleet fj-a 1 ws:a ws:b",
        "set_task t@1\nfleet fj-a 1 ws:a extra",
    ] {
        assert_eq!(
            parse_fleet_directive(text),
            None,
            "malformed ws token must yield NO binding: {text:?}"
        );
    }
}

#[test]
fn f7p_envelope_borne_ws_token_parses() {
    let d = parse_fleet_directive("set_task t@1\nfleet fj-env 2 ws:site-x")
        .expect("envelope message parses");
    assert_eq!(d.workspace_slug().as_deref(), Some("site-x"));
}

// ── hermetic git helpers (test-side; the module under test owns its own) ────

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
    let dir = tmp("f7g-base");
    git(&["init", "-q", "-b", "main"], &dir);
    git(&["config", "user.email", "srv@pria"], &dir);
    git(&["config", "user.name", "pria"], &dir);
    fs::write(dir.join("README.md"), "base\n").unwrap();
    fs::create_dir_all(dir.join("docs")).unwrap();
    fs::write(dir.join("docs/keep.md"), "keep\n").unwrap();
    git(&["add", "-A"], &dir);
    git(&["commit", "-q", "-m", "base"], &dir);
    let base_oid = git(&["rev-parse", "HEAD"], &dir);
    let bundle_file = tmp("f7g-bundle").join("base.bundle");
    git(
        &["bundle", "create", bundle_file.to_str().unwrap(), "main"],
        &dir,
    );
    let bytes = fs::read(&bundle_file).unwrap();
    (dir, base_oid, bytes)
}

// ── F7-G1: clone from bundle produces a working tree at baseOid ─────────────

#[test]
fn f7g_clone_from_bundle_materializes_working_tree_at_base() {
    let (_srv, base_oid, bundle) = make_base();
    let dest = tmp("f7g-clone").join("work");
    let out = clone_from_bundle(&bundle, &dest).expect("clone ok");
    assert_eq!(out.base_oid, base_oid, "clone reports the base oid");
    assert!(dest.join("README.md").exists(), "working tree materialized");
    assert_eq!(
        fs::read_to_string(dest.join("docs/keep.md")).unwrap(),
        "keep\n"
    );
    // The HEAD of the clone IS the base commit.
    assert_eq!(git(&["rev-parse", "HEAD"], &dest), base_oid);
    // No remote is wired (bundles carry no remotes — C-7/never-credentials).
    let remotes = git(&["remote"], &dest);
    assert!(remotes.is_empty(), "no remote configured: {remotes:?}");
}

#[test]
fn f7g_clone_from_garbage_bundle_fails_closed() {
    let dest = tmp("f7g-bad").join("work");
    let out = clone_from_bundle(b"this is not a git bundle", &dest);
    assert!(out.is_err(), "garbage bundle must fail closed");
}

// ── F7-G2: clean_tree / commit_if_dirty ─────────────────────────────────────

#[test]
fn f7g_clean_tree_reports_clean_until_a_write_lands() {
    let (_srv, _base, bundle) = make_base();
    let dest = tmp("f7g-clean").join("work");
    clone_from_bundle(&bundle, &dest).unwrap();
    assert!(clean_tree(&dest).expect("status ok"), "fresh clone is clean");
    fs::write(dest.join("docs/out.md"), "result\n").unwrap();
    assert!(
        !clean_tree(&dest).expect("status ok"),
        "a write dirties the tree"
    );
}

#[test]
fn f7g_commit_if_dirty_is_a_noop_on_a_clean_tree() {
    let (_srv, base_oid, bundle) = make_base();
    let dest = tmp("f7g-noop").join("work");
    clone_from_bundle(&bundle, &dest).unwrap();
    let committed = commit_if_dirty(&dest, "vault-curator@1 fleet fj-a").expect("commit ok");
    assert_eq!(committed, None, "clean tree ⇒ no commit");
    assert_eq!(git(&["rev-parse", "HEAD"], &dest), base_oid, "HEAD unmoved");
}

#[test]
fn f7g_commit_if_dirty_commits_a_dirty_tree() {
    let (_srv, base_oid, bundle) = make_base();
    let dest = tmp("f7g-commit").join("work");
    clone_from_bundle(&bundle, &dest).unwrap();
    fs::write(dest.join("docs/out.md"), "result\n").unwrap();
    fs::write(dest.join("README.md"), "edited\n").unwrap();
    let committed = commit_if_dirty(&dest, "vault-curator@1 fleet fj-a")
        .expect("commit ok")
        .expect("dirty tree ⇒ a commit oid");
    assert_ne!(committed, base_oid, "HEAD advanced");
    assert_eq!(git(&["rev-parse", "HEAD"], &dest), committed);
    assert!(clean_tree(&dest).unwrap(), "tree clean after commit");
    // The commit message binds the task + handle (server-side audit corroboration).
    let msg = git(&["log", "-1", "--pretty=%B", "HEAD"], &dest);
    assert!(msg.contains("vault-curator@1") && msg.contains("fj-a"), "msg: {msg}");
}

// ── F7-G3: make_result_bundle is thin (<base>..HEAD) and fetches cleanly ────

#[test]
fn f7g_result_bundle_is_thin_and_fetchable() {
    let (_srv, base_oid, bundle) = make_base();
    let dest = tmp("f7g-push").join("work");
    clone_from_bundle(&bundle, &dest).unwrap();
    fs::write(dest.join("docs/out.md"), "result\n").unwrap();
    commit_if_dirty(&dest, "vault-curator@1 fleet fj-a").unwrap();
    let out = make_result_bundle(&dest, &base_oid).expect("bundle ok");
    assert!(!out.bytes.is_empty(), "bundle bytes produced");
    // The bundle is THIN: it requires baseOid as a prerequisite (connectivity
    // law — Pria's receive ladder rejects unrelated history).
    let probe = tmp("f7g-probe");
    git(&["init", "-q"], &probe);
    let bf = tmp("f7g-pb").join("r.bundle");
    fs::write(&bf, &out.bytes).unwrap();
    // A repo WITHOUT baseOid cannot fetch the thin bundle (prereq unsatisfied)…
    let no_base = Command::new("git")
        .args(["fetch", bf.to_str().unwrap(), "HEAD"])
        .current_dir(&probe)
        .output()
        .unwrap();
    assert!(
        !no_base.status.success(),
        "thin bundle must require baseOid (unrelated repo cannot fetch)"
    );
    // …but a repo WITH baseOid fetches it and the tip descends from base.
    git(&["fetch", _srv.to_str().unwrap(), "main"], &probe);
    git(
        &["fetch", bf.to_str().unwrap(), "+HEAD:refs/vm/fj-a/result"],
        &probe,
    );
    let tip = git(&["rev-parse", "refs/vm/fj-a/result"], &probe);
    git(&["merge-base", "--is-ancestor", &base_oid, &tip], &probe);
    let new_tip = git(&["rev-parse", "HEAD"], &dest);
    assert_eq!(tip, new_tip, "bundle tip == the committed work");
}

#[test]
fn f7g_result_bundle_on_no_work_is_empty_or_absent() {
    // Clean tree ⇒ nothing to push. The caller skips the push entirely; the
    // helper must not fabricate a bundle for an unchanged HEAD.
    let (_srv, base_oid, bundle) = make_base();
    let dest = tmp("f7g-empty").join("work");
    clone_from_bundle(&bundle, &dest).unwrap();
    let out = make_result_bundle(&dest, &base_oid);
    assert!(
        out.is_err() || out.as_ref().map(|o| o.bytes.is_empty()).unwrap_or(true),
        "no work ⇒ no pushable bundle"
    );
}
