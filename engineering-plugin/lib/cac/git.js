/*
 * git.js — Checkpoint-Aware Compaction (CAC) git probes.
 * Implements spec §4 (safe-point invalidators: dirty tree) and §7/§10 support
 * for the pre-compact wall — the live tree-clean / HEAD-commit probes used to
 * assert ground truth before compaction.
 *
 * Uses ONLY Node stdlib `node:child_process` (no deps), mirroring the repo
 * spawnSync pattern: cp.spawnSync("git", args, { cwd, encoding: "utf8" }).
 *
 * Dependency injection (for hermetic unit tests):
 *   Every probe accepts an optional `opts` whose `opts.run` is a runner with
 *   the contract:
 *       run(args, cwd) -> { stdout: string, status: number, stderr?: string }
 *   where `status === 0` means success. When `opts.run` is absent a real
 *   spawnSync-backed runner is used. This lets tests inject fake git output
 *   without touching a real repository.
 */
"use strict";

const cp = require("node:child_process");

/**
 * Default runner: real `git` via spawnSync.
 * @param {string[]} args git argv (without the leading "git")
 * @param {string} cwd repository working directory
 * @returns {{stdout: string, status: number, stderr: string}}
 */
function defaultRun(args, cwd) {
  const res = cp.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.error) {
    // git not found / failed to spawn — surface a clear error.
    const e = new Error("git invocation failed: " + res.error.message);
    e.cause = res.error;
    throw e;
  }
  return {
    stdout: typeof res.stdout === "string" ? res.stdout : "",
    stderr: typeof res.stderr === "string" ? res.stderr : "",
    status: typeof res.status === "number" ? res.status : 1,
  };
}

function runnerOf(opts) {
  opts = opts || {};
  if (opts.run !== undefined && typeof opts.run !== "function") {
    throw new Error("opts.run must be a function (args, cwd) -> {stdout, status}");
  }
  return typeof opts.run === "function" ? opts.run : defaultRun;
}

function assertRepoRoot(repoRoot) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new Error("repoRoot must be a non-empty string");
  }
}

/**
 * Current HEAD commit sha (trimmed). Throws a clear Error if git fails.
 * @param {string} repoRoot
 * @param {{run?: Function}} [opts]
 * @returns {string} 40-char (or abbreviated) commit sha
 */
function headCommit(repoRoot, opts) {
  assertRepoRoot(repoRoot);
  const run = runnerOf(opts);
  const res = run(["rev-parse", "HEAD"], repoRoot) || {};
  if (res.status !== 0) {
    throw new Error(
      "git rev-parse HEAD failed (status " + String(res.status) + ")" +
        (res.stderr ? ": " + String(res.stderr).trim() : "")
    );
  }
  const sha = String(res.stdout == null ? "" : res.stdout).trim();
  if (sha.length === 0) {
    throw new Error("git rev-parse HEAD returned empty output");
  }
  return sha;
}

/**
 * True iff the working tree is clean (no staged/unstaged/untracked changes),
 * determined by an empty `git status --porcelain`. Throws if git fails.
 * @param {string} repoRoot
 * @param {{run?: Function}} [opts]
 * @returns {boolean}
 */
function treeClean(repoRoot, opts) {
  assertRepoRoot(repoRoot);
  const run = runnerOf(opts);
  const res = run(["status", "--porcelain"], repoRoot) || {};
  if (res.status !== 0) {
    throw new Error(
      "git status --porcelain failed (status " + String(res.status) + ")" +
        (res.stderr ? ": " + String(res.stderr).trim() : "")
    );
  }
  return String(res.stdout == null ? "" : res.stdout).trim().length === 0;
}

module.exports = { headCommit, treeClean, defaultRun };
