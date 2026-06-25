/*
 * token_gate.test.js — P-V3: regression for the "stuck on Loading…" viewer bug.
 *
 * The browser fetches renderer assets (/_assets/*) WITHOUT a token, so those
 * must be served before the token gate. Data routes (/api/*) must still require
 * the token, and path traversal must still be confined.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withServer, client } = require("../harness/runner.js");

test("GET /_assets/plan.js with NO token → 200 (served before token gate)", async () => {
  await withServer(async (ctx) => {
    const noTokenClient = client(ctx.base, null); // never attaches ?token=
    const res = await noTokenClient.get("/_assets/plan.js");
    assert.equal(res.status, 200, "renderer asset must load without a token");
    assert.match(res.headers["content-type"], /text\/javascript/);
  });
});

test("GET /api/plans with NO token → 401 (data route still gated)", async () => {
  await withServer(async (ctx) => {
    const noTokenClient = client(ctx.base, null);
    const res = await noTokenClient.get("/api/plans");
    assert.equal(res.status, 401, "data routes must still require the token");
  });
});

test("traversal under /_assets with NO token → 403 (confinement intact)", async () => {
  await withServer(async (ctx) => {
    const noTokenClient = client(ctx.base, null);
    const res = await noTokenClient.get("/_assets/..%2f..%2fpackage.json");
    assert.equal(res.status, 403, "traversal must be forbidden even for assets");
    assert.ok(!/engineering-plans-server/.test(res.text), "must not leak package.json");
  });
});
