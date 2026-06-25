"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { runMutationGate } = require(path.join(__dirname, "..", "..", "tools/oracle/mutation_gate.js"));

const STRONG = path.join(__dirname, "fixtures", "strong-suite");
const WEAK = path.join(__dirname, "fixtures", "weak-suite");

test("mutation_gate: a STRONG suite kills >= threshold of mutants → ACCEPTED", async () => {
  const r = await runMutationGate({ suiteDirs: [STRONG], threshold: 0.8 });
  assert.ok(r.total >= 8, "expected the full operator set");
  assert.ok(r.killRate >= 0.8, "strong suite kill rate=" + r.killRate);
  assert.equal(r.accepted, true);
});

test("mutation_gate: a deliberately WEAK suite is REJECTED with surviving mutants", async () => {
  const r = await runMutationGate({ suiteDirs: [WEAK], threshold: 0.8 });
  assert.equal(r.accepted, false, "weak suite must be rejected");
  assert.ok(r.survived.length >= 1, "must report surviving mutants");
  // survivors carry category + id ONLY (no source)
  for (const s of r.survived) {
    assert.deepEqual(Object.keys(s).sort(), ["category", "id"]);
  }
});
