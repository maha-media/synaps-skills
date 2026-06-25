/*
 * scenarios.js — CAC-5 shared S-CAC-1..7 end-to-end scenario functions.
 * Drives the REAL lib/cac modules through the §5 suspend→compact→resume cycle
 * (spec §11 / §12 worked example). Each scenario is a self-contained, hermetic,
 * deterministic async function that THROWS on any assertion failure. Both the
 * node --test suite (e2e.test.js) and the runnable headless driver (e2e.js)
 * import these so the dogfood is DRY: one definition, two runners.
 *
 * No real timers, no real git, no real fs for the pure legs — git is an
 * injected runner; the watchdog uses an injected scheduler + expire() hook.
 */
"use strict";

const assert = require("node:assert/strict");

const pregate = require("../../lib/cac/pregate.js");
const postgate = require("../../lib/cac/postgate.js");
const summary = require("../../lib/cac/summary.js");
const { createWatchdog } = require("../../lib/cac/watchdog.js");
const { createPressure } = require("../../lib/cac/pressure.js");
const state = require("../../lib/cac/state.js");

const HEAD = "b344bf1c0ffee1234567890abcdef0123456789a";
const OTHER_HEAD = "00000000deadbeef0000000000000000deadbeef";

// ── Fixtures ─────────────────────────────────────────────────────────────────
function baseToken(overrides) {
  return Object.assign(
    {
      schema: "resume/1",
      slug: "html-plan-ecosystem",
      branch: "feat/html-plan-ecosystem",
      worktree: "/abs/path/.worktrees/html-plan-ecosystem",
      active_phase: "O5",
      last_checkpoint: "C-O4",
      next_action: "fix oracle survivors: bad-request, too-many-streams, write-confinement-violation; re-run self-play",
      head_commit: HEAD,
      outstanding: ["selfplay state=not-done, outstanding_finds=3, reveal_verified=false"],
      pending_subagents: [],
      loop: { kind: "convergence", continue: true },
      issued_at: "2026-06-25T14:46:00Z",
    },
    overrides || {}
  );
}

// engplan/1 raw object with checkpoints[] (the parser drops checkpoints, so the
// summary reads them off the raw object — matches summary.js).
function planJson(slug) {
  return {
    schema: "engplan/1",
    kind: "plan",
    slug: slug,
    title: "HTML Plan Ecosystem",
    status: "in_progress",
    convergence: "oracle",
    sections: [{ id: "s1", heading: "Oracle", type: "prose", md: "oracle work" }],
    checkpoints: [
      { id: "C-O4", phase: "O4", pass: true },
      { id: "C-O5", phase: "O5", pass: false },
    ],
  };
}

function verdictFor() {
  return {
    schema: "verdict/1",
    slug: "html-plan-ecosystem",
    grade: "amber",
    verdict: "not-done",
    outstanding: ["fix 3 oracle survivors", "verify reveal"],
  };
}

// Injectable git runner returning a fixed HEAD + clean/dirty status.
function gitRunner(head, clean) {
  return {
    run(args, _cwd) {
      if (args[0] === "rev-parse") return { stdout: head + "\n", status: 0, stderr: "" };
      if (args[0] === "status") return { stdout: clean ? "" : " M lib/foo.js\n", status: 0, stderr: "" };
      if (args[0] === "log") return { stdout: "b344bf1 land O4\n9988776 wire pregate\n", status: 0, stderr: "" };
      return { stdout: "", status: 0, stderr: "" };
    },
  };
}

function summaryInputFor(token) {
  return {
    slug: token.slug,
    planJson: planJson(token.slug),
    resumeToken: token,
    logLines: ["b344bf1 land O4", "9988776 wire pregate"],
    verdict: verdictFor(),
  };
}

// ── Scenarios ────────────────────────────────────────────────────────────────

// S-CAC-1: pressure true mid-write → pre-compact denies; allows once commit lands.
function sCac1() {
  // Mid-write: dirty tree at a subagent.finished boundary → DENIED.
  const denied = pregate.preCompact({
    event: "subagent.finished",
    tree_clean: false, // uncommitted work mid-write
    gate_green: true,
  });
  assert.equal(denied.allow, false, "S-CAC-1: dirty tree must deny compaction");
  assert.match(denied.reason, /dirty tree/, "S-CAC-1: reason cites dirty tree");

  // Tool in flight is also denied even with a clean tree.
  const toolDenied = pregate.preCompact({
    event: "subagent.finished",
    tree_clean: true,
    tool_in_flight: true,
    gate_green: true,
  });
  assert.equal(toolDenied.allow, false, "S-CAC-1: tool-in-flight must deny");

  // After the commit lands: clean tree, safe point, gate green → ALLOWED.
  const allowed = pregate.preCompact({
    event: "commit.landed",
    tree_clean: true,
    gate_green: true,
  });
  assert.equal(allowed.allow, true, "S-CAC-1: clean+safe+green allows after commit lands");
}

