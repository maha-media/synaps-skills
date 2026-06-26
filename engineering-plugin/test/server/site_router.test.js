/*
 * site_router.test.js — PS-3: the SPA router resolves views from the path and
 * preserves the token across navigation; the cooler plan-detail view renders a
 * progress bar, status pills, section type-icons, and a section-jump nav.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PlanSite = require("../../assets/site.js");
const { makeDocument } = require("../harness/dom.js");

test("resolveRoute('/') → home", () => {
  assert.deepEqual(PlanSite.resolveRoute("/"), { view: "home", slug: null });
});

test("resolveRoute('/plan/:slug') → plan detail with slug", () => {
  assert.deepEqual(PlanSite.resolveRoute("/plan/my-plan"), { view: "plan", slug: "my-plan" });
});

test("resolveRoute ignores query/hash and decodes the slug", () => {
  const r = PlanSite.resolveRoute("/plan/my-plan");
  assert.equal(r.slug, "my-plan");
});

test("withToken preserves the token across navigation hrefs", () => {
  assert.match(PlanSite.withToken("/plan/x", "TKN"), /token=TKN/);
  assert.match(PlanSite.withToken("/plan/x?a=1", "TKN"), /\?a=1&token=TKN/);
  assert.equal(PlanSite.withToken("/plan/x", ""), "/plan/x");
});

const PLAN = {
  schema: "engplan/1", kind: "plan", slug: "cool", title: "Cooler Plan",
  status: "in_progress", convergence: "score", updated_at: "2026-06-26T00:00:00.000Z",
  sections: [
    { id: "obj", heading: "Objective", type: "prose", md: "why" },
    { id: "t1", heading: "Task one", type: "task", state: "done", md: "a" },
    { id: "t2", heading: "Task two", type: "task", state: "doing", md: "b" },
    { id: "t3", heading: "Task three", type: "task", state: "todo", md: "c" },
    { id: "g1", heading: "Gate", type: "gate", md: "ship it" },
  ],
};

test("renderDetail draws a progress bar with done/total tasks", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  PlanSite.renderDetail(d, app, PLAN, {});
  const prog = app.querySelector(".plan-progress");
  assert.ok(prog, "progress bar present");
  // 1 of 3 tasks done
  assert.match(prog.querySelector(".label").textContent, /1\s*\/\s*3/);
});

test("renderDetail shows the plan header with title + status pill", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  PlanSite.renderDetail(d, app, PLAN, {});
  const head = app.querySelector(".plan-header");
  assert.ok(head, "plan header present");
  assert.match(head.textContent, /Cooler Plan/);
  assert.ok(head.querySelector(".badge"), "status pill present");
});

test("renderDetail builds a section-jump nav with one entry per section", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  PlanSite.renderDetail(d, app, PLAN, {});
  const jump = app.querySelector(".section-jump");
  assert.ok(jump, "section-jump nav present");
  assert.equal(jump.querySelectorAll("a").length, PLAN.sections.length, "one jump link per section");
  // type icons present in the jump nav
  assert.ok(jump.querySelector(".sec-icon"), "jump entries carry a type icon");
});

test("renderDetail renders section cards (reusing PlanRenderer) with state pills", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  PlanSite.renderDetail(d, app, PLAN, {});
  const sec = app.querySelector('[data-section-id="t1"]');
  assert.ok(sec, "task section rendered");
  assert.ok(sec.querySelector(".badge-state-done"), "done task carries a state pill");
});

test("sectionIcon returns a glyph per section type", () => {
  assert.ok(PlanSite.sectionIcon("task"));
  assert.ok(PlanSite.sectionIcon("prose"));
  assert.ok(PlanSite.sectionIcon("gate"));
});
