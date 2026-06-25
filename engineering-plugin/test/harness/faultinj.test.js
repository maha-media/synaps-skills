"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { withServer } = require("./runner.js");
const { FaultInj } = require("./faultinj.js");

test("H-4: missing/wrong token refused (401)", async () => {
  await withServer(async (ctx) => {
    const f = new FaultInj(ctx);
    assert.equal((await f.missingToken()).status, 401);
    assert.equal((await f.wrongToken()).status, 401);
  });
});

test("H-4: path-traversal note write/read refused; nothing written outside .plans/", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan({ schema:"engplan/1", kind:"plan", slug:"p", title:"P", status:"drafting", sections:[{id:"s",heading:"S",type:"prose"}] });
    const f = new FaultInj(ctx);
    const w = await f.traversalNoteWrite();
    assert.ok(w.status >= 400, "traversal write rejected");
    const r = await f.traversalRead();
    assert.ok(r.status >= 400, "traversal read rejected");
    assert.ok(!fs.existsSync("/tmp/etc/passwd"));
    const root = fs.readdirSync(ctx.repoRoot);
    assert.ok(!root.includes("etc"), "no stray writes in repo root");
  });
});

test("H-4: oversized body + malformed json/event refused (no crash)", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan({ schema:"engplan/1", kind:"plan", slug:"p", title:"P", status:"drafting", sections:[{id:"s",heading:"S",type:"prose"}] });
    const f = new FaultInj(ctx);
    const big = await f.oversizedBody("p");
    assert.ok(big.status >= 400 || big.reset, "oversized rejected (4xx or connection reset)");
    assert.ok((await f.malformedJson("p")).status >= 400, "malformed json rejected");
    assert.ok((await f.malformedEvent("p")).status >= 400, "malformed event rejected");
    // server still alive
    assert.equal((await ctx.client.get("/api/plans")).status, 200);
  });
});
