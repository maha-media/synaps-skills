"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { withServer } = require("./runner.js");
const { ActorSim } = require("./actorsim.js");
const { AgentSim } = require("./agentsim.js");
const { SCENARIOS } = require("./scenarios.js");
const EngPlan = require("../../assets/engplan.js");

test("H-2: ActorSim emits all 14 actions with correct actor (human + orchestrator)", async () => {
  await withServer(async (ctx) => {
    const agent = new AgentSim(ctx, { slug: "a" });
    agent.init({ title: "A", sections: [{ id: "s", heading: "S", type: "task", state: "todo" }] });
    for (const mode of ["human", "orchestrator"]) {
      const actor = new ActorSim(ctx, { slug: "a", mode });
      for (const type of EngPlan.EVENT_TYPES) {
        const ev = await actor.act(type, "s", "t");
        assert.equal(ev.type, type);
        assert.equal(ev.actor, mode);
      }
    }
  });
});

for (const s of ["S2", "S4", "S6", "S7", "S8", "S12", "S13"]) {
  test("H-2/" + s + ": " + SCENARIOS[s].desc, async () => { await SCENARIOS[s].fn({ control: false }); });
}
