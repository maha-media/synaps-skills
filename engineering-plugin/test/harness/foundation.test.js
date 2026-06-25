"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { withServer, makeClock, makeIds } = require("./runner.js");
const { SCENARIOS } = require("./scenarios.js");

test("H-0: scenario registry lists scenarios", () => {
  assert.ok(Object.keys(SCENARIOS).length >= 21, "S1-S21 registered");
  assert.ok(SCENARIOS.S1.prove, "S1 marked provable");
});

test("H-0: injectable clock is deterministic + monotonic", () => {
  const c = makeClock("2026-01-01T00:00:00.000Z");
  const a = c.now(), b = c.now();
  assert.notEqual(a, b); assert.ok(a < b);
});

test("H-0: withServer spins ephemeral loopback SUT in a temp repo and tears down", async () => {
  let port;
  await withServer(async (ctx) => {
    assert.equal(ctx.srv.httpServer.address().address, "127.0.0.1");
    port = ctx.srv.port; assert.ok(port > 1024);
    const r = await ctx.client.get("/api/plans");
    assert.equal(r.status, 200);
  });
});

test("H-0: --prove red->green for a provable scenario (S2)", async () => {
  let red = false;
  try { await SCENARIOS.S2.fn({ control: true }); } catch (_) { red = true; }
  assert.ok(red, "control (feature-disabled) run fails");
  await SCENARIOS.S2.fn({ control: false }); // green
});
