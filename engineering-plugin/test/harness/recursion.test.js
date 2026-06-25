"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { withServer } = require("./runner.js");
const { FleetSim } = require("./fleetsim.js");

test("P5-4: impl agent spawns grandchild (depth 2) registered under parent; max_depth enforced", async () => {
  await withServer(async (ctx) => {
    const fleet = new FleetSim(ctx, { maxImplAgents: 10, maxDepth: 2 });
    const child = fleet.spawnImpl({ depth: 1 });
    const gc = fleet.controller.spawn({ depth: 2, target: child.pane, backpressure: false });
    fleet.registry.register({ role: "sub", pane: gc.pane, parent: "impl", depth: 2, model: "claude-opus-4-8" });
    const roster = fleet.roster();
    assert.ok(roster.some((a) => a.depth === 2), "grandchild registered at depth 2");
    assert.throws(() => fleet.controller.spawn({ depth: 3, target: gc.pane, backpressure: false }), (e) => e.code === "DEPTH");
  });
});
