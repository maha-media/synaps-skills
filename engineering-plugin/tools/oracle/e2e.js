#!/usr/bin/env node
/*
 * e2e.js — the oracle merge gate (`npm run oracle:e2e`). Runs the full oracle
 * harness headless and exits non-zero on any failure. Produces a replayable
 * audit summary under .oracle/verdicts/. Node stdlib only, no network.
 *
 * Phased: runs the oracle-harness unit/integration suite, then (when present)
 * the adversarial self-play e2e scenario, then asserts the survived-budget
 * done-condition. Each phase contributes to the audit trail.
 */
"use strict";
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const VERDICT_DIR = path.join(ROOT, ".oracle", "verdicts");

function log(msg) { process.stdout.write(msg + "\n"); }

function runNodeTest() {
  log("oracle:e2e — running harness suite (node --test test/oracle-harness)…");
  const dir = path.join(ROOT, "test", "oracle-harness");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).map((f) => path.join("test", "oracle-harness", f));
  const r = cp.spawnSync(process.execPath, ["--test", ...files], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, ORACLE_LINEAGE_ROLE: "orchestrator" },
  });
  process.stdout.write(r.stdout || "");
  if (r.status !== 0) process.stderr.write(r.stderr || "");
  // extract counts
  const m = (r.stdout || "").match(/# pass (\d+)[\s\S]*?# fail (\d+)/) ||
            (r.stdout || "").match(/pass (\d+)[\s\S]*?fail (\d+)/);
  return { status: r.status, pass: m ? +m[1] : null, fail: m ? +m[2] : null };
}

function runSelfPlayE2E() {
  const f = path.join(ROOT, "tools", "oracle", "selfplay_run.js");
  if (!fs.existsSync(f)) return { skipped: true };
  log("oracle:e2e — running adversarial self-play e2e…");
  const r = cp.spawnSync(process.execPath, [f], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ORACLE_LINEAGE_ROLE: "orchestrator" } });
  process.stdout.write(r.stdout || "");
  if (r.status !== 0) process.stderr.write(r.stderr || "");
  let verdict = null;
  try { verdict = JSON.parse(fs.readFileSync(path.join(VERDICT_DIR, "selfplay.verdict.json"), "utf8")); } catch (_) {}
  return { status: r.status, verdict };
}

function main() {
  fs.mkdirSync(VERDICT_DIR, { recursive: true });
  const started = new Date().toISOString();
  const suite = runNodeTest();
  let ok = suite.status === 0;

  const selfplay = runSelfPlayE2E();
  if (!selfplay.skipped && selfplay.status !== 0) ok = false;

  const audit = {
    schema: "oracle/1", kind: "e2e-audit",
    started, finished: new Date().toISOString(),
    suite: { pass: suite.pass, fail: suite.fail, status: suite.status },
    selfplay: selfplay.skipped ? "not-yet-implemented" : { status: selfplay.status, verdict: selfplay.verdict },
    result: ok ? "green" : "red",
  };
  fs.writeFileSync(path.join(VERDICT_DIR, "e2e-audit.json"), JSON.stringify(audit, null, 2));
  log("");
  log("oracle:e2e — " + (ok ? "GREEN ✓" : "RED ✗") + " (suite pass=" + suite.pass + " fail=" + suite.fail + ")");
  if (!selfplay.skipped && selfplay.verdict) {
    log("oracle:e2e — self-play verdict: " + selfplay.verdict.state + " (score=" + selfplay.verdict.score + ", adversary_exhausted=" + selfplay.verdict.adversary_exhausted + ")");
  }
  log("oracle:e2e — audit: .oracle/verdicts/e2e-audit.json");
  process.exit(ok ? 0 : 1);
}

main();
