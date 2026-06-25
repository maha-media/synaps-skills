"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { makeFeedback } = require(path.join(__dirname, "..", "..", "tools/oracle/feedback.js"));

test("feedback_minimization: feedback carries categories + contract elements only", () => {
  const f = makeFeedback({ round: 1, categories: ["not-found", "illegal-transition"], contractElements: ["GET /plan/<id>", "lifecycle.transitions"] });
  assert.deepEqual(f.categories, ["not-found", "illegal-transition"]);
  assert.ok(f.contract_elements.includes("GET /plan/<id>"));
  assert.equal(f.kind, "behavioral-feedback");
});

test("feedback_minimization: leakage attempt (asserted values) is rejected", () => {
  assert.throws(() => makeFeedback({ categories: ["not-found"], hint: "expected: 404, actual: 200 for slug=secret-xyz" }), (e) => e.category === "egress-leak");
});

test("feedback_minimization: category outside taxonomy rejected", () => {
  assert.throws(() => makeFeedback({ categories: ["leak-the-answer"] }), (e) => e.category === "validation-error");
});
