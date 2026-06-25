/*
 * bind.test.js (security) — P4-SEC-1 regression: bind is loopback-only, never
 * 0.0.0.0, on a random ephemeral port.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withServer } = require("../harness/runner.js");

test("bind address is 127.0.0.1 and refuses 0.0.0.0", async () => {
  await withServer(async (ctx) => {
    const addr = ctx.srv.httpServer.address();
    assert.equal(addr.address, "127.0.0.1");
    assert.notEqual(addr.address, "0.0.0.0");
    assert.notEqual(addr.address, "::");
  });
});

test("port is randomized/ephemeral (>1024)", async () => {
  await withServer(async (ctx) => {
    assert.ok(ctx.srv.httpServer.address().port > 1024);
  });
});
