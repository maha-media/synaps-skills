#!/usr/bin/env node
/*
 * cli.js — run any scenario by name; --list; --prove (red→green). Plan H-0/H-5.
 *   node test/harness/cli.js --list
 *   node test/harness/cli.js S1
 *   node test/harness/cli.js --prove S1
 */
"use strict";
const { SCENARIOS } = require("./scenarios.js");

async function runOne(name) {
  const s = SCENARIOS[name];
  if (!s) throw new Error("unknown scenario: " + name);
  await s.fn({ control: false });
}

// red→green proof: control run must FAIL, real run must PASS.
async function prove(name) {
  const s = SCENARIOS[name];
  if (!s) throw new Error("unknown scenario: " + name);
  let red = false;
  try { await s.fn({ control: true }); } catch (_) { red = true; }
  if (!red) throw new Error(name + ": control (feature-disabled) did NOT fail — test has no teeth");
  await s.fn({ control: false }); // green
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list") || args.length === 0) {
    for (const k of Object.keys(SCENARIOS)) {
      console.log(k.padEnd(5), SCENARIOS[k].prove ? "[prove]" : "       ", SCENARIOS[k].desc);
    }
    return;
  }
  const doProve = args.includes("--prove");
  const names = args.filter((a) => !a.startsWith("--"));
  for (const name of names) {
    if (doProve) { await prove(name); console.log("PROVE OK", name, "(red→green)"); }
    else { await runOne(name); console.log("OK", name); }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
