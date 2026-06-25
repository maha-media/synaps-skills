/*
 * e2e.test.js — CAC-5 dogfood: the full §5 suspend→compact→resume cycle and all
 * S-CAC-1..7 scenarios (spec §11 / §12 worked example), driven end-to-end through
 * the REAL lib/cac modules. The shared scenario functions live in scenarios.js
 * (DRY: also run headless by test/cac/e2e.js). The FULL CYCLE test additionally
 * observes the §7 `checkpoint.reached` producer over the live SSE bus via the
 * withServer harness, then runs pregate→summary→postgate(dispatch).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { withServer, sleep } = require("../harness/runner.js");
const hooks = require("../../lib/cac/hooks.js");
const pregate = require("../../lib/cac/pregate.js");
const postgate = require("../../lib/cac/postgate.js");
const summary = require("../../lib/cac/summary.js");
const scenarios = require("./scenarios.js");

// One node:test per S-CAC scenario, delegating to the shared functions.
for (const s of scenarios.SCENARIOS) {
  test(s.id + ": " + s.desc, () => {
    s.fn();
  });
}

function plan(slug) {
  return {
    schema: "engplan/1", kind: "plan", slug, title: "HTML Plan Ecosystem", status: "in_progress",
    convergence: "oracle", sections: [{ id: "s1", heading: "S1", type: "prose", md: "x" }],
  };
}

// FULL CYCLE: pressure → state → checkpoint.reached(SSE) → pregate(allow) →
// summary → postgate(dispatch next task) → continuity. Mirrors §12.
test("FULL CYCLE: checkpoint.reached(SSE) → pre-compact → summary → post-compact auto re-issue", async () => {
  await withServer(async (ctx) => {
    const slug = "html-plan-ecosystem";
    ctx.writePlan(plan(slug));
    const stream = ctx.sse(slug);
    try {
      await sleep(120); // let the SSE connection register server-side

      // Producer leg: emit the §4 safe-point event onto the live Plan Inbox bus.
      ctx.srv.broadcastPlan(
        slug,
        hooks.checkpointReachedEvent({
          slug, phase: "O5", checkpoint: "C-O5", head_commit: scenarios.HEAD,
        })
      );
      const ev = await stream.waitFor((e) => e && e.type === "checkpoint.reached", 3000);
      assert.equal(ev.slug, slug, "FULL: checkpoint.reached observed on SSE bus");
      assert.equal(ev.phase, "O5");
      assert.equal(ev.checkpoint, "C-O5");
      assert.equal(ev.head_commit, scenarios.HEAD);

      // Gate leg: at this safe point, clean tree + gate green → pre-compact allows.
      const gate = pregate.preCompact({
        event: { type: ev.type }, tree_clean: true, gate_green: true,
      });
      assert.equal(gate.allow, true, "FULL: pre-compact allows at the safe point");

      // Summary leg: artifact-anchored regeneration from plan + log + verdict + token.
      const token = scenarios.baseToken({ head_commit: ev.head_commit });
      const built = summary.buildSummary(scenarios.summaryInputFor(token));
      assert.equal(built.object.active_phase, "O5");
      assert.match(built.object.next_action, /fix oracle survivors/);

      // Resume leg: post-compact verifies continuity and auto-issues the next task.
      const dispatched = [];
      const res = postgate.postCompact({
        repoRoot: "/repo",
        git: scenarios.gitRunner(ev.head_commit, true),
        token: token,
        summary: built.object,
        dispatch: (t) => dispatched.push(t),
      });
      assert.equal(res.ok, true, "FULL: continuity verified post-compact");
      assert.equal(res.dispatched, true, "FULL: next task auto-issued, no human input");
      assert.equal(dispatched.length, 1);
      assert.match(dispatched[0].action, /fix oracle survivors/, "FULL: re-issued the resume action (§12)");
    } finally {
      stream.close();
    }
  });
});
