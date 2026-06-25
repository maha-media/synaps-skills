/*
 * watchdog.test.js — resume watchdog proofs for lib/cac/watchdog.js (§5.3).
 * Test scenario S-CAC-5: RESUMING stalls past resume_deadline_s → watchdog
 * re-issues from the token. reachedRunning() before the deadline cancels it.
 * Re-issue happens at most once. Fully deterministic via an injected fake
 * scheduler — NO real multi-second sleeps.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createWatchdog } = require("../../lib/cac/watchdog.js");

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
      head_commit: "b344bf1",
      outstanding: ["selfplay state=not-done"],
      pending_subagents: [],
      loop: { kind: "convergence", continue: true },
      issued_at: "2026-06-25T14:46:00Z",
    },
    overrides || {}
  );
}

// A fake scheduler that captures the scheduled callback + delay so the test can
// fire the deadline deterministically (no real timers).
function fakeScheduler() {
  const timers = new Map();
  let nextId = 1;
  return {
    captured: timers,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms, cleared: false });
      return id;
    },
    clearTimeout(id) {
      const t = timers.get(id);
      if (t) t.cleared = true;
      timers.delete(id);
    },
    // Fire the most-recently-scheduled live timer (emulates deadline elapse).
    fireLast() {
      const ids = [...timers.keys()];
      const id = ids[ids.length - 1];
      const t = timers.get(id);
      timers.delete(id);
      t.fn();
      return id;
    },
    liveCount() {
      return timers.size;
    },
  };
}

function harness(ctxOverrides) {
  const sched = fakeScheduler();
  const calls = { reissue: [] };
  const ctx = Object.assign(
    {
      token: baseToken(),
      setTimeout: sched.setTimeout,
      clearTimeout: sched.clearTimeout,
      reissue: (t) => calls.reissue.push(t),
    },
    ctxOverrides || {}
  );
  const wd = createWatchdog(ctx);
  return { wd, sched, calls };
}

test("S-CAC-5: RESUMING stalls past deadline → watchdog re-issues from the token", () => {
  const { wd, sched, calls } = harness();
  wd.arm();
  assert.equal(wd.state, "armed");
  assert.equal(sched.liveCount(), 1, "one deadline timer scheduled");
  // Default deadline is 120s.
  const t = [...sched.captured.values()][0];
  assert.equal(t.ms, 120 * 1000);

  // Fire the deadline deterministically (no real wait).
  sched.fireLast();

  assert.equal(wd.state, "reissued");
  assert.equal(calls.reissue.length, 1, "re-issued exactly once on stall");
  assert.equal(calls.reissue[0].action, "fix oracle survivors; re-run self-play");
  assert.equal(calls.reissue[0].active_phase, "O5");
});

test("reachedRunning() before the deadline → watchdog does NOT re-issue (timer cancelled)", () => {
  const { wd, sched, calls } = harness();
  wd.arm();
  assert.equal(sched.liveCount(), 1);

  const ok = wd.reachedRunning();
  assert.equal(ok, true);
  assert.equal(wd.state, "cancelled");
  assert.equal(sched.liveCount(), 0, "timer cleared");

  // Even if a stray timer callback somehow fires, no re-issue happens.
  assert.equal(wd.expire(), null);
  assert.equal(calls.reissue.length, 0, "no re-issue when RUNNING reached in time");
});

test("re-issue happens at most once (double expire is a no-op)", () => {
  const { wd, calls } = harness();
  wd.arm();
  const first = wd.expire();
  const second = wd.expire();
  assert.notEqual(first, null);
  assert.equal(second, null);
  assert.equal(calls.reissue.length, 1, "exactly one re-issue despite repeated expiry");
});

test("reachedRunning after re-issue is too late (state stays reissued)", () => {
  const { wd, calls } = harness();
  wd.arm();
  wd.expire();
  const ok = wd.reachedRunning();
  assert.equal(ok, false);
  assert.equal(wd.state, "reissued");
  assert.equal(calls.reissue.length, 1);
});

test("re-arming cancels the prior timer (fresh window, no double re-issue)", () => {
  const { wd, sched, calls } = harness();
  wd.arm();
  const firstId = [...sched.captured.keys()][0];
  wd.arm(); // re-arm
  assert.equal(sched.liveCount(), 1, "only the new timer is live");
  assert.equal(sched.captured.has(firstId), false, "prior timer cancelled");
  sched.fireLast();
  assert.equal(calls.reissue.length, 1);
});

test("disarm() cancels without re-issuing", () => {
  const { wd, sched, calls } = harness();
  wd.arm();
  wd.disarm();
  assert.equal(wd.state, "cancelled");
  assert.equal(sched.liveCount(), 0);
  assert.equal(wd.expire(), null);
  assert.equal(calls.reissue.length, 0);
});

test("dispatch alias is accepted in place of reissue", () => {
  const sched = fakeScheduler();
  const dispatched = [];
  const wd = createWatchdog({
    token: baseToken(),
    setTimeout: sched.setTimeout,
    clearTimeout: sched.clearTimeout,
    dispatch: (t) => dispatched.push(t),
  });
  wd.arm();
  sched.fireLast();
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].kind, "next-task");
});

test("custom resume_deadline_s overrides the config default", () => {
  const { wd } = harness({ resume_deadline_s: 30 });
  assert.equal(wd.deadline_s, 30);
  assert.equal(wd.deadline_ms, 30000);
});

test("deadline comes from config when not overridden (default 120s)", () => {
  const { wd } = harness();
  assert.equal(wd.deadline_s, 120);
});

test("missing token throws", () => {
  assert.throws(() => createWatchdog({}), /token/);
});
