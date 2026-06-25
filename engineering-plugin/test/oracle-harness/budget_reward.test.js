"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { Budget } = require(path.join(__dirname, "..", "..", "tools/oracle/budget.js"));
const { computeReward, adversaryStrength } = require(path.join(__dirname, "..", "..", "tools/oracle/reward.js"));

test("budget: exhaustion is computable via hard caps", () => {
  const b = new Budget({ max_mutants: 3, stagnation_rounds: 99, max_total_rounds: 99 });
  b.spend("mutants", 3);
  assert.equal(b.capsSpent(), true);
  assert.equal(b.isExhausted(), true);
});

test("budget: stagnation (N rounds no find) ⇒ clean survival", () => {
  const b = new Budget({ stagnation_rounds: 2, max_total_rounds: 99 });
  b.recordRound(1); // found something
  assert.equal(b.survivedCleanly(), false);
  b.recordRound(0); b.recordRound(0); // two empty rounds
  assert.equal(b.isExhausted(), true);
  assert.equal(b.survivedCleanly(), true);
});

test("reward: increases only with bugs caught; Builder passing scores zero", () => {
  const none = computeReward({}).reward;
  assert.equal(none, 0, "no finds ⇒ zero reward (Builder passing earns nothing)");
  const some = computeReward({ mutant_kills: 2, fuzz_crashes: 1 }).reward;
  assert.ok(some > 0);
  // there is literally no signal term for 'builder_passed'
  const tryCollude = computeReward({ builder_passed: 100 }).reward;
  assert.equal(tryCollude, 0, "collusion (rewarding builder passing) is impossible");
});

test("reward: adversary strength normalizes finds to [0,1]", () => {
  assert.equal(adversaryStrength({}), 0);
  assert.ok(adversaryStrength({ fuzz_crashes: 10 }) === 1);
});
