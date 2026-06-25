"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { judge } = require(path.join(__dirname, "..", "..", "tools/oracle/judge.js"));
const { makeVerdict } = require(path.join(__dirname, "..", "..", "tools/oracle/verdict.js"));

test("judge: produces a score + behavioral feedback from verdicts + adversary signal", () => {
  const v = makeVerdict({ pass: 9, fail: 1, categories: ["not-found"] });
  const r = judge({ mode: "holdout", verdicts: [v], adversarySignals: { mutant_kills: 1 }, round: 1 });
  assert.ok(r.score >= 0 && r.score <= 1);
  assert.equal(r.feedback.kind, "behavioral-feedback");
  assert.ok(r.feedback.categories.includes("not-found"));
});

test("judge: holdout mode must NOT receive Builder code", () => {
  assert.throws(() => judge({ mode: "holdout", verdicts: [], codeRef: "lib/store.js" }), (e) => e.category === "lineage-violation");
});

test("judge: a strong build with an exhausted adversary scores high", () => {
  const v = makeVerdict({ pass: 50, fail: 0, categories: [] });
  const r = judge({ mode: "holdout", verdicts: [v], adversarySignals: {} });
  assert.ok(r.score >= 0.8, "clean pass + no finds ⇒ high score, got " + r.score);
});

test("judge: an effective adversary drags the score down", () => {
  const v = makeVerdict({ pass: 50, fail: 0, categories: [] });
  const weak = judge({ mode: "holdout", verdicts: [v], adversarySignals: { fuzz_crashes: 3 } });
  assert.ok(weak.score < 0.8, "still-finding adversary lowers score, got " + weak.score);
});

test("judge: feedback never leaks (behavior-only)", () => {
  const v = makeVerdict({ pass: 1, fail: 1, categories: ["crash"] });
  const r = judge({ mode: "holdout", verdicts: [v], adversarySignals: {} });
  assert.ok(!/assert|expect|module\.exports/.test(JSON.stringify(r.feedback)));
});
