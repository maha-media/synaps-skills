/*
 * shell_spa.test.js — PS-2: GET / serves the SPA shell with the brand header,
 * a persistent sidebar container, a main mount point, and loads site.css +
 * site.js. The shell is the single chrome served for all SPA routes.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withServer, PLUGIN_DIR } = require("../harness/runner.js");

test("GET / → 200 SPA shell with brand header + sidebar + main mount", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    const html = res.text;
    // loads the SPA assets
    assert.match(html, /\/_assets\/site\.css/, "loads site.css");
    assert.match(html, /\/_assets\/site\.js/, "loads site.js");
    // chrome: persistent sidebar list + main mount
    assert.match(html, /id=["']plan-list["']/, "sidebar plan-list container");
    assert.match(html, /id=["']app["']/, "main mount #app");
    // brand wordmark + search box
    assert.match(html, /plan-search/, "sidebar search input");
    assert.match(html, /Maha\s*Media|mahamedia-logo\.svg|class=["']brand/i, "brand header present");
    // token still injected for the SPA to carry
    assert.match(html, /window\.__PLAN_TOKEN__/, "token injected into shell");
  });
});

test("site.css exists, references the local logo, and has no CDN URLs", async () => {
  const css = fs.readFileSync(path.join(PLUGIN_DIR, "assets", "site.css"), "utf8");
  assert.match(css, /\/_assets\/mahamedia-logo\.svg/, "logo referenced locally");
  assert.ok(!/https?:\/\//i.test(css), "site.css has zero http(s) URLs");
});

test("served /_assets/site.css and /_assets/site.js load locally", async () => {
  await withServer(async (ctx) => {
    const css = await ctx.client.get("/_assets/site.css");
    assert.equal(css.status, 200);
    assert.match(css.headers["content-type"], /text\/css/);
    const js = await ctx.client.get("/_assets/site.js");
    assert.equal(js.status, 200);
    assert.match(js.headers["content-type"], /text\/javascript/);
  });
});
