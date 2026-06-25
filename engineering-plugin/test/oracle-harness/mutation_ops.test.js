"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { OPERATORS, viableOperators, makeMutant } = require(path.join(__dirname, "..", "..", "tools/oracle/mutate.js"));

test("mutation_ops: operators map to contract elements (status/exit/event/lifecycle)", () => {
  const cats = new Set(OPERATORS.map((o) => o.category));
  assert.ok(cats.has("not-found"));
  assert.ok(cats.has("illegal-transition"));
  assert.ok(cats.has("loopback-violation"));
  assert.ok(cats.has("cap-exceeded"));
});

test("mutation_ops: all catalog operators are viable against the build (find present)", () => {
  const v = viableOperators();
  assert.equal(v.length, OPERATORS.length, "every operator must apply to the current build");
});

test("mutation_ops: each operator yields a runnable mutant artifact", () => {
  for (const op of OPERATORS) {
    const m = makeMutant(op, {});
    try {
      assert.ok(m.applied, "operator did not apply: " + op.id);
      // mutant module must still load (syntactically valid)
      const full = require.resolve(path.join(m.dir, op.file));
      delete require.cache[full];
      assert.doesNotThrow(() => require(full), "mutant module must load: " + op.id);
    } finally {
      try { fs.rmSync(m.dir, { recursive: true, force: true }); } catch (_) {}
    }
  }
});

test("mutation_ops: catalog is enumerable + reproducible", () => {
  const a = viableOperators().map((o) => o.id);
  const b = viableOperators().map((o) => o.id);
  assert.deepEqual(a, b);
});
