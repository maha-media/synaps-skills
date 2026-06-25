"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LineageLedger, SESSION_MODEL } = require(path.join(__dirname, "..", "..", "tools/oracle/lineage.js"));

function tmpFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oracle-ledger-")), "lineage.log"); }
const clk = () => { let n = 0; return { now: () => "2025-01-01T00:00:0" + (n++) + ".000Z" }; };

test("lineage: dispatch with neither agent nor system_prompt is refused", () => {
  const l = new LineageLedger({ clock: clk() });
  assert.throws(() => l.dispatch({ role: "designer" }), (e) => e.category === "dispatch-doctrine");
});

test("lineage: missing model resolves to session model (never weaker)", () => {
  const l = new LineageLedger({ clock: clk() });
  const e = l.dispatch({ role: "designer", system_prompt: "x" });
  assert.equal(e.model, SESSION_MODEL);
  const e2 = l.dispatch({ role: "builder", agent: "builder-agent", model: "claude-sonnet-4-6" });
  assert.equal(e2.model, "claude-sonnet-4-6");
});

test("lineage: designer and builder must be siblings, not nested", () => {
  const l = new LineageLedger({ clock: clk() });
  const orch = l.dispatch({ role: "orchestrator", system_prompt: "orch", lineage_id: "orch" });
  const designer = l.dispatch({ role: "designer", system_prompt: "d", parent_id: "orch", lineage_id: "D" });
  const builder = l.dispatch({ role: "builder", system_prompt: "b", parent_id: "orch", lineage_id: "B" });
  assert.ok(l.assertSiblings("D", "B"));
});

test("lineage: rejects builder nested under designer (grader parents graded)", () => {
  const l = new LineageLedger({ clock: clk() });
  l.dispatch({ role: "orchestrator", system_prompt: "o", lineage_id: "orch" });
  l.dispatch({ role: "designer", system_prompt: "d", parent_id: "orch", lineage_id: "D" });
  l.dispatch({ role: "builder", system_prompt: "b", parent_id: "D", lineage_id: "B" });
  assert.throws(() => l.assertSiblings("D", "B"), (e) => e.category === "lineage-violation");
});

test("lineage: rejects designer nested under builder", () => {
  const l = new LineageLedger({ clock: clk() });
  l.dispatch({ role: "orchestrator", system_prompt: "o", lineage_id: "orch" });
  l.dispatch({ role: "builder", system_prompt: "b", parent_id: "orch", lineage_id: "B" });
  l.dispatch({ role: "designer", system_prompt: "d", parent_id: "B", lineage_id: "D" });
  assert.throws(() => l.assertSiblings("D", "B"), (e) => e.category === "lineage-violation");
});

test("lineage: ledger is append-only + persisted + auditable", () => {
  const file = tmpFile();
  const l = new LineageLedger({ file, clock: clk() });
  l.dispatch({ role: "orchestrator", system_prompt: "o", lineage_id: "orch" });
  l.dispatch({ role: "designer", system_prompt: "d", parent_id: "orch", lineage_id: "D" });
  const l2 = new LineageLedger({ file, clock: clk() });
  assert.equal(l2.entries.length, 2);
  assert.throws(() => l2.dispatch({ role: "designer", system_prompt: "x", lineage_id: "D" }), (e) => e.category === "validation-error");
});
