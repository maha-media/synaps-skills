"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { differential } = require(path.join(__dirname, "..", "..", "tools/oracle/twins_diff.js"));
const { makeMutant, OPERATORS } = require(path.join(__dirname, "..", "..", "tools/oracle/mutate.js"));

const BUILD = path.join(__dirname, "..", "..");

test("twins_injected: a perturbed twin surfaces >=1 divergence to the Judge", async () => {
  // Perturb twinB: unknown plan returns 200 instead of 404.
  const op = OPERATORS.find((o) => o.id === "status-404-to-200");
  const m = makeMutant(op, { buildRoot: BUILD });
  try {
    assert.ok(m.applied, "mutant must apply");
    const r = await differential({ targetDir: BUILD, lineage_id: "TA" }, { targetDir: m.dir, lineage_id: "TB" }, { inputBudget: 20 });
    assert.ok(r.divergences.length >= 1, "must surface the injected divergence");
    const d = r.divergences.find((x) => x.probe === "unknown-plan-status");
    assert.ok(d, "divergence on the unknown-plan-status probe");
    // divergence record carries probe/category/audit_id only — no raw values
    assert.deepEqual(Object.keys(d).sort(), ["audit_id", "category", "probe"]);
  } finally {
    try { fs.rmSync(m.dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test("twins_injected: identical-correct twins yield zero false divergences", async () => {
  const r = await differential({ targetDir: BUILD }, { targetDir: BUILD }, { inputBudget: 20 });
  assert.equal(r.divergences.length, 0);
});
