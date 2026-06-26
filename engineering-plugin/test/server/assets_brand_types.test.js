/*
 * assets_brand_types.test.js — PS-1: new static asset types under /_assets/
 * (.woff2 fonts + .svg logo) are served with correct MIME + caching, served
 * BEFORE the token gate, and stay path-confined via safeRealpath (traversal
 * through the new types → 403).
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withServer, client } = require("../harness/runner.js");

test("GET /_assets/fonts/outfit-latin.woff2 → 200 font/woff2", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/_assets/fonts/outfit-latin.woff2");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /font\/woff2/);
    assert.ok(res.headers["cache-control"], "fonts should carry a Cache-Control header");
  });
});

test("GET /_assets/fonts/cormorant-garamond-latin.woff2 → 200 font/woff2", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/_assets/fonts/cormorant-garamond-latin.woff2");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /font\/woff2/);
  });
});

test("GET /_assets/mahamedia-logo.svg → 200 image/svg+xml", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/_assets/mahamedia-logo.svg");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /image\/svg\+xml/);
  });
});

test("fonts/logo served WITHOUT a token (before the gate)", async () => {
  await withServer(async (ctx) => {
    const noTok = client(ctx.base, null);
    const f = await noTok.get("/_assets/fonts/outfit-latin.woff2");
    assert.equal(f.status, 200);
    const s = await noTok.get("/_assets/mahamedia-logo.svg");
    assert.equal(s.status, 200);
  });
});

test("traversal through /_assets/fonts/ → 403 (confinement intact)", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/_assets/fonts/..%2f..%2f..%2fetc%2fpasswd");
    assert.equal(res.status, 403, "encoded traversal must be forbidden");
    assert.ok(!/root:.*:0:0:/.test(res.text), "must not leak /etc/passwd");
  });
});

test("traversal to a .svg outside the assets dir → 403", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/_assets/..%2f..%2fpackage.json");
    assert.equal(res.status, 403);
  });
});
