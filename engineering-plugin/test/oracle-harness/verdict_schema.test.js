"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { parseVerdict, makeVerdict, looksLikeLeak } = require(path.join(__dirname, "..", "..", "tools/oracle/verdict.js"));

test("verdict_schema: well-formed verdict (counts+categories+ids) validates", () => {
  const v = makeVerdict({ pass: 10, fail: 2, categories: ["property-violation", "crash"], audit_id: "aud_1", nonce: "n1" });
  assert.equal(v.counts.pass, 10);
  assert.equal(v.categories.length, 2);
});

test("verdict_schema: verdict carrying test source is REJECTED (leak)", () => {
  const leak = { schema: "oracle/1", kind: "verdict", round: 0, counts: { pass: 0, fail: 1 },
    categories: [{ category: "crash", count: 1 }], audit_id: "a", nonce: "n",
    adversary: "assert.equal(plan.slug, 'expected-value')" };
  assert.throws(() => parseVerdict(leak), (e) => e.category === "egress-leak");
});

test("verdict_schema: forbidden top-level key rejected", () => {
  const v = { schema: "oracle/1", kind: "verdict", round: 0, counts: { pass: 1, fail: 0 }, categories: [], audit_id: "a", nonce: "n", source: "x" };
  assert.throws(() => parseVerdict(v), (e) => e.category === "egress-leak");
});

test("verdict_schema: category outside taxonomy rejected", () => {
  const v = { schema: "oracle/1", kind: "verdict", round: 0, counts: { pass: 0, fail: 1 }, categories: ["secret-asserted-value"], audit_id: "a", nonce: "n" };
  assert.throws(() => parseVerdict(v), (e) => e.category === "egress-leak");
});

test("verdict_schema: category entry with extra payload field rejected", () => {
  const v = { schema: "oracle/1", kind: "verdict", round: 0, counts: { pass: 0, fail: 1 },
    categories: [{ category: "crash", count: 1, asserted: "secret" }], audit_id: "a", nonce: "n" };
  assert.throws(() => parseVerdict(v), (e) => e.category === "egress-leak");
});

test("verdict_schema: leak heuristic flags source-like strings", () => {
  assert.ok(looksLikeLeak({ x: "expected: 42, actual: 7" }));
  assert.ok(looksLikeLeak({ x: "it('should parse', () => {})" }));
  assert.ok(!looksLikeLeak({ category: "crash", count: 3 }));
});

test("verdict_schema: malformed verdict → categorized error, never crash", () => {
  assert.throws(() => parseVerdict("{bad"), (e) => e.category === "validation-error");
  assert.throws(() => parseVerdict({ schema: "x" }), (e) => e.category === "schema-mismatch");
});
