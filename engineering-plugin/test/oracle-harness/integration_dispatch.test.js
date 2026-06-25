"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { LineageLedger, SESSION_MODEL } = require(path.join(__dirname, "..", "..", "tools/oracle/lineage.js"));

const ROOT = path.join(__dirname, "..", "..");

test("integration_dispatch: Designer + Builder are separate sibling lineages", () => {
  const ledger = new LineageLedger({});
  ledger.dispatch({ role: "orchestrator", system_prompt: "neutral orchestrator", lineage_id: "orch" });
  const d = ledger.dispatch({ role: "designer", system_prompt: "adversary: author the oracle from spec+contract; never read product impl", parent_id: "orch", lineage_id: "designer" });
  const b = ledger.dispatch({ role: "builder", agent: "builder", parent_id: "orch", lineage_id: "builder" });
  assert.ok(ledger.assertSiblings(d.lineage_id, b.lineage_id));
  assert.notEqual(d.parent_id, d.lineage_id);
  assert.equal(d.parent_id, b.parent_id, "both parented by the neutral orchestrator");
});

test("integration_dispatch: every dispatch carries agent|system_prompt; model = explicit ?? session", () => {
  const ledger = new LineageLedger({});
  ledger.dispatch({ role: "orchestrator", system_prompt: "o", lineage_id: "orch" });
  const d = ledger.dispatch({ role: "designer", system_prompt: "d", parent_id: "orch" });
  assert.equal(d.model, SESSION_MODEL, "unspecified model resolves to session model");
  assert.throws(() => ledger.dispatch({ role: "builder", parent_id: "orch" }), (e) => e.category === "dispatch-doctrine");
});

test("integration_dispatch: convergence-loop skill references the oracle layer", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills/convergence-loop/SKILL.md"), "utf8");
  for (const needle of ["Adversarial Test Oracle", "hidden suite", "survived-budget", "write-segregation"]) {
    assert.ok(skill.includes(needle), "convergence-loop must mention: " + needle);
  }
});
