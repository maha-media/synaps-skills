"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { decideDone } = require(path.join(__dirname, "..", "..", "tools/oracle/done.js"));

test("done_condition: adversary still finds a violation ⇒ NOT done (loop)", () => {
  const r = decideDone({ adversaryExhausted: false, score: 0.95, outstandingFinds: 2, threshold: 0.8 });
  assert.equal(r.state, "not-done");
});

test("done_condition: score >= threshold but adversary NOT exhausted ⇒ NOT done", () => {
  const r = decideDone({ adversaryExhausted: false, survivedCleanly: false, score: 0.95, outstandingFinds: 0, threshold: 0.8 });
  assert.equal(r.state, "not-done");
});

test("done_condition: exhausted + clean survival + score >= threshold ⇒ SHIP", () => {
  const r = decideDone({ adversaryExhausted: true, survivedCleanly: true, score: 0.9, outstandingFinds: 0, threshold: 0.8 });
  assert.equal(r.state, "ship");
});

test("done_condition: exhausted but score < threshold ⇒ NOT done", () => {
  const r = decideDone({ adversaryExhausted: true, survivedCleanly: true, score: 0.5, outstandingFinds: 0, threshold: 0.8 });
  assert.equal(r.state, "not-done");
});

test("done_condition: budget hit a hard cap mid-search (not clean) ⇒ NOT done", () => {
  const r = decideDone({ adversaryExhausted: true, survivedCleanly: false, score: 0.9, outstandingFinds: 0, threshold: 0.8 });
  assert.equal(r.state, "not-done");
});
