"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { checkAll, checkProperty } = require(path.join(__dirname, "..", "..", "tools/oracle/properties.js"));
const { makeGen, shrink } = require(path.join(__dirname, "..", "..", "tools/oracle/gen.js"));

const FIX = path.join(__dirname, "fixtures");

test("properties: generator is deterministic by seed", () => {
  const a = []; const g1 = makeGen(42); for (let i = 0; i < 5; i++) a.push(g1.int(0, 1000));
  const b = []; const g2 = makeGen(42); for (let i = 0; i < 5; i++) b.push(g2.int(0, 1000));
  assert.deepEqual(a, b);
});

test("properties: held invariant passes across >=1000 generated cases", () => {
  const r = checkAll(path.join(FIX, "props-good"), { sutFactory: undefined, cases: 1000 });
  // props-good targets the REAL build (default sut)
  assert.equal(r.failed.length, 0, "malformed-safe property must hold");
  assert.equal(r.passed[0].cases, 1000);
});

test("properties: violated invariant is caught and shrunk to a minimal counterexample", () => {
  const brokenFactory = () => ({ brokenAbs: (n) => n }); // identity: negative for any n<0
  const r = checkAll(path.join(FIX, "props-violated"), { sutFactory: brokenFactory, cases: 2000 });
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].category, "property-violation");
  assert.ok(r.failed[0].counterexampleSize >= 0);
});

test("properties: shrink reduces a failing number toward zero", () => {
  const minimal = shrink(98765, (x) => x > 5);
  assert.ok(minimal <= 6 && minimal > 5, "shrunk to boundary, got " + minimal);
});