// S-CAC-2: pressure true at subagent.finished + clean + gate green → proceeds,
// and the state machine advances toward COMPACTING.
function sCac2() {
  const gate = pregate.preCompact({
    event: "subagent.finished",
    tree_clean: true,
    gate_green: true,
  });
  assert.equal(gate.allow, true, "S-CAC-2: subagent.finished + clean + green allows");

  // Walk the §5 cycle to COMPACTING using the real state machine.
  let s = state.STATES.RUNNING;
  s = state.transition(s, state.EVENTS.CONTEXT_PRESSURE).state;
  assert.equal(s, state.STATES.ARMED);
  s = state.transition(s, state.EVENTS.SAFE_POINT_REACHED).state;
  assert.equal(s, state.STATES.CHECKPOINT_REACHED);
  s = state.transition(s, state.EVENTS.CHECKPOINT_COMMITTED, {
    token_persisted: true, tree_clean: true, gate_green: true,
  }).state;
  assert.equal(s, state.STATES.SUSPENDED);
  s = state.transition(s, state.EVENTS.PRE_COMPACT_OK).state;
  assert.equal(s, state.STATES.COMPACTING, "S-CAC-2: advanced to COMPACTING");
}

// S-CAC-3: after compaction, loop.continue:true → next task auto-issued (no human);
// loop.continue:false → NOT dispatched (halt, await human).
function sCac3() {
  const token = baseToken();
  const dispatched = [];
  const cont = postgate.postCompact({
    repoRoot: "/repo",
    git: gitRunner(HEAD, true),
    token: token,
    summaryInput: summaryInputFor(token),
    dispatch: (t) => dispatched.push(t),
  });
  assert.equal(cont.ok, true, "S-CAC-3: continuity verified");
  assert.equal(cont.dispatched, true, "S-CAC-3: loop.continue:true auto-issues next task");
  assert.equal(dispatched.length, 1, "S-CAC-3: exactly one task dispatched (no human)");
  assert.equal(dispatched[0].active_phase, "O5");
  assert.match(dispatched[0].action, /fix oracle survivors/);

  // loop.continue:false → halt, no dispatch.
  const haltToken = baseToken({ loop: { kind: "convergence", continue: false } });
  const halted = [];
  const stop = postgate.postCompact({
    repoRoot: "/repo",
    git: gitRunner(HEAD, true),
    token: haltToken,
    summaryInput: summaryInputFor(haltToken),
    dispatch: (t) => halted.push(t),
  });
  assert.equal(stop.ok, true);
  assert.equal(stop.dispatched, false, "S-CAC-3: loop.continue:false must NOT dispatch");
  assert.equal(stop.halted, true);
  assert.equal(halted.length, 0, "S-CAC-3: no task issued when halting");
}

// S-CAC-4: HEAD changed between token write and resume → continuity-violation,
// loop does not proceed blindly (no dispatch).
function sCac4() {
  const token = baseToken();
  const violations = [];
  const dispatched = [];
  const res = postgate.postCompact({
    repoRoot: "/repo",
    git: gitRunner(OTHER_HEAD, true), // HEAD != token.head_commit
    token: token,
    summaryInput: summaryInputFor(token),
    emit: (n) => violations.push(n),
    dispatch: (t) => dispatched.push(t),
  });
  assert.equal(res.ok, false, "S-CAC-4: continuity must fail when HEAD moved");
  assert.equal(res.dispatched, false, "S-CAC-4: loop must NOT proceed blindly");
  assert.equal(dispatched.length, 0);
  assert.equal(violations.length, 1, "S-CAC-4: a continuity-violation is raised to inbox");
  assert.equal(violations[0].kind, "continuity-violation");
  assert.match(res.reason, /HEAD/);
}

