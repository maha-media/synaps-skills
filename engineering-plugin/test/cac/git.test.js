/*
 * git.test.js — tests for lib/cac/git.js (spec §4 / §7 git probes).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const git = require("../../lib/cac/git.js");

// Build an injectable runner that records calls and returns canned output.
function fakeRunner(map) {
  const calls = [];
  const run = (args, cwd) => {
    calls.push({ args, cwd });
    const key = args.join(" ");
    if (!(key in map)) throw new Error("unexpected git call: " + key);
    return map[key];
  };
  return { run, calls };
}

test("headCommit returns trimmed sha from injected runner output", () => {
  const { run, calls } = fakeRunner({
    "rev-parse HEAD": { stdout: "  deadbeefcafe1234\n", status: 0 },
  });
  const sha = git.headCommit("/repo", { run });
  assert.equal(sha, "deadbeefcafe1234");
  assert.equal(calls[0].cwd, "/repo");
  assert.deepEqual(calls[0].args, ["rev-parse", "HEAD"]);
});

test("headCommit throws on non-zero status", () => {
  const { run } = fakeRunner({
    "rev-parse HEAD": { stdout: "", status: 128, stderr: "fatal: not a git repository" },
  });
  assert.throws(() => git.headCommit("/repo", { run }), /rev-parse HEAD failed/);
});

test("headCommit throws on empty output even with status 0", () => {
  const { run } = fakeRunner({ "rev-parse HEAD": { stdout: "   \n", status: 0 } });
  assert.throws(() => git.headCommit("/repo", { run }), /empty output/);
});

test("treeClean true when porcelain output empty", () => {
  const { run } = fakeRunner({ "status --porcelain": { stdout: "\n", status: 0 } });
  assert.equal(git.treeClean("/repo", { run }), true);
});

test("treeClean false when porcelain output non-empty", () => {
  const { run } = fakeRunner({
    "status --porcelain": { stdout: " M lib/cac/git.js\n?? new.txt\n", status: 0 },
  });
  assert.equal(git.treeClean("/repo", { run }), false);
});

test("treeClean throws on non-zero status", () => {
  const { run } = fakeRunner({ "status --porcelain": { stdout: "", status: 1, stderr: "boom" } });
  assert.throws(() => git.treeClean("/repo", { run }), /status --porcelain failed/);
});

test("opts.run must be a function when provided", () => {
  assert.throws(() => git.headCommit("/repo", { run: 42 }), /opts\.run must be a function/);
});

test("repoRoot must be a non-empty string", () => {
  assert.throws(() => git.headCommit("", {}), /repoRoot must be a non-empty string/);
});

// Real-repo smoke test, guarded by git availability + spawn success.
const gitAvailable = (() => {
  try {
    const r = cp.spawnSync("git", ["--version"], { encoding: "utf8" });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
})();

test("real temp repo: headCommit + treeClean reflect ground truth", { skip: !gitAvailable }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cac-git-"));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const sh = (args) => {
      const r = cp.spawnSync("git", args, { cwd: dir, encoding: "utf8", env });
      assert.equal(r.status, 0, "git " + args.join(" ") + ": " + (r.stderr || ""));
      return r;
    };
    sh(["init", "-q"]);
    sh(["config", "user.email", "t@t"]);
    sh(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
    sh(["add", "."]);
    sh(["commit", "-q", "-m", "init"]);

    const sha = git.headCommit(dir);
    assert.match(sha, /^[0-9a-f]{7,40}$/);
    assert.equal(git.treeClean(dir), true);

    // Make it dirty.
    fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
    assert.equal(git.treeClean(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
