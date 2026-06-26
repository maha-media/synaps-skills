/*
 * site_live.test.js — PS-4: a live section patch updates the section card AND
 * recomputes the progress bar in place (no full reload), reusing the existing
 * applySectionPatch contract.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PlanSite = require("../../assets/site.js");
const PlanRenderer = require("../../assets/plan.js");
const { makeDocument } = require("../harness/dom.js");

function plan() {
  return {
    schema: "engplan/1", kind: "plan", slug: "live", title: "Live Plan",
    status: "in_progress", convergence: "none",
    sections: [
      { id: "t1", heading: "Task one", type: "task", state: "done", md: "a" },
      { id: "t2", heading: "Task two", type: "task", state: "doing", md: "b" },
      { id: "t3", heading: "Task three", type: "task", state: "todo", md: "c" },
    ],
  };
}

test("live section patch updates the card + progress bar in place", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  PlanSite.renderDetail(d, app, plan(), {});
  assert.match(app.querySelector(".plan-progress .label").textContent, /1 \/ 3/, "starts at 1/3");

  // a patch arrives moving t2 done
  const ok = PlanRenderer.applySectionPatch(
    app._plan,
    { id: "t2", heading: "Task two", type: "task", state: "done", md: "b" },
    app, { document: d });
  assert.ok(ok, "patch applied");

  const prog = PlanSite.refreshProgress(d, app);
  assert.equal(prog.done, 2, "now 2 tasks done");
  assert.match(app.querySelector(".plan-progress .label").textContent, /2 \/ 3/, "progress label updated in place");
  assert.ok(app.querySelector('[data-section-id="t2"] .badge-state-done'), "t2 card now shows done pill");
});

test("refreshProgress is a no-op without a rendered plan", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  assert.equal(PlanSite.refreshProgress(d, app), null);
});
