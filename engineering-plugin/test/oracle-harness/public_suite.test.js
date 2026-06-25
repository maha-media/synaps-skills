"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { runSuites } = require(path.join(__dirname, "..", "..", "tools/oracle/suite_runner.js"));
const { evaluateDiff } = require(path.join(__dirname, "..", "..", "tools/oracle/diff_gate.js"));

const FIX = path.join(__dirname, "fixtures");
const synthFactory = (which) => () => require(path.join(FIX, "synthetic", which + ".js"));

test("public_suite: executes in the worktree and yields pass/fail", async () => {
  const { verdict } = await runSuites(path.join(FIX, "public-suite"), { sutFactory: synthFactory("correct") });
  assert.equal(verdict.counts.fail, 0);
  assert.equal(verdict.counts.pass, 1);
});

test("public_suite: Builder may READ public but a diff editing it is REJECTED", () => {
  // public suite lives under .oracle/public — protected from Builder writes
  const r = evaluateDiff({ paths: [".oracle/public/add.suite.js"] }, "builder");
  assert.equal(r.accepted, false);
  assert.equal(r.category, "write-segregation");
});
