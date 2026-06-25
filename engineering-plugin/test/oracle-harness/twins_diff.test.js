"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { differential } = require(path.join(__dirname, "..", "..", "tools/oracle/twins_diff.js"));

const BUILD = path.join(__dirname, "..", "..");

test("twins_diff: identical twins produce NO divergence (no false positives)", async () => {
  const r = await differential({ targetDir: BUILD, lineage_id: "TA" }, { targetDir: BUILD, lineage_id: "TB" }, { inputBudget: 20 });
  assert.equal(r.divergences.length, 0);
  assert.ok(r.comparisons > 0);
});

test("twins_diff: comparator is input-bounded", async () => {
  const r = await differential({ targetDir: BUILD }, { targetDir: BUILD }, { inputBudget: 9999, maxInputs: 5 });
  // 3 probes * 5 max inputs = 15 comparisons max
  assert.ok(r.comparisons <= 15);
});
