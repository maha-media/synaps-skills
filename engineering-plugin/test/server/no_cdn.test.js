/*
 * no_cdn.test.js — PS-4 acceptance: zero external font/asset URLs anywhere in
 * the served HTML/CSS/JS. The only allowed http(s) literal is the SVG XML
 * namespace (www.w3.org) inside the logo — never a fetched resource.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withServer } = require("../harness/runner.js");

const TEXT_ASSETS = [
  "/_assets/plan.css",
  "/_assets/site.css",
  "/_assets/plan.js",
  "/_assets/site.js",
  "/_assets/shell.html",
];

test("served shell + CSS + JS contain zero external http(s) URLs", async () => {
  await withServer(async (ctx) => {
    const shell = await ctx.client.get("/");
    assert.ok(!/https?:\/\//i.test(shell.text), "shell HTML has no external URLs");

    for (const p of TEXT_ASSETS) {
      const res = await ctx.client.get(p);
      assert.equal(res.status, 200, p + " served");
      assert.ok(!/https?:\/\//i.test(res.text), p + " must have zero http(s) URLs");
      assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(res.text), p + " must not reference a font CDN");
    }
  });
});

test("logo SVG only contains the w3.org XML namespace (not a fetched URL)", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/_assets/mahamedia-logo.svg");
    assert.equal(res.status, 200);
    const urls = (res.text.match(/https?:\/\/[^\s"')]+/gi) || []);
    for (const u of urls) {
      assert.match(u, /www\.w3\.org/, "only the SVG namespace is allowed, got: " + u);
    }
  });
});
