"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnTwins } = require(path.join(__dirname, "..", "..", "tools/oracle/twins.js"));
const { LineageLedger, SESSION_MODEL } = require(path.join(__dirname, "..", "..", "tools/oracle/lineage.js"));

const BUILD = path.join(__dirname, "..", "..");

test("twins_spawn: two zero-contact builder siblings from one contract", () => {
  const ledger = new LineageLedger({});
  const orch = ledger.dispatch({ role: "orchestrator", system_prompt: "o", lineage_id: "orch" });
  const t = spawnTwins({ ledger, parentId: "orch", twinADir: BUILD, twinBDir: BUILD, system_prompt: "twin" });
  assert.notEqual(t.a.lineage_id, t.b.lineage_id);
  // siblings, not nested — assertSiblings already ran in spawnTwins without throwing
  assert.ok(!ledger.isAncestor(t.a.lineage_id, t.b.lineage_id));
  assert.ok(!ledger.isAncestor(t.b.lineage_id, t.a.lineage_id));
});

test("twins_spawn: dispatch carries system_prompt + model resolves to session", () => {
  const ledger = new LineageLedger({});
  ledger.dispatch({ role: "orchestrator", system_prompt: "o", lineage_id: "orch" });
  const t = spawnTwins({ ledger, parentId: "orch", twinADir: BUILD, twinBDir: BUILD });
  assert.equal(t.a.model, SESSION_MODEL);
  assert.equal(t.b.model, SESSION_MODEL);
});

test("twins_spawn: refuses to nest one twin under the other", () => {
  const ledger = new LineageLedger({});
  ledger.dispatch({ role: "orchestrator", system_prompt: "o", lineage_id: "orch" });
  ledger.dispatch({ role: "builder", system_prompt: "a", parent_id: "orch", lineage_id: "TA" });
  // a nested twin must be rejected by assertSiblings
  ledger.dispatch({ role: "builder", system_prompt: "b", parent_id: "TA", lineage_id: "TB" });
  assert.throws(() => ledger.assertSiblings("TA", "TB"), (e) => e.category === "lineage-violation");
});
