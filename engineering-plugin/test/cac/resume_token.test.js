/*
 * resume_token.test.js — tests for lib/cac/resume_token.js (spec §5.1).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RT = require("../../lib/cac/resume_token.js");

function mkRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cac-rt-"));
}
function rmRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function fullToken(slug) {
  return {
    schema: "resume/1",
    slug: slug,
    branch: "feat/html-plan-ecosystem",
    worktree: "/abs/path/.worktrees/x",
    active_phase: "O5",
    last_checkpoint: "C-O4",
    next_action: "fix oracle survivors; re-run self-play",
    head_commit: "b344bf1",
    outstanding: ["selfplay state=not-done, outstanding_finds=3"],
    pending_subagents: [],
    loop: { kind: "convergence", continue: true },
    issued_at: "2026-06-25T14:46:00Z",
  };
}

test("round-trips a full token through write→read losslessly", () => {
  const repo = mkRepo();
  try {
    const slug = "html-plan-ecosystem";
    const tok = fullToken(slug);
    RT.write(repo, slug, tok);
    const got = RT.read(repo, slug);
    assert.deepEqual(got, tok);
  } finally {
    rmRepo(repo);
  }
});

test("missing next_action is rejected", () => {
  const repo = mkRepo();
  try {
    const slug = "myslug";
    const tok = fullToken(slug);
    delete tok.next_action;
    assert.throws(() => RT.write(repo, slug, tok), /next_action/);
  } finally {
    rmRepo(repo);
  }
});

test("loop.continue defaults to true when omitted", () => {
  const repo = mkRepo();
  try {
    const slug = "defaulty";
    const tok = fullToken(slug);
    delete tok.loop.continue;
    RT.write(repo, slug, tok);
    const got = RT.read(repo, slug);
    assert.equal(got.loop.continue, true);
  } finally {
    rmRepo(repo);
  }
});

test("ATOMIC: no leftover .tmp-* file remains after a successful write", () => {
  const repo = mkRepo();
  try {
    const slug = "atomic1";
    RT.write(repo, slug, fullToken(slug));
    const plansDir = path.join(repo, ".plans");
    const leftover = fs.readdirSync(plansDir).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftover, []);
    // final file present and valid
    assert.ok(fs.existsSync(path.join(plansDir, slug + ".resume.json")));
  } finally {
    rmRepo(repo);
  }
});

test("ATOMIC: simulated crash mid-write leaves NO partial target file", () => {
  const repo = mkRepo();
  const origRename = fs.renameSync;
  try {
    const slug = "crashy";
    // Monkeypatch renameSync to throw, simulating a crash between write & rename.
    fs.renameSync = () => { throw new Error("simulated crash during rename"); };
    assert.throws(() => RT.write(repo, slug, fullToken(slug)), /simulated crash/);
    fs.renameSync = origRename;

    const plansDir = path.join(repo, ".plans");
    // The target file must NOT exist (no partial artifact).
    assert.equal(fs.existsSync(path.join(plansDir, slug + ".resume.json")), false);
    // And the temp file should have been cleaned up.
    const leftover = fs.existsSync(plansDir)
      ? fs.readdirSync(plansDir).filter((f) => f.includes(".tmp-"))
      : [];
    assert.deepEqual(leftover, []);
  } finally {
    fs.renameSync = origRename;
    rmRepo(repo);
  }
});

test("bad slug rejected on write", () => {
  const repo = mkRepo();
  try {
    assert.throws(() => RT.write(repo, "../escape", fullToken("../escape")), /bad slug/);
    assert.throws(() => RT.write(repo, "has space", fullToken("ok")), /bad slug/);
  } finally {
    rmRepo(repo);
  }
});

test("bad slug rejected on read", () => {
  const repo = mkRepo();
  try {
    assert.throws(() => RT.read(repo, "bad/slug"), /bad slug/);
  } finally {
    rmRepo(repo);
  }
});
