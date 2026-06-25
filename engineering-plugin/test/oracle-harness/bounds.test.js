"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { fuzzTarget } = require(path.join(__dirname, "..", "..", "tools/oracle/fuzz.js"));
const { differential } = require(path.join(__dirname, "..", "..", "tools/oracle/twins_diff.js"));
const { Budget } = require(path.join(__dirname, "..", "..", "tools/oracle/budget.js"));
const { runHidden } = require(path.join(__dirname, "..", "..", "tools/oracle/sandbox/run_hidden.js"));

const BUILD = path.join(__dirname, "..", "..");
const FIX = path.join(__dirname, "fixtures");

// SEC-BOUNDS — aggregate resource-bound regression suite (spec §8 bullet 5).

test("bounds: fuzz respects maxRuns under a huge requested run count", () => {
  let calls = 0;
  fuzzTarget(() => { calls++; }, (g) => g.int(0, 5), { runs: 10 ** 7, maxRuns: 50 });
  assert.ok(calls <= 50);
});

test("bounds: twin comparator respects the input budget", async () => {
  const r = await differential({ targetDir: BUILD }, { targetDir: BUILD }, { inputBudget: 10 ** 6, maxInputs: 4 });
  assert.ok(r.comparisons <= 4 * 3); // 3 probes
});

test("bounds: budget caps are honored (mutants)", () => {
  const b = new Budget({ max_mutants: 5 });
  b.spend("mutants", 5);
  assert.equal(b.capsSpent(), true);
});

test("bounds: sandbox runner kills a runaway hidden suite via timeout", () => {
  const start = Date.now();
  const v = runHidden({ hiddenDir: path.join(FIX, "runaway-hidden"), buildRoot: BUILD, timeoutMs: 1500 });
  assert.ok(Date.now() - start < 10000, "runaway must be killed within bound");
  assert.ok(v.counts.fail >= 1);
});
