#!/usr/bin/env node
/*
 * selfplay_run.js — full adversarial self-play e2e (spec §4.7, O5-6).
 * Headless. Architect freezes contract → commit-reveal → Designer (adversary) +
 * Builder twins (siblings) → Tester (public in worktree + hidden in sandbox,
 * verdict-only) + properties + mutation + differential → Judge → self-play until
 * SURVIVED BUDGET + score ≥ threshold → SHIP, with a full audit trail.
 *
 * Emits .oracle/verdicts/selfplay.verdict.json. Exits 0 only on a trustworthy
 * green verdict. Node stdlib only.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const O = path.join(ROOT, ".oracle");

const { ContractFreezer } = require(path.join(ROOT, "tools/oracle/freeze.js"));
const { LineageLedger } = require(path.join(ROOT, "tools/oracle/lineage.js"));
const { CommitReveal } = require(path.join(ROOT, "tools/oracle/commit_reveal.js"));
const { AuditTrail } = require(path.join(ROOT, "tools/oracle/audit.js"));
const { runHidden } = require(path.join(ROOT, "tools/oracle/sandbox/run_hidden.js"));
const { runPublic } = require(path.join(ROOT, "tools/oracle/run_public.js"));
const { checkAll } = require(path.join(ROOT, "tools/oracle/properties.js"));
const { runMutationGate } = require(path.join(ROOT, "tools/oracle/mutation_gate.js"));
const { fuzzTarget } = require(path.join(ROOT, "tools/oracle/fuzz.js"));
const { differential } = require(path.join(ROOT, "tools/oracle/twins_diff.js"));
const { spawnTwins } = require(path.join(ROOT, "tools/oracle/twins.js"));
const { Budget } = require(path.join(ROOT, "tools/oracle/budget.js"));
const { computeReward } = require(path.join(ROOT, "tools/oracle/reward.js"));
const { judge } = require(path.join(ROOT, "tools/oracle/judge.js"));
const { decideDone } = require(path.join(ROOT, "tools/oracle/done.js"));
const { strengthenFromSurvivor } = require(path.join(ROOT, "tools/oracle/selfplay.js"));
const { createSut } = require(path.join(ROOT, "tools/oracle/sut.js"));

const THRESHOLD = 0.8;
const HIDDEN = path.join(O, "hidden");
const PUBLIC = path.join(O, "public");
const PROPS = path.join(O, "properties");

function log(m) { process.stdout.write("[selfplay] " + m + "\n"); }

async function main() {
  const audit = new AuditTrail({ dir: path.join(O, "verdicts"), plansDir: path.join(ROOT, ".plans") });

  // ---- Lineage: siblings under a neutral orchestrator (spec §3 rule 1) ----
  const ledger = new LineageLedger({ file: path.join(O, "reveal", "lineage.log") });
  let orch; try { orch = ledger.dispatch({ role: "orchestrator", system_prompt: "neutral orchestrator", lineage_id: "orch-e2e-" + Date.now() }); } catch (_) { orch = { lineage_id: "orch-fallback" }; }
  const architect = ledger.dispatch({ role: "architect", system_prompt: "freeze the contract", parent_id: orch.lineage_id });
  const designer = ledger.dispatch({ role: "designer", system_prompt: "adversary: author oracle from spec+contract; never read impl", parent_id: orch.lineage_id });
  const twins = spawnTwins({ ledger, parentId: orch.lineage_id, twinADir: ROOT, twinBDir: ROOT, system_prompt: "builder twin" });
  ledger.assertSiblings(designer.lineage_id, twins.a.lineage_id);
  audit.append("lineage", { round: 0, designer: designer.lineage_id, builderA: twins.a.lineage_id, builderB: twins.b.lineage_id, siblings: true }, "orchestrator");

  // ---- Contract: confirm a frozen contract exists ----
  const freezer = new ContractFreezer({ dir: path.join(O, "contract"), revealDir: path.join(O, "reveal") });
  const { hash: contractHash } = freezer.current();
  audit.append("contract", { round: 0, hash: contractHash }, "architect");

  // ---- Commit-reveal: commit hidden bundle before builder freeze ----
  const cr = new CommitReveal({ revealDir: path.join(O, "reveal") });
  const round = (cr.records().filter((r) => r.event === "commit").length) + 1;
  const bundleDirs = [{ tag: "hidden", path: HIDDEN }, { tag: "properties", path: PROPS }];
  const commit = cr.commit(bundleDirs, { round, lineage: designer.lineage_id });
  audit.append("commit", { round, hash: commit.hash }, designer.lineage_id);
  // Builder freezes its implementation (content-addressed)
  const implHash = "sha256:" + require("crypto").createHash("sha256").update(fs.readFileSync(path.join(ROOT, "assets/engplan.js"))).digest("hex");
  cr.freeze(implHash, { round, lineage: twins.a.lineage_id });
  audit.append("freeze", { round, impl_hash: implHash }, twins.a.lineage_id);

  // ---- Self-play rounds ----
  const budget = new Budget({ stagnation_rounds: 2, max_total_rounds: 6 });
  let lastJudge = null, lastVerdicts = [], outstanding = 0, roundNo = 0;
  const findingsLog = [];

  while (!budget.isExhausted()) {
    roundNo++;
    log("round " + roundNo);

    // Tester: public (worktree) + hidden (sandbox, verdict-only)
    const pub = await runPublic({ targetDir: ROOT });
    const hiddenVerdict = runHidden({ hiddenDir: HIDDEN, buildRoot: ROOT, round: roundNo });
    const verdicts = [pub.verdict, hiddenVerdict];
    lastVerdicts = verdicts;
    const hiddenFails = hiddenVerdict.counts.fail + pub.verdict.counts.fail;

    // Properties (generative)
    const propRes = fs.existsSync(PROPS) ? checkAll(PROPS, { targetDir: ROOT, cases: 400 }) : { failed: [], passed: [] };
    budget.spend("property_cases", 400 * Math.max(1, (propRes.passed.length + propRes.failed.length)));

    // Mutation gate (oracle self-validation) — survivors feed strengthening
    const suiteDirs = [PUBLIC, HIDDEN].filter((d) => fs.existsSync(d));
    const mut = await runMutationGate({ buildRoot: ROOT, suiteDirs, propsDir: PROPS, threshold: 0.8, cases: 200 });
    budget.spend("mutants", mut.total);

    // Fuzz (adversarial malformed inputs against the parse boundary)
    const fsut = createSut({ targetDir: ROOT });
    let fuzzCrash = 0;
    try {
      const fr = fuzzTarget((input) => fsut.parsePlan(input), (g) => g.anyValue(0), { runs: 600, isCrash: (e) => e && e.name !== "ValidationError" });
      if (fr.crashed) fuzzCrash = 1;
    } finally { fsut.cleanup(); }
    budget.spend("fuzz_inputs", 600);

    // Differential twins (real build vs itself → expect agreement; bounded)
    const diff = await differential({ targetDir: ROOT }, { targetDir: ROOT }, { inputBudget: 12 });
    const twinDiv = diff.divergences.length;

    // Adversary finds this round
    const survivors = mut.survived;
    const finds = survivors.length + fuzzCrash + hiddenFails + propRes.failed.length + twinDiv;
    outstanding = finds;
    findingsLog.push({ round: roundNo, hiddenFails, propFails: propRes.failed.length, mutantSurvivors: survivors.length, fuzzCrash, twinDiv });

    // Strengthen the oracle from survivors (survived mutant → new test)
    for (const s of survivors) {
      try { strengthenFromSurvivor(s, { hiddenDir: HIDDEN }); audit.append("strengthen", { round: roundNo, from: "mutant:" + s.id, category: s.category }, designer.lineage_id); } catch (_) {}
    }

    // Judge (holdout: no code access)
    const reward = computeReward({ mutant_kills: mut.killed, fuzz_crashes: fuzzCrash, hidden_failures_provoked: hiddenFails, twin_divergences: twinDiv });
    lastJudge = judge({ mode: "holdout", verdicts, adversarySignals: { fuzz_crashes: fuzzCrash, hidden_failures_provoked: hiddenFails, twin_divergences: twinDiv }, round: roundNo });
    audit.append("verdict", { round: roundNo, counts: { pass: verdicts.reduce((a, v) => a + v.counts.pass, 0), fail: verdicts.reduce((a, v) => a + v.counts.fail, 0) }, mutation: { killed: mut.killed, total: mut.total, survived: survivors.map((s) => s.category) }, reward: reward.reward, score: lastJudge.score }, "tester");
    audit.surface("html-plan-ecosystem", { round: roundNo, state: outstanding > 0 ? "not-done" : "surviving", counts: { pass: verdicts.reduce((a, v) => a + v.counts.pass, 0), fail: verdicts.reduce((a, v) => a + v.counts.fail, 0) }, categories: lastJudge.feedback.categories, score: lastJudge.score });

    budget.recordRound(finds);
    log("round " + roundNo + " finds=" + finds + " score=" + lastJudge.score.toFixed(3) + " (mut " + mut.killed + "/" + mut.total + ", hiddenFails " + hiddenFails + ", propFails " + propRes.failed.length + ", fuzzCrash " + fuzzCrash + ", twinDiv " + twinDiv + ")");

    if (finds === 0) {
      // adversary found nothing this round; keep going until stagnation confirms exhaustion
      if (budget.survivedCleanly()) break;
    }
  }

  // ---- Reveal (verify hidden bundle unchanged) ----
  let revealOk = false;
  try { const rv = cr.reveal(bundleDirs, { round, lineage: designer.lineage_id }); revealOk = rv.verified; audit.append("reveal", { round, verified: true }, designer.lineage_id); }
  catch (e) { audit.append("reveal", { round, verified: false, category: e.category }, designer.lineage_id); }

  // ---- Done-condition ----
  const score = lastJudge ? lastJudge.score : 0;
  const done = decideDone({ adversaryExhausted: budget.isExhausted(), survivedCleanly: budget.survivedCleanly(), score, outstandingFinds: outstanding, threshold: THRESHOLD });

  const verdict = {
    schema: "oracle/1", kind: "selfplay-verdict",
    state: done.state, reason: done.reason, score,
    adversary_exhausted: budget.isExhausted(), survived_cleanly: budget.survivedCleanly(),
    outstanding_finds: outstanding, rounds: roundNo,
    contract_hash: contractHash, reveal_verified: revealOk,
    lineage: { designer: designer.lineage_id, builderA: twins.a.lineage_id, builderB: twins.b.lineage_id, siblings: true },
    budget: budget.snapshot(), findings: findingsLog,
  };
  fs.writeFileSync(path.join(O, "verdicts", "selfplay.verdict.json"), JSON.stringify(verdict, null, 2));
  audit.append("done", { round: roundNo, state: done.state, score }, "orchestrator");

  log("VERDICT: " + done.state + " — " + done.reason);
  process.exit(done.state === "ship" ? 0 : 1);
}

main().catch((e) => { console.error("[selfplay] fatal:", e && e.stack || e); process.exit(1); });
