/*
 * render_endpoint.test.js — P1-4: GET /plan/<id> serves the artifact with the
 * token injected and the renderer asset referenced; GET / serves the sidebar
 * shell; unknown id → 404.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withServer } = require("../harness/runner.js");

function plan(slug, title) {
  return {
    schema: "engplan/1", kind: "plan", slug, title, status: "drafting",
    convergence: "none", created_at: null, updated_at: null,
    sections: [{ id: "s1", heading: "Intro", type: "prose", md: "x" }],
  };
}

test("GET /plan/<id> serves artifact with #plan, plan.js and injected token", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(plan("alpha", "Alpha"));
    const res = await ctx.client.get("/plan/alpha");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(res.text, /id="plan"/, "embedded #plan JSON present");
    assert.match(res.text, /\/_assets\/plan\.js/, "loads /_assets/plan.js");
    assert.match(res.text, /__PLAN_TOKEN__/, "token injected for renderer fetches");
    assert.ok(res.text.includes(ctx.token), "injected token equals server token");
  });
});

test("GET / serves the sidebar shell html", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(res.text, /id="plan-list"/, "shell has plan-list nav");
    assert.match(res.text, /id="app"/, "shell has app mount");
    assert.match(res.text, /__PLAN_TOKEN__/, "shell injects token");
  });
});

test("unknown plan id → 404", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/plan/does-not-exist");
    assert.equal(res.status, 404);
  });
});
