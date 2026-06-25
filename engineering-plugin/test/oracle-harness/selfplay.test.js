"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { strengthenFromSurvivor, strengthenFromCrash, detectRegression } = require(path.join(__dirname, "..", "..", "tools/oracle/selfplay.js"));
const { runSuites } = require(path.join(__dirname, "..", "..", "tools/oracle/suite_runner.js"));
const { makeMutant, OPERATORS } = require(path.join(__dirname, "..", "..", "tools/oracle/mutate.js"));

const BUILD = path.join(__dirname, "..", "..");
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "oracle-sp-")); }

test("selfplay: a surviving mutant becomes a new permanent test that KILLS it", async () => {
  const hiddenDir = tmp();
  // a survivor for the 'not-found' category (status-404-to-200 operator)
  const gen = strengthenFromSurvivor({ id: "status-404-to-200", category: "not-found" }, { hiddenDir });
  assert.ok(fs.existsSync(gen.file));
  // the new test passes on the correct build...
  const ok = await runSuites(hiddenDir, { targetDir: BUILD });
  assert.equal(ok.verdict.counts.fail, 0);
  // ...and FAILS on the mutant it was born from (i.e. it now kills it)
  const op = OPERATORS.find((o) => o.id === "status-404-to-200");
  const m = makeMutant(op, { buildRoot: BUILD });
  try {
    const killed = await runSuites(hiddenDir, { targetDir: m.dir });
    assert.ok(killed.verdict.counts.fail >= 1, "strengthened test must kill its mutant");
  } finally { fs.rmSync(m.dir, { recursive: true, force: true }); }
});

test("selfplay: a fuzz crash becomes a new property", () => {
  const propsDir = tmp();
  const g = strengthenFromCrash({ id: "weird-input", category: "crash" }, { propsDir });
  assert.ok(fs.existsSync(g.file));
  assert.ok(/\.prop\.js$/.test(g.file));
});

test("selfplay: a regression of a previously-guarded case re-opens the round", () => {
  const guarded = ["regress-status-404-to-200"];
  const reopened = detectRegression(guarded, [{ id: "status-404-to-200", category: "not-found" }]);
  assert.equal(reopened.length, 1, "regressed guard must re-open the round");
  const clean = detectRegression(guarded, [{ id: "some-new-op", category: "crash" }]);
  assert.equal(clean.length, 0);
});
