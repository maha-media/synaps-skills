/*
 * site_sidebar.test.js — PS-2: PlanSite (site.js) sidebar logic, headless.
 *   - filterPlans narrows the list client-side by title/slug/kind/status
 *   - renderSidebar builds a row per plan with status pill + attention chips
 *   - the active plan row is highlighted
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PlanSite = require("../../assets/site.js");
const { makeDocument } = require("../harness/dom.js");

const PLANS = [
  { id: "plan-site", title: "The Plan Site", kind: "plan", status: "in_progress", attention: { blocking: 0, unresolved: 2, needs_review: 1 } },
  { id: "auth-spec", title: "Auth Spec", kind: "spec", status: "approved", attention: { blocking: 1, unresolved: 0, needs_review: 0 } },
  { id: "billing", title: "Billing rework", kind: "plan", status: "done", attention: { blocking: 0, unresolved: 0, needs_review: 0 } },
];

test("filterPlans by title substring (case-insensitive)", () => {
  const out = PlanSite.filterPlans(PLANS, "billing");
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "billing");
});

test("filterPlans by slug/id", () => {
  assert.equal(PlanSite.filterPlans(PLANS, "plan-site").length, 1);
});

test("filterPlans by kind and by status", () => {
  assert.equal(PlanSite.filterPlans(PLANS, "spec").length, 1); // kind
  assert.equal(PlanSite.filterPlans(PLANS, "approved").length, 1); // status
  assert.equal(PlanSite.filterPlans(PLANS, "plan").length, 2); // kind=plan
});

test("filterPlans empty query returns all", () => {
  assert.equal(PlanSite.filterPlans(PLANS, "").length, 3);
  assert.equal(PlanSite.filterPlans(PLANS, "   ").length, 3);
});

test("renderSidebar makes one row per plan with status pill + attention chips", () => {
  const d = makeDocument();
  const nav = d.createElement("nav");
  PlanSite.renderSidebar(d, nav, PLANS, { token: "T" });
  const rows = nav.querySelectorAll("a.plan-row");
  assert.equal(rows.length, 3, "one row per plan");
  // first row carries plan id + status pill
  const first = nav.querySelector('a.plan-row[data-plan-id="plan-site"]');
  assert.ok(first, "row keyed by plan id");
  assert.ok(first.querySelector(".badge"), "row has a status pill badge");
  // href carries the token across navigation
  assert.match(first.getAttribute("href"), /\/plan\/plan-site/);
  assert.match(first.getAttribute("href"), /token=T/);
  // attention chips: plan-site has unresolved=2, needs_review=1 → 2 chips
  const chips = first.querySelectorAll(".attn span");
  assert.equal(chips.length, 2, "renders only non-zero attention chips");
});

test("renderSidebar highlights the active plan row", () => {
  const d = makeDocument();
  const nav = d.createElement("nav");
  PlanSite.renderSidebar(d, nav, PLANS, { token: "T", activeId: "auth-spec" });
  const active = nav.querySelector('a.plan-row[data-plan-id="auth-spec"]');
  assert.ok(active.classList.contains("active"), "active row highlighted");
  const inactive = nav.querySelector('a.plan-row[data-plan-id="billing"]');
  assert.ok(!inactive.classList.contains("active"), "non-active row not highlighted");
});

test("renderSidebar applies the query filter when given", () => {
  const d = makeDocument();
  const nav = d.createElement("nav");
  PlanSite.renderSidebar(d, nav, PLANS, { token: "T", query: "spec" });
  assert.equal(nav.querySelectorAll("a.plan-row").length, 1);
});
