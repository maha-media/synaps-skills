/*
 * token.test.js — P4-SEC-2: per-session token enforced on every request; no
 * token / wrong token → 401, correct token → 200; token never written to the
 * .plans artifact on disk.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { withServer } = require("../harness/runner.js");

// raw request that does NOT auto-attach the token.
function raw(base, p, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const r = http.request(u, { method: "GET", headers: headers || {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    r.end();
  });
}

test("no token → 401", async () => {
  await withServer(async (ctx) => {
    const res = await raw(ctx.base, "/api/plans");
    assert.equal(res.status, 401);
  });
});

test("wrong token → 401", async () => {
  await withServer(async (ctx) => {
    const res = await raw(ctx.base, "/api/plans?token=not-the-real-token");
    assert.equal(res.status, 401);
    const res2 = await raw(ctx.base, "/api/plans", { "X-Plan-Token": "still-wrong" });
    assert.equal(res2.status, 401);
  });
});

test("correct token → 200", async () => {
  await withServer(async (ctx) => {
    const viaQuery = await raw(ctx.base, "/api/plans?token=" + encodeURIComponent(ctx.token));
    assert.equal(viaQuery.status, 200);
    const viaHeader = await raw(ctx.base, "/api/plans", { "X-Plan-Token": ctx.token });
    assert.equal(viaHeader.status, 200);
  });
});

test("token is NOT persisted into the .plans artifact on disk", async () => {
  await withServer(async (ctx) => {
    const file = ctx.writePlan({
      schema: "engplan/1", kind: "plan", slug: "secplan", title: "Sec", status: "drafting",
      convergence: "none", sections: [{ id: "s1", heading: "S1", type: "prose", md: "x" }],
    });
    // serve it (token injected into the *response*, not the file)
    const res = await ctx.client.get("/plan/secplan");
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(ctx.token), "served HTML carries the token");

    const onDisk = fs.readFileSync(file, "utf8");
    assert.ok(!onDisk.includes(ctx.token), "token must never be written to the .plans artifact");
    // sanity: also not present anywhere under .plans/
    for (const f of fs.readdirSync(path.join(ctx.repoRoot, ".plans"))) {
      const c = fs.readFileSync(path.join(ctx.repoRoot, ".plans", f), "utf8");
      assert.ok(!c.includes(ctx.token), "token leaked into " + f);
    }
  });
});
