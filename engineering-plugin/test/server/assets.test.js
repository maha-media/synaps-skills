/*
 * assets.test.js — P1-2: GET /_assets/<file> serves the plugin's assets with
 * correct content-type; traversal paths are not served.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withServer, PLUGIN_DIR } = require("../harness/runner.js");

test("GET /_assets/plan.js → 200 text/javascript matching source", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/_assets/plan.js");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/javascript/);
    const onDisk = fs.readFileSync(path.join(PLUGIN_DIR, "assets", "plan.js"), "utf8");
    assert.equal(res.text, onDisk, "served body must equal plugin assets/plan.js");
  });
});

test("GET /_assets/engplan.js → 200 text/javascript", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/_assets/engplan.js");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/javascript/);
    const onDisk = fs.readFileSync(path.join(PLUGIN_DIR, "assets", "engplan.js"), "utf8");
    assert.equal(res.text, onDisk);
  });
});

test("traversal asset path is NOT served (status != 200)", async () => {
  await withServer(async (ctx) => {
    // encoded traversal so URL normalization doesn't collapse it before the server sees it
    const res = await ctx.client.get("/_assets/..%2f..%2fpackage.json");
    assert.notEqual(res.status, 200, "traversal must not be served");
    assert.ok(res.status === 403 || res.status === 404, "expected 403/404, got " + res.status);
    assert.ok(!/engineering-plans-server/.test(res.text), "must not leak package.json contents");
  });
});
