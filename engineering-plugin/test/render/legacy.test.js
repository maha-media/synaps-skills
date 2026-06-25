"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const PlanRenderer = require("../../assets/plan.js");
const { makeDocument } = require("../harness/dom.js");

const MD = fs.readFileSync(path.join(__dirname, "../fixtures/legacy.md"), "utf8");

test("parseLegacyMarkdown yields heading-derived sections", () => {
  const plan = PlanRenderer.parseLegacyMarkdown(MD, "legacy-doc");
  assert.equal(plan.schema, "engplan/1");
  assert.equal(plan.slug, "legacy-doc");
  const headings = plan.sections.map((s) => s.heading);
  assert.deepEqual(headings, ["Setup", "Setup", "Build", "Setup"]);
});

test("ids are slugified headings with ordinal disambiguation on collision", () => {
  const plan = PlanRenderer.parseLegacyMarkdown(MD, "legacy-doc");
  const ids = plan.sections.map((s) => s.id);
  assert.deepEqual(ids, ["setup", "setup-2", "build", "setup-3"]);
  // all ids unique
  assert.equal(new Set(ids).size, ids.length);
});

test("legacy sections carry markdown body and prose type", () => {
  const plan = PlanRenderer.parseLegacyMarkdown(MD, "legacy-doc");
  for (const s of plan.sections) assert.equal(s.type, "prose");
  assert.ok(/setup paragraph/i.test(plan.sections[0].md));
});

test("rendering legacy plan with opts.legacy shows a legacy/degraded badge", () => {
  const plan = PlanRenderer.parseLegacyMarkdown(MD, "legacy-doc");
  const d = makeDocument();
  const app = d.createElement("div");
  PlanRenderer.renderPlan(app, plan, { document: d, legacy: true });
  const badges = app.querySelectorAll(".badge-legacy");
  assert.ok(badges.length >= 1, "at least one legacy badge");
  assert.ok(/legacy/i.test(badges[0].textContent), badges[0].textContent);
});

test("without opts.legacy there is no legacy badge", () => {
  const plan = PlanRenderer.parseLegacyMarkdown(MD, "legacy-doc");
  const d = makeDocument();
  const app = d.createElement("div");
  PlanRenderer.renderPlan(app, plan, { document: d });
  assert.equal(app.querySelectorAll(".badge-legacy").length, 0);
});
