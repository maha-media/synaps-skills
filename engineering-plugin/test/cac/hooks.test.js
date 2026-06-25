/*
 * hooks.test.js — CAC §7 hook producer/handlers (lib/cac/hooks.js).
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const hooks = require("../../lib/cac/hooks.js");

test("checkpointReachedEvent: shape with all fields", () => {
  const ev = hooks.checkpointReachedEvent({
    slug: "alpha", phase: "O5", checkpoint: "C-O4", head_commit: "b344bf1",
  });
  assert.deepEqual(ev, {
    type: "checkpoint.reached", slug: "alpha", phase: "O5",
    checkpoint: "C-O4", head_commit: "b344bf1",
  });
});

test("checkpointReachedEvent: head_commit optional → null", () => {
  const ev = hooks.checkpointReachedEvent({ slug: "a", phase: "P1", checkpoint: "C0" });
  assert.equal(ev.head_commit, null);
  assert.equal(ev.type, "checkpoint.reached");
});

test("checkpointReachedEvent: throws on missing required fields", () => {
  assert.throws(() => hooks.checkpointReachedEvent({ phase: "P1", checkpoint: "C0" }), /slug/);
  assert.throws(() => hooks.checkpointReachedEvent({ slug: "a", checkpoint: "C0" }), /phase/);
  assert.throws(() => hooks.checkpointReachedEvent({ slug: "a", phase: "P1" }), /checkpoint/);
  assert.throws(() => hooks.checkpointReachedEvent(), /slug/);
});

test("emitCheckpointReached: calls injected broadcast with (slug, event)", () => {
  const calls = [];
  const broadcast = (slug, payload) => calls.push([slug, payload]);
  const ev = hooks.emitCheckpointReached(broadcast, {
    slug: "alpha", phase: "O5", checkpoint: "C-O4", head_commit: "abc",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "alpha");
  assert.deepEqual(calls[0][1], ev);
  assert.equal(ev.type, "checkpoint.reached");
});

test("emitCheckpointReached: throws if broadcast not a function", () => {
  assert.throws(() => hooks.emitCheckpointReached(null, { slug: "a", phase: "p", checkpoint: "c" }), /function/);
});

test("preCompactHook: delegates to pregate.preCompact", () => {
  // safe point: commit.landed, clean tree, gate green → allow:true
  const r = hooks.preCompactHook({
    event: "commit.landed", tree_clean: true, gate_green: true,
  });
  assert.equal(r.allow, true);
  // dirty tree → blocked
  const r2 = hooks.preCompactHook({ event: "commit.landed", tree_clean: false, gate_green: true });
  assert.equal(r2.allow, false);
});

test("postCompactHook: delegates to postgate.postCompact", () => {
  // minimal ctx with stubbed git runner returning matching HEAD.
  const token = {
    schema: "resume/1", slug: "alpha", branch: "b", worktree: "/w",
    active_phase: "O5", last_checkpoint: "C-O4", next_action: "do the thing",
    head_commit: "abc1234", outstanding: ["x"], pending_subagents: [],
    loop: { kind: "convergence", continue: false }, issued_at: "2026-06-25T14:46:00Z",
  };
  const ctx = {
    repoRoot: "/w",
    git: { run: () => ({ stdout: "abc1234\n", status: 0 }) },
    token,
    summary: { active_phase: "O5", next_action: "do the thing", outstanding: ["x"] },
    require_clean_tree: false,
  };
  const r = hooks.postCompactHook(ctx);
  assert.equal(typeof r.ok, "boolean");
});

test("HOOK_NAMES contains the three §7 hook names", () => {
  assert.ok(hooks.HOOK_NAMES.includes("checkpoint.reached"));
  assert.ok(hooks.HOOK_NAMES.includes("pre-compact"));
  assert.ok(hooks.HOOK_NAMES.includes("post-compact"));
  assert.equal(hooks.HOOK_NAMES.length, 3);
});
