"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { withServer } = require("../harness/runner.js");

// P4-SEC-6: CSP on served pages restricts script-src to 'self' (and /_assets is
// same-origin), disabling inline handlers. spec §7.2.
test("GET / carries a CSP header with script-src 'self'", async () => {
  await withServer(async (ctx) => {
    const r = await ctx.client.get("/");
    assert.equal(r.status, 200);
    const csp = r.headers["content-security-policy"];
    assert.ok(csp, "CSP header present");
    assert.match(csp, /script-src 'self'/, "script-src locked to self");
    assert.match(csp, /default-src 'self'/, "default-src self");
  });
});

test("GET /plan/<id> carries the CSP header", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan({ schema: "engplan/1", kind: "plan", slug: "csp", title: "CSP", status: "drafting", sections: [{ id: "s", heading: "S", type: "prose", md: "x" }] });
    const r = await ctx.client.get("/plan/csp");
    assert.equal(r.status, 200);
    assert.match(r.headers["content-security-policy"] || "", /script-src 'self'/);
  });
});

test("API responses also carry CSP + nosniff", async () => {
  await withServer(async (ctx) => {
    const r = await ctx.client.get("/api/plans");
    assert.ok((r.headers["content-security-policy"] || "").includes("script-src 'self'"));
    assert.equal(r.headers["x-content-type-options"], "nosniff");
  });
});
