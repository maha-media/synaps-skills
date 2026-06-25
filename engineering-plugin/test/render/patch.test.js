"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const PlanRenderer = require("../../assets/plan.js");
const { makeDocument } = require("../harness/dom.js");

const VALID = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../fixtures/valid-plan.json"), "utf8")
);
function clone() { return JSON.parse(JSON.stringify(VALID)); }

function setup() {
  const d = makeDocument();
  const app = d.createElement("div");
  const plan = PlanRenderer.renderPlan(app, clone(), { document: d });
  return { d, app, plan };
}

test("applySectionPatch appends a new section id", () => {
  const { d, app, plan } = setup();
  const patch = { id: "new-sec", heading: "Newly Added", type: "prose", md: "fresh" };
  const ok = PlanRenderer.applySectionPatch(plan, patch, app, { document: d });
  assert.equal(ok, true);
  const node = app.querySelector('[data-section-id="new-sec"]');
  assert.ok(node, "new section node appears");
  assert.equal(plan.sections.length, 3);
});

test("applySectionPatch replaces existing id in place", () => {
  const { d, app, plan } = setup();
  const before = app.querySelector('[data-section-id="build-it"]');
  const patch = { id: "build-it", heading: "Build it (revised)", type: "task", state: "done", md: "redone" };
  const ok = PlanRenderer.applySectionPatch(plan, patch, app, { document: d });
  assert.equal(ok, true);
  const after = app.querySelector('[data-section-id="build-it"]');
  assert.ok(after, "section still present");
  assert.notEqual(after, before, "node was replaced (new node object)");
  assert.ok(/revised/.test(after.textContent), "heading updated: " + after.textContent);
  // still only 2 sections (replace, not append)
  assert.equal(plan.sections.length, 2);
  assert.equal(plan.sections[1].state, "done");
});

test("unrelated section nodes keep identity across a patch", () => {
  const { d, app, plan } = setup();
  const introBefore = app.querySelector('[data-section-id="intro"]');
  PlanRenderer.applySectionPatch(plan, { id: "build-it", heading: "X", type: "task" }, app, { document: d });
  const introAfter = app.querySelector('[data-section-id="intro"]');
  assert.equal(introAfter, introBefore, "intro node identity preserved (same object)");
});

test("invalid patch with no id returns false safely", () => {
  const { d, app, plan } = setup();
  let r;
  assert.doesNotThrow(() => { r = PlanRenderer.applySectionPatch(plan, { heading: "no id" }, app, { document: d }); });
  assert.equal(r, false);
  assert.equal(plan.sections.length, 2, "no section added");
});

test("invalid patch (bad type) returns false safely", () => {
  const { d, app, plan } = setup();
  let r;
  assert.doesNotThrow(() => { r = PlanRenderer.applySectionPatch(plan, { id: "z", heading: "h", type: "bogus" }, app, { document: d }); });
  assert.equal(r, false);
  assert.equal(plan.sections.length, 2);
});

test("null patch returns false", () => {
  const { d, app, plan } = setup();
  assert.equal(PlanRenderer.applySectionPatch(plan, null, app, { document: d }), false);
});
