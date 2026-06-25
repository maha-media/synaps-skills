/*
 * discovery.test.js — P1-3: GET /api/plans returns one entry per artifact with
 * the spec §6 shape; malformed artifacts are skipped (not fatal).
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withServer } = require("../harness/runner.js");

function basePlan(slug, title) {
  return {
    schema: "engplan/1", kind: "plan", slug, title, status: "drafting",
    convergence: "none", created_at: null, updated_at: null,
    sections: [{ id: "s1", heading: "First", type: "prose", md: "hello" }],
  };
}

test("GET /api/plans returns 2 entries with required fields", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(basePlan("alpha", "Alpha Plan"));
    ctx.writePlan(basePlan("beta", "Beta Plan"));

    const res = await ctx.client.get("/api/plans");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json));
    assert.equal(res.json.length, 2, "expected exactly 2 plans");

    for (const e of res.json) {
      for (const k of ["id", "title", "kind", "status", "mtime", "path", "attention"]) {
        assert.ok(k in e, "entry missing field: " + k);
      }
      assert.equal(typeof e.attention, "object");
      for (const c of ["blocking", "unresolved", "needs_review"]) {
        assert.ok(c in e.attention, "attention missing counter: " + c);
      }
    }
    const ids = res.json.map((e) => e.id).sort();
    assert.deepEqual(ids, ["alpha", "beta"]);
  });
});

test("malformed artifact is skipped, not fatal", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(basePlan("good", "Good Plan"));
    // Write a .plan.html whose embedded JSON is broken.
    const broken = [
      "<!doctype html><html><head></head><body>",
      '<script id="plan" type="application/json">',
      "{ this is : not valid json ,,, }",
      "</script><div id=app></div></body></html>",
    ].join("\n");
    fs.writeFileSync(path.join(ctx.repoRoot, ".plans", "broken.plan.html"), broken);

    const res = await ctx.client.get("/api/plans");
    assert.equal(res.status, 200);
    const ids = res.json.map((e) => e.id);
    assert.ok(ids.includes("good"), "valid plan still discovered");
    assert.ok(!ids.includes("broken"), "malformed plan skipped");
  });
});
