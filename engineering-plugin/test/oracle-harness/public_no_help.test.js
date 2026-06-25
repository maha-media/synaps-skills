"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { runSuites } = require(path.join(__dirname, "..", "..", "tools/oracle/suite_runner.js"));

const FIX = path.join(__dirname, "fixtures");
const synthFactory = (which) => () => require(path.join(FIX, "synthetic", which + ".js"));

test("public_no_help: overfit-to-public artifact PASSES public but FAILS hidden", async () => {
  const pub = await runSuites(path.join(FIX, "public-suite"), { sutFactory: synthFactory("overfit") });
  assert.equal(pub.verdict.counts.fail, 0, "overfit passes the public sample cases");

  const hid = await runSuites(path.join(FIX, "hidden-suite"), { sutFactory: synthFactory("overfit") });
  assert.ok(hid.verdict.counts.fail >= 1, "overfit must fail the held-out hidden cases");
  assert.ok(hid.verdict.categories.length >= 1);
});

test("public_no_help: genuinely-correct artifact passes BOTH public and hidden", async () => {
  const pub = await runSuites(path.join(FIX, "public-suite"), { sutFactory: synthFactory("correct") });
  const hid = await runSuites(path.join(FIX, "hidden-suite"), { sutFactory: synthFactory("correct") });
  assert.equal(pub.verdict.counts.fail, 0);
  assert.equal(hid.verdict.counts.fail, 0);
});
