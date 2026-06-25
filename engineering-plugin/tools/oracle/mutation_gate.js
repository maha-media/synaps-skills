/*
 * mutation_gate.js — oracle self-validation (spec §4.4, §1.2). [ORACLE SELF-VALIDATION]
 * Runs the grading suite (public + hidden + properties) against each viable
 * mutant. A mutant is KILLED if the suite fails on it (it detected the fault).
 * Requires kill-rate >= threshold; a suite that fails to kill planted bugs is
 * REJECTED before it is trusted ("who tests the tester"). Survivors are recorded
 * as audit items and feed O5 self-play. Orchestrator infra. Stdlib only.
 */
"use strict";
const fs = require("node:fs");
const { viableOperators, makeMutant } = require("./mutate.js");
const { runSuites } = require("./suite_runner.js");
const { checkAll } = require("./properties.js");

/**
 * Does the grading suite detect a fault in `targetDir` (i.e. report any failure)?
 * Aggregates suite dirs + property dir. Returns true if any failure surfaced.
 */
async function suiteDetectsFault(targetDir, opts) {
  opts = opts || {};
  let failures = 0;
  for (const dir of opts.suiteDirs || []) {
    if (!fs.existsSync(dir)) continue;
    const { verdict } = await runSuites(dir, { targetDir, sutFactory: opts.sutFactory });
    failures += verdict.counts.fail;
  }
  if (opts.propsDir && fs.existsSync(opts.propsDir)) {
    const pr = checkAll(opts.propsDir, { targetDir, sutFactory: opts.sutFactory, cases: opts.cases || 300 });
    failures += pr.failed.length;
  }
  return failures > 0;
}

/**
 * Run the mutation gate. Returns a report:
 *   { total, killed, survived[], killRate, accepted, threshold }
 * survived[] carries category + operator id only (no source).
 */
async function runMutationGate(opts) {
  opts = opts || {};
  const threshold = opts.threshold != null ? opts.threshold : 0.8;
  const buildRoot = opts.buildRoot;
  const ops = (opts.operators || viableOperators(buildRoot));
  const survived = [];
  const excluded = [];
  let killed = 0, total = 0;
  for (const op of ops) {
    // Proven-equivalent mutants are unkillable by construction and indict nothing
    // about the suite; exclude from the kill-rate denominator (record for audit).
    if (op.equivalent) { excluded.push({ id: op.id, category: op.category, reason: op.equivalent_reason || "equivalent mutant" }); continue; }
    const m = makeMutant(op, { buildRoot });
    if (!m.applied) { try { fs.rmSync(m.dir, { recursive: true, force: true }); } catch (_) {} continue; }
    total++;
    let detected = false;
    try { detected = await suiteDetectsFault(m.dir, opts); }
    catch (_) { detected = true; /* a crash on the mutant counts as a kill */ }
    finally { try { fs.rmSync(m.dir, { recursive: true, force: true }); } catch (_) {} }
    if (detected) killed++;
    else survived.push({ id: op.id, category: op.category });
  }
  const killRate = total === 0 ? 0 : killed / total;
  return { total, killed, survived, excluded, killRate, accepted: total > 0 && killRate >= threshold, threshold };
}

module.exports = { runMutationGate, suiteDetectsFault };
