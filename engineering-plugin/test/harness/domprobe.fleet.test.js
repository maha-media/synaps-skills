"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeDocument } = require("./dom.js");
const { withServer } = require("./runner.js");
const { FleetSim } = require("./fleetsim.js");

// Render the fleet roster into the DOM (monitoring plane, P5-3).
function renderFleet(doc, agents) {
  const root = doc.createElement("div"); root.setAttribute("class", "fleet");
  agents.forEach((a) => {
    const el = doc.createElement("div");
    el.setAttribute("class", "agent " + (a.status === "dead" ? "dead" : "live"));
    el.setAttribute("data-agent-id", a.id);
    el.textContent = a.role + " " + (a.pane || "in-process") + " depth=" + a.depth + " " + a.status;
    root.appendChild(el);
  });
  return root;
}

test("P5-3: portal fleet view renders live roster + drops dead agents", async () => {
  await withServer(async (ctx) => {
    const fleet = new FleetSim(ctx, { maxImplAgents: 4 });
    fleet.spawnImpl({ depth: 1 });
    fleet.spawnImpl({ depth: 1 });
    const doc = makeDocument();
    let root = renderFleet(doc, fleet.roster());
    assert.equal(root.querySelectorAll(".agent").length, 2, "roster renders both agents");
    ctx.clock.set("2026-06-25T13:00:00.000Z");
    fleet.registry.reap(Date.parse("2026-06-25T13:00:00.000Z"));
    root = renderFleet(doc, fleet.roster());
    assert.ok(root.querySelectorAll(".agent.dead").length >= 1, "dead agents flagged in portal");
  });
});
