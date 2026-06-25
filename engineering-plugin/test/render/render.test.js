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

test("renderPlan produces section nodes with data-section-id", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  PlanRenderer.renderPlan(app, clone(), { document: d });
  const intro = app.querySelector('[data-section-id="intro"]');
  const build = app.querySelector('[data-section-id="build-it"]');
  assert.ok(intro, "intro section rendered");
  assert.ok(build, "build-it section rendered");
  assert.equal(intro.getAttribute("data-section-id"), "intro");
});

test("task section shows state badge", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  PlanRenderer.renderPlan(app, clone(), { document: d });
  const badge = app.querySelector(".badge-state-doing");
  assert.ok(badge, "state badge present");
  assert.equal(badge.textContent, "doing");
});

test("risk and approval badges shown when set", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  PlanRenderer.renderPlan(app, clone(), { document: d });
  assert.ok(app.querySelector(".badge-risk"), "risk badge");
  assert.ok(app.querySelector(".badge-approval"), "approval badge");
});

test("no state badge for prose section", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  const p = clone();
  PlanRenderer.renderPlan(app, p, { document: d });
  const intro = app.querySelector('[data-section-id="intro"]');
  assert.ok(!intro.querySelector('[class*="badge-state-"]'), "prose has no state badge");
});

test("acceptance and verification render as <ul><li>", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  PlanRenderer.renderPlan(app, clone(), { document: d });
  const build = app.querySelector('[data-section-id="build-it"]');
  const acc = build.querySelector("ul.acceptance");
  const ver = build.querySelector("ul.verification");
  assert.ok(acc, "acceptance ul");
  assert.ok(ver, "verification ul");
  const accItems = acc.querySelectorAll("li");
  assert.equal(accItems.length, 2);
  assert.equal(accItems[0].textContent, "builds clean");
  assert.equal(accItems[1].textContent, "tests pass");
  const verItems = ver.querySelectorAll("li");
  assert.equal(verItems.length, 1);
  assert.equal(verItems[0].textContent, "run node --test");
});

test("bad plan data shows .plan-error and does not throw", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  const bad = clone();
  bad.schema = "engplan/999";
  let result;
  assert.doesNotThrow(() => { result = PlanRenderer.renderPlan(app, bad, { document: d }); });
  const err = app.querySelector(".plan-error");
  assert.ok(err, "plan-error node present");
  assert.equal(result, undefined, "renderPlan returns undefined on error");
  assert.ok(!app.querySelector('[data-section-id]'), "no sections rendered on error");
});

test("plan header shows title and status badge", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  PlanRenderer.renderPlan(app, clone(), { document: d });
  const header = app.querySelector(".plan-header");
  assert.ok(header, "header present");
  assert.ok(/Sample Plan/.test(header.textContent));
  assert.ok(app.querySelector(".badge-status"), "status badge");
});
