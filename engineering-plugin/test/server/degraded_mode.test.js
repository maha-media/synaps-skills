/*
 * degraded_mode.test.js — PS-4: a standalone *.plan.html opened from file://
 * (no server, no fetch, no EventSource) still renders its embedded engplan/1
 * JSON via plan.js boot. The SPA is an enhancement layer, never a requirement.
 *
 * Also proves the served standalone file (content-negotiated, non-navigation)
 * is genuinely self-contained: it embeds #plan JSON and references plan.js.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PlanRenderer = require("../../assets/plan.js");
const { makeDocument } = require("../harness/dom.js");
const { withServer, planArtifact } = require("../harness/runner.js");

const PLAN = {
  schema: "engplan/1", kind: "plan", slug: "offline", title: "Offline Plan",
  status: "drafting", convergence: "none",
  sections: [
    { id: "intro", heading: "Intro", type: "prose", md: "no server needed" },
    { id: "t1", heading: "Do it", type: "task", state: "todo", md: "x" },
  ],
};

test("standalone artifact is self-contained (embeds #plan JSON + loads plan.js)", () => {
  const html = planArtifact(PLAN);
  assert.match(html, /<script id="plan" type="application\/json">/, "embeds the plan JSON");
  assert.match(html, /\/_assets\/plan\.js/, "references the renderer");
  assert.ok(!/\/api\//.test(html), "no /api dependency required to render");
});

test("file:// degraded boot renders embedded plan with NO fetch / NO EventSource", () => {
  const d = makeDocument();
  // Build the in-DOM equivalent of opening the file: a #plan script + #app.
  const script = d.createElement("script");
  script.setAttribute("id", "plan");
  script.setAttribute("type", "application/json");
  script.textContent = JSON.stringify(PLAN);
  const app = d.createElement("div");
  app.setAttribute("id", "app");
  d.body.appendChild(script);
  d.body.appendChild(app);

  // No opts.fetch, no opts.EventSource → degraded mode. Must still render.
  PlanRenderer.boot({ document: d });

  assert.ok(app.querySelector(".plan-header"), "header rendered offline");
  assert.match(app.querySelector(".plan-header").textContent, /Offline Plan/);
  assert.ok(app.querySelector('[data-section-id="intro"]'), "prose section rendered offline");
  assert.ok(app.querySelector('[data-section-id="t1"]'), "task section rendered offline");
});

test("content-negotiated standalone (curl) is the self-contained file", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(PLAN);
    const res = await ctx.client.get("/plan/offline"); // no html Accept
    assert.match(res.text, /<script id="plan"/, "served standalone embeds plan JSON");
    assert.match(res.text, /Offline Plan/);
  });
});
