"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const { evaluateDiff } = require(path.join(ROOT, "tools/oracle/diff_gate.js"));

// The hidden suite category-label catalog the Builder MAY see (labels only).
const LABELS = path.join(ROOT, ".oracle/hidden/labels.json");

test("hidden_isolation: Builder diff touching .oracle/hidden is rejected", () => {
  assert.equal(evaluateDiff({ paths: [".oracle/hidden/x.suite.js"] }, "builder").accepted, false);
});

test("hidden_isolation: label catalog exists and exposes labels only (no inputs/asserts)", () => {
  assert.ok(fs.existsSync(LABELS), "expected .oracle/hidden/labels.json (Designer-authored)");
  const cat = JSON.parse(fs.readFileSync(LABELS, "utf8"));
  assert.ok(Array.isArray(cat.labels));
  for (const l of cat.labels) {
    assert.equal(typeof l.id, "string");
    assert.equal(typeof l.label, "string");
    // labels must NOT carry inputs, expected values, or asserts
    for (const k of Object.keys(l)) {
      assert.ok(["id", "label", "category"].includes(k), "label carries forbidden field: " + k);
    }
  }
});

test("hidden_isolation: sandbox runner does not return hidden suite source on any channel", () => {
  // proven structurally by run_hidden discarding child stdio + verdict-only egress;
  // exercised end-to-end in sandbox_runner.test.js. Here assert the contract shape.
  const { runHidden } = require(path.join(ROOT, "tools/oracle/sandbox/run_hidden.js"));
  assert.equal(typeof runHidden, "function");
});
