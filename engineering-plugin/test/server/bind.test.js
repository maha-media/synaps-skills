/*
 * bind.test.js — P1-1 / P4-SEC-1: server binds 127.0.0.1 on a random
 * ephemeral port (never 0.0.0.0).
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withServer } = require("../harness/runner.js");

test("server binds loopback 127.0.0.1, never 0.0.0.0", async () => {
  await withServer(async (ctx) => {
    const addr = ctx.srv.httpServer.address();
    assert.equal(addr.address, "127.0.0.1", "must bind loopback");
    assert.notEqual(addr.address, "0.0.0.0", "must never bind all interfaces");
    assert.ok(["IPv4"].includes(addr.family) || addr.family === 4, "loopback IPv4 family");
  });
});

test("port is random/ephemeral (>1024)", async () => {
  await withServer(async (ctx) => {
    const addr = ctx.srv.httpServer.address();
    assert.equal(typeof addr.port, "number");
    assert.ok(addr.port > 1024, "ephemeral port should be > 1024, got " + addr.port);
    assert.equal(ctx.srv.port, addr.port, "srv.port getter matches address");
  });
});