// S-CAC-5: RESUMING stalls past resume_deadline_s → watchdog re-issues from
// token; reachedRunning() before expiry → NO re-issue. Fake clock (no real wait).
function sCac5() {
  const token = baseToken();

  // Injected scheduler: capture the callback; never fire on a real timer.
  function fakeScheduler() {
    return {
      setTimeout: () => 1, // returns a handle, never auto-fires
      clearTimeout: () => {},
    };
  }

  // (a) stall past deadline → expire() re-issues exactly once.
  const reissuedA = [];
  const sched = fakeScheduler();
  const wdA = createWatchdog({
    token: token,
    setTimeout: sched.setTimeout,
    clearTimeout: sched.clearTimeout,
    reissue: (t) => reissuedA.push(t),
  });
  wdA.arm();
  assert.equal(wdA.state, "armed");
  const task = wdA.expire(); // deterministic deadline fire
  assert.ok(task, "S-CAC-5: expire re-issues a task");
  assert.equal(wdA.state, "reissued");
  assert.equal(reissuedA.length, 1, "S-CAC-5: watchdog re-issues from token on stall");
  assert.match(reissuedA[0].action, /fix oracle survivors/);
  // idempotent: a second expire does NOT double-issue.
  wdA.expire();
  assert.equal(reissuedA.length, 1, "S-CAC-5: re-issue is at-most-once");

  // (b) reached RUNNING before expiry → cancel, NO re-issue even if expire races.
  const reissuedB = [];
  const sched2 = fakeScheduler();
  const wdB = createWatchdog({
    token: token,
    setTimeout: sched2.setTimeout,
    clearTimeout: sched2.clearTimeout,
    reissue: (t) => reissuedB.push(t),
  });
  wdB.arm();
  assert.equal(wdB.reachedRunning(), true);
  assert.equal(wdB.state, "cancelled");
  assert.equal(wdB.expire(), null, "S-CAC-5: cancelled watchdog never fires");
  assert.equal(reissuedB.length, 0, "S-CAC-5: reachedRunning in time → no re-issue");
}

// S-CAC-6: summary regenerated from plan + git log + verdict + token references
// active_phase / next_action / outstanding; missing next_action → fail closed.
function sCac6() {
  const token = baseToken();
  const built = summary.buildSummary(summaryInputFor(token));
  const o = built.object;
  assert.equal(o.active_phase, "O5", "S-CAC-6: summary active_phase from token matches active phase");
  assert.match(o.next_action, /fix oracle survivors/, "S-CAC-6: next_action present");
  assert.ok(o.outstanding.length >= 1, "S-CAC-6: outstanding items surfaced");
  assert.ok(
    o.outstanding.some((x) => /selfplay/.test(x)),
    "S-CAC-6: token outstanding referenced"
  );
  // Regenerated from artifacts: landed commits + plan title + checkpoints present.
  assert.equal(o.title, "HTML Plan Ecosystem");
  assert.ok(Array.isArray(o.landed_commits) && o.landed_commits.length === 2, "S-CAC-6: git log landed");
  assert.ok(Array.isArray(o.checkpoints) && o.checkpoints.length === 2, "S-CAC-6: plan checkpoints[] read");
  assert.match(built.markdown, /Active phase:\*\* O5/, "S-CAC-6: markdown surfaces active phase");

  // Missing next_action → FAIL CLOSED (buildSummary throws).
  const badToken = baseToken();
  delete badToken.next_action; // RT.validate inside buildSummary fails closed
  assert.throws(
    () => summary.buildSummary({ slug: badToken.slug, planJson: planJson(badToken.slug), resumeToken: badToken }),
    /next_action/,
    "S-CAC-6: missing next_action must fail closed"
  );
}

// S-CAC-7: pressure oscillates around the watermark → hysteresis prevents repeated
// compaction (exactly one arm during the oscillation window).
function sCac7() {
  const p = createPressure();
  let arms = 0;
  const wave = [0.50, 0.88, 0.84, 0.62, 0.83, 0.61, 0.84, 0.70, 0.84, 0.62];
  for (const u of wave) {
    const r = p.update(u);
    if (r.changed && r.armed) arms++;
    if (p.armed) assert.ok(u > p.low || r.changed, "armed only while above low or on the flip");
  }
  assert.equal(arms, 1, "S-CAC-7: armed exactly once despite oscillation (no thrash)");
  assert.equal(p.armed, true);

  // Drop below low then re-rise → a NEW arm is permitted (band reset).
  assert.equal(p.update(0.55).changed, true, "S-CAC-7: <= low disarms");
  assert.equal(p.armed, false);
  assert.equal(p.update(0.90).changed, true, "S-CAC-7: re-arm after full hysteresis cycle");
}

// Ordered registry consumed by both runners.
const SCENARIOS = [
  { id: "S-CAC-1", desc: "deny mid-write; allow on commit", fn: sCac1 },
  { id: "S-CAC-2", desc: "safe point + green → proceeds", fn: sCac2 },
  { id: "S-CAC-3", desc: "loop.continue → auto re-issue", fn: sCac3 },
  { id: "S-CAC-4", desc: "HEAD moved → continuity-violation", fn: sCac4 },
  { id: "S-CAC-5", desc: "stall → watchdog re-issues", fn: sCac5 },
  { id: "S-CAC-6", desc: "artifact summary; fail closed", fn: sCac6 },
  { id: "S-CAC-7", desc: "hysteresis prevents thrash", fn: sCac7 },
];

module.exports = {
  SCENARIOS,
  // fixtures + scenario fns exported for the SSE full-cycle integration test.
  baseToken, planJson, verdictFor, gitRunner, summaryInputFor, HEAD, OTHER_HEAD,
  sCac1, sCac2, sCac3, sCac4, sCac5, sCac6, sCac7,
};
