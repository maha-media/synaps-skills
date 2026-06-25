#!/usr/bin/env node
/*
 * e2e.js — the merge gate (Addendum A.6 H-5). Runs ALL scenarios headless and
 * exits non-zero on any failure. For provable scenarios, also runs the --prove
 * red→green transition. No human, no real browser. Plan H-5/H-7.
 */
"use strict";
const { SCENARIOS } = require("./scenarios.js");

async function run() {
  const names = Object.keys(SCENARIOS);
  let pass = 0, fail = 0;
  const failures = [];
  const t0 = Date.now();
  for (const name of names) {
    const s = SCENARIOS[name];
    process.stdout.write("  " + name.padEnd(5) + s.desc.padEnd(28));
    try {
      // red→green proof for provable scenarios
      if (s.prove) {
        let red = false;
        try { await s.fn({ control: true }); } catch (_) { red = true; }
        if (!red) throw new Error("control did not fail (test has no teeth)");
      }
      await s.fn({ control: false });
      pass++;
      console.log(s.prove ? "PASS (red→green)" : "PASS");
    } catch (e) {
      fail++;
      failures.push({ name, error: e.message });
      console.log("FAIL — " + e.message);
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(60));
  console.log("e2e: " + pass + " passed, " + fail + " failed, " + names.length + " total (" + dt + "s)");
  if (fail) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log("  " + f.name + ": " + f.error));
  }
  return fail === 0;
}

run().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error("e2e crashed:", e); process.exit(1); });
