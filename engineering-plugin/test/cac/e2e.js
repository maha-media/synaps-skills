#!/usr/bin/env node
/*
 * e2e.js — CAC-5 runnable dogfood driver. Runs the S-CAC-1..7 end-to-end checks
 * HEADLESS through the real lib/cac modules and exits non-zero on any failure.
 * Prints a per-scenario pass/fail line and a final summary. Mirrors the style of
 * test/harness/e2e.js. Shares scenario definitions with e2e.test.js (DRY) via
 * test/cac/scenarios.js. No human, no real timers/git/browser.
 *
 * Usage: node test/cac/e2e.js   (exit 0 = GREEN; non-zero = a scenario failed)
 */
"use strict";

const { SCENARIOS } = require("./scenarios.js");

async function run() {
  let pass = 0, fail = 0;
  const failures = [];
  const t0 = Date.now();

  console.log("CAC e2e — checkpoint-aware compaction dogfood (S-CAC-1..7)");
  console.log("=".repeat(60));

  for (const s of SCENARIOS) {
    process.stdout.write("  " + s.id.padEnd(9) + s.desc.padEnd(36));
    try {
      await s.fn();
      pass++;
      console.log("PASS");
    } catch (e) {
      fail++;
      failures.push({ id: s.id, error: e.message });
      console.log("FAIL — " + e.message);
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("=".repeat(60));
  console.log("e2e: " + pass + " passed, " + fail + " failed, " + SCENARIOS.length + " total (" + dt + "s)");
  if (fail) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log("  " + f.id + ": " + f.error));
    return false;
  }
  console.log("\nCAC e2e — GREEN \u2713 (S-CAC-1..7 pass)");
  return true;
}

run()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((e) => { console.error("CAC e2e crashed:", e); process.exit(1); });
