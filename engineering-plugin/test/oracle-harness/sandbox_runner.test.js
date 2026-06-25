"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { runHidden } = require(path.join(__dirname, "..", "..", "tools/oracle/sandbox/run_hidden.js"));
const { parseVerdict } = require(path.join(__dirname, "..", "..", "tools/oracle/verdict.js"));

const BUILD = path.join(__dirname, "..", "..");
const FIX = path.join(__dirname, "fixtures");

test("sandbox_runner: runs hidden suite against build artifact, returns verdict-only", () => {
  const v = runHidden({ hiddenDir: path.join(FIX, "real-hidden"), buildRoot: BUILD, timeoutMs: 15000 });
  const parsed = parseVerdict(v); // must satisfy egress contract
  assert.equal(parsed.counts.fail, 0);
  assert.equal(parsed.counts.pass, 1);
  // only verdict keys present (no source/inputs)
  for (const k of Object.keys(parsed)) {
    assert.ok(["schema", "kind", "round", "counts", "categories", "audit_id", "nonce", "lineage", "ts", "adversary"].includes(k));
  }
});

test("sandbox_runner: malicious hidden suite cannot leak source on stdout/stderr", () => {
  // The runner discards child stdio; only the validated verdict egresses.
  const v = runHidden({ hiddenDir: path.join(FIX, "leaky-hidden"), buildRoot: BUILD, timeoutMs: 15000 });
  const parsed = parseVerdict(v);
  const serialized = JSON.stringify(parsed);
  assert.ok(!/secret-asserted-value/.test(serialized), "no leaked asserted value in verdict");
  assert.ok(!/it\(/.test(serialized), "no leaked test source in verdict");
});

test("sandbox_runner: runaway hidden test is killed by the timeout (bounded)", () => {
  const start = Date.now();
  const v = runHidden({ hiddenDir: path.join(FIX, "runaway-hidden"), buildRoot: BUILD, timeoutMs: 2000 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 12000, "runner must kill runaway within bound, took " + elapsed + "ms");
  const parsed = parseVerdict(v);
  assert.ok(parsed.counts.fail >= 1);
});
