/*
 * plan_api.test.js — PS-1: GET /api/plan/:id returns the parsed engplan/1 JSON.
 *
 * Status contract (documented):
 *   200 — file found + embedded engplan/1 JSON parses + validates
 *   400 — id fails EngPlan.validId
 *   401 — no/!bad token (data route, gated)
 *   404 — no plan file for that id
 *   422 — file exists but its embedded JSON is missing/unparseable/invalid
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withServer, client } = require("../harness/runner.js");

const PLAN = {
  schema: "engplan/1", kind: "plan", slug: "demo-plan", title: "Demo Plan",
  status: "in_progress", convergence: "none",
  sections: [
    { id: "obj", heading: "Objective", type: "prose", md: "Do the thing." },
    { id: "t1", heading: "Task one", type: "task", state: "done", md: "one" },
    { id: "t2", heading: "Task two", type: "task", state: "todo", md: "two" },
  ],
};

test("GET /api/plan/:id → 200 with valid engplan/1 JSON", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(PLAN);
    const res = await ctx.client.get("/api/plan/demo-plan");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /application\/json/);
    assert.equal(res.json.schema, "engplan/1");
    assert.equal(res.json.slug, "demo-plan");
    assert.equal(res.json.title, "Demo Plan");
    assert.ok(Array.isArray(res.json.sections) && res.json.sections.length === 3);
  });
});

test("GET /api/plan/:id missing → 404", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/api/plan/no-such-plan");
    assert.equal(res.status, 404);
  });
});

test("GET /api/plan/:id with invalid id → 400", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/api/plan/bad%20id"); // space → fails validId
    assert.equal(res.status, 400);
  });
});

test("GET /api/plan/:id unparseable embedded JSON → 422", async () => {
  await withServer(async (ctx) => {
    // Write a plan file with a discoverable filename but BROKEN embedded JSON.
    const file = path.join(ctx.repoRoot, ".plans", "broken.plan.html");
    fs.writeFileSync(file,
      '<!doctype html><meta charset=utf-8><title>broken</title>' +
      '<script id="plan" type="application/json">{ this is : not json, }</script>' +
      '<div id="app"></div>');
    const res = await ctx.client.get("/api/plan/broken");
    assert.equal(res.status, 422, "unparseable embedded JSON must be an explicit 422");
    assert.ok(res.json && res.json.error, "must carry a useful error for the SPA");
  });
});

test("GET /api/plan/:id with NO token → 401 (data route gated)", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(PLAN);
    const noTok = client(ctx.base, null);
    const res = await noTok.get("/api/plan/demo-plan");
    assert.equal(res.status, 401);
  });
});
