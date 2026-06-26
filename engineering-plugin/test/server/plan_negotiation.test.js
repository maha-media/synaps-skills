/*
 * plan_negotiation.test.js — PS-3 / Decision B: GET /plan/:id content-
 * negotiates. A browser navigation (Accept: text/html) gets the SPA shell;
 * any non-navigation request gets the standalone self-contained file.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withServer } = require("../harness/runner.js");

const PLAN = {
  schema: "engplan/1", kind: "plan", slug: "neg-demo", title: "Negotiation Demo",
  status: "in_progress", convergence: "none",
  sections: [{ id: "s1", heading: "Intro", type: "prose", md: "hi" }],
};

test("GET /plan/:id with Accept: text/html → SPA shell", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(PLAN);
    const res = await ctx.client.get("/plan/neg-demo", { Accept: "text/html,application/xhtml+xml" });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(res.text, /id="plan-list"/, "navigation gets the SPA shell");
    assert.match(res.text, /\/_assets\/site\.js/, "shell loads site.js");
    // the shell does NOT embed the plan JSON — the SPA fetches /api/plan/:id
    assert.ok(!/id="plan"\s+type="application\/json"/.test(res.text), "shell is not the standalone file");
  });
});

test("GET /plan/:id without html Accept → standalone self-contained file", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(PLAN);
    const res = await ctx.client.get("/plan/neg-demo"); // harness client sends no Accept
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(res.text, /id="plan"/, "standalone file embeds the #plan JSON");
    assert.match(res.text, /Negotiation Demo/, "standalone carries the plan content");
    assert.ok(!/id="plan-list"/.test(res.text), "standalone is not the shell");
  });
});

test("GET /plan/:id with Accept: */* → standalone file (curl-style)", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(PLAN);
    const res = await ctx.client.get("/plan/neg-demo", { Accept: "*/*" });
    assert.equal(res.status, 200);
    assert.match(res.text, /id="plan"/, "curl gets the standalone file");
  });
});

test("GET /plan/:id missing → 404 even for browser navigation", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/plan/nope", { Accept: "text/html" });
    assert.equal(res.status, 404);
  });
});
