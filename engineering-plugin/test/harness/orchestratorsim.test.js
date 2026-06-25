"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { withServer } = require("./runner.js");
const { OrchestratorSim, DISPATCH_ERROR } = require("./orchestratorsim.js");
const { SCENARIOS } = require("./scenarios.js");

test("H-6: dispatch with neither agent nor system_prompt is refused before any call (§9.1)", async () => {
  await withServer(async (ctx) => {
    const o = new OrchestratorSim(ctx, { slug: "x" });
    assert.throws(() => o.dispatch({ role: {} }, null), (e) => e.message === DISPATCH_ERROR && e.code === "NO_ROLE");
  });
});

test("H-6: model inheritance — no model resolves to session model (§9.2)", async () => {
  await withServer(async (ctx) => {
    const o = new OrchestratorSim(ctx, { slug: "x", sessionModel: "claude-opus-4-8" });
    const h = o.dispatch({ role: { agent: "coder" } }, null);
    assert.equal(h.model, "claude-opus-4-8");
    assert.equal(h.model_inherited, true);
    const h2 = o.dispatch({ role: { agent: "c" }, model: "explicit-model" }, null);
    assert.equal(h2.model, "explicit-model");
    assert.equal(h2.model_inherited, false);
  });
});

test("H-6/S14: poll-and-steer, no idle sleep (red->green)", async () => {
  let red=false; try{await SCENARIOS.S14.fn({control:true});}catch(_){red=true;} assert.ok(red);
  await SCENARIOS.S14.fn({ control:false });
});
test("H-6/S15: model inheritance scenario", async () => { await SCENARIOS.S15.fn({ control:false }); });
