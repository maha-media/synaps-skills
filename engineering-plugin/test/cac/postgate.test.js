/*
 * postgate.test.js — post-compact continuity proofs for lib/cac/postgate.js
 * (§5.2 / §7). Test scenarios S-CAC-3 (auto re-issue, no human) and S-CAC-4
 * (HEAD changed → continuity-violation, loop does not proceed blindly), plus
 * the fail-closed checks (dirty tree, summary gaps). All hermetic via injected
 * git runner + summary object.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { postCompact } = require("../../lib/cac/postgate.js");

const HEAD = "b344bf1c0ffee1234567890abcdef0123456789a";

function baseToken(overrides) {
  return Object.assign(
    {
      schema: "resume/1",
      slug: "html-plan-ecosystem",
      branch: "feat/html-plan-ecosystem",
      worktree: "/abs/path/.worktrees/html-plan-ecosystem",
      active_phase: "O5",
      last_checkpoint: "C-O4",
      next_action: "fix oracle survivors; re-run self-play",
      head_commit: HEAD,
      outstanding: ["selfplay state=not-done, outstanding_finds=3"],
      pending_subagents: [],
      loop: { kind: "convergence", continue: true },
      issued_at: "2026-06-25T14:46:00Z",
    },
    overrides || {}
  );
}

// Summary object matching the token (as summary.buildSummary(...).object would
// produce). Continuity-complete unless overridden.
function summaryFor(token, overrides) {
  return Object.assign(
    {
      slug: token.slug,
      active_phase: token.active_phase,
      next_action: token.next_action,
      outstanding: token.outstanding.slice(),
      last_checkpoint: token.last_checkpoint,
      landed_commits: [],
      loop: { kind: token.loop.kind, continue: token.loop.continue },
    },
    overrides || {}
  );
}

// Injectable git runner returning a fixed HEAD + clean status.
function gitRunner(head, clean) {
  return {
    run(args, _cwd) {
      if (args[0] === "rev-parse") return { stdout: head + "\n", status: 0, stderr: "" };
      if (args[0] === "status") return { stdout: clean ? "" : " M file.js\n", status: 0, stderr: "" };
      return { stdout: "", status: 0, stderr: "" };
    },
  };
}

function harness(ctxOverrides) {
  const calls = { emit: [], dispatch: [] };
  const token = (ctxOverrides && ctxOverrides.token) || baseToken();
  const ctx = Object.assign(
    {
      repoRoot: "/repo",
      git: gitRunner(HEAD, true),
      token: token,
      summary: summaryFor(token),
      emit: (n) => calls.emit.push(n),
      dispatch: (t) => calls.dispatch.push(t),
    },
    ctxOverrides || {}
  );
  return { ctx, calls };
}

test("S-CAC-3: loop.continue:true + all checks pass → dispatch the next task (auto-issued, no human)", () => {
  const { ctx, calls } = harness();
  const res = postCompact(ctx);

  assert.equal(res.ok, true);
  assert.equal(res.dispatched, true);
  assert.equal(res.halted, false);
  assert.equal(res.violation, null);
  assert.equal(calls.emit.length, 0, "no continuity-violation when checks pass");
  assert.equal(calls.dispatch.length, 1, "next task auto-issued exactly once");
  assert.equal(calls.dispatch[0].action, ctx.token.next_action);
  assert.equal(calls.dispatch[0].active_phase, "O5");
});

test("S-CAC-3: loop.continue:false → dispatch NOT called, result halts/waits", () => {
  const token = baseToken({ loop: { kind: "convergence", continue: false } });
  const { ctx, calls } = harness({ token, summary: summaryFor(token) });
  const res = postCompact(ctx);

  assert.equal(res.ok, true);
  assert.equal(res.dispatched, false);
  assert.equal(res.halted, true);
  assert.equal(calls.dispatch.length, 0, "no auto-issue when loop.continue:false");
  assert.equal(calls.emit.length, 0, "halting is not a violation");
});

test("S-CAC-4: HEAD changed since token write → continuity-violation; dispatch NOT called; not-ok", () => {
  const { ctx, calls } = harness({ git: gitRunner("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", true) });
  const res = postCompact(ctx);

  assert.equal(res.ok, false, "loop does not proceed blindly");
  assert.equal(res.dispatched, false);
  assert.equal(calls.dispatch.length, 0, "no dispatch on continuity violation");
  assert.equal(calls.emit.length, 1, "exactly one continuity-violation emitted");
  assert.equal(calls.emit[0].kind, "continuity-violation");
  assert.match(calls.emit[0].reason, /HEAD/);
  assert.equal(res.violation.kind, "continuity-violation");
});

test("dirty tree at resume (no dirty intent) → continuity-violation, fail closed, no dispatch", () => {
  const { ctx, calls } = harness({ git: gitRunner(HEAD, false) });
  const res = postCompact(ctx);

  assert.equal(res.ok, false);
  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.emit.length, 1);
  assert.match(calls.emit[0].reason, /dirty/i);
});

test("summary missing next_action → continuity-violation (fail closed)", () => {
  const token = baseToken();
  const summary = summaryFor(token);
  delete summary.next_action;
  const { ctx, calls } = harness({ token, summary });
  const res = postCompact(ctx);

  assert.equal(res.ok, false);
  assert.equal(calls.dispatch.length, 0);
  assert.equal(calls.emit.length, 1);
  assert.match(calls.emit[0].reason, /next_action/);
});

test("summary missing active_phase → continuity-violation (fail closed)", () => {
  const token = baseToken();
  const summary = summaryFor(token);
  delete summary.active_phase;
  const { ctx, calls } = harness({ token, summary });
  const res = postCompact(ctx);

  assert.equal(res.ok, false);
  assert.equal(calls.emit.length, 1);
  assert.match(calls.emit[0].reason, /active_phase/);
  assert.equal(calls.dispatch.length, 0);
});

test("summary missing an outstanding item → continuity-violation (fail closed)", () => {
  const token = baseToken({ outstanding: ["alpha task", "beta task"] });
  const summary = summaryFor(token, { outstanding: ["alpha task"] }); // beta dropped
  const { ctx, calls } = harness({ token, summary });
  const res = postCompact(ctx);

  assert.equal(res.ok, false);
  assert.equal(calls.emit.length, 1);
  assert.match(calls.emit[0].reason, /outstanding/i);
  assert.equal(calls.dispatch.length, 0);
});

test("summary active_phase mismatching token → continuity-violation", () => {
  const token = baseToken();
  const summary = summaryFor(token, { active_phase: "O3" });
  const { ctx, calls } = harness({ token, summary });
  const res = postCompact(ctx);

  assert.equal(res.ok, false);
  assert.equal(calls.emit.length, 1);
  assert.match(calls.emit[0].reason, /active_phase/);
});

test("accepts the {object, markdown} summary wrapper from summary.buildSummary", () => {
  const token = baseToken();
  const wrapper = { object: summaryFor(token), markdown: "# ..." };
  const { ctx, calls } = harness({ token, summary: wrapper });
  const res = postCompact(ctx);

  assert.equal(res.ok, true);
  assert.equal(res.dispatched, true);
  assert.equal(calls.dispatch.length, 1);
});

test("tree-clean flag form works without a repoRoot git probe", () => {
  const token = baseToken();
  const calls = { emit: [], dispatch: [] };
  const res = postCompact({
    head_commit: HEAD,
    tree_clean: true,
    token,
    summary: summaryFor(token),
    emit: (n) => calls.emit.push(n),
    dispatch: (t) => calls.dispatch.push(t),
  });
  assert.equal(res.ok, true);
  assert.equal(calls.dispatch.length, 1);
});

test("missing token throws (programmer error, not a continuity violation)", () => {
  assert.throws(() => postCompact({ repoRoot: "/repo", summary: {} }), /token/);
});
