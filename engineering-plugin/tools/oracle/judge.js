/*
 * judge.js — the Judge (spec §3, §5). Consumes contract + verdicts (+ code only
 * in `informed` mode) and produces a SCORE + structured behavioral feedback. In
 * `holdout` mode the Judge has NO access to Builder code (asserted). Feedback is
 * behavior-only (reuses feedback.js minimization). Node stdlib only.
 */
"use strict";
const { makeFeedback } = require("./feedback.js");
const { adversaryStrength } = require("./reward.js");

function err(category, message) { const e = new Error(message); e.category = category; return e; }

/**
 * @param {object} input {
 *   mode: "holdout"|"informed",
 *   verdicts: [oracle/1 verdict],            // public + hidden
 *   adversarySignals: { mutant_kills, fuzz_crashes, hidden_failures_provoked, twin_divergences },
 *   round, codeRef? (only allowed in informed mode)
 * }
 * Returns { score, feedback, mode, breakdown }
 */
function judge(input) {
  input = input || {};
  const mode = input.mode || "holdout";
  if (mode === "holdout" && input.codeRef) throw err("lineage-violation", "holdout Judge must not receive Builder code");

  const verdicts = input.verdicts || [];
  let pass = 0, fail = 0;
  const cats = {};
  for (const v of verdicts) {
    pass += v.counts.pass; fail += v.counts.fail;
    for (const c of v.categories) { const code = typeof c === "string" ? c : c.category; cats[code] = (cats[code] || 0) + (c.count || 1); }
  }
  const total = pass + fail;
  const conformance = total === 0 ? 1 : pass / total;          // how much passed
  const strength = adversaryStrength(input.adversarySignals);  // how much adversary still finds
  // Score rewards conformance and is dragged down by a still-effective adversary.
  const score = Math.max(0, Math.min(1, conformance * (1 - strength)));

  const feedback = makeFeedback({
    round: input.round || 0,
    categories: Object.keys(cats),
    contractElements: input.contractElements || [],
    hint: fail > 0 ? ("address " + Object.keys(cats).join(", ")) : undefined,
  });

  return { mode, score, feedback, breakdown: { pass, fail, conformance, adversaryStrength: strength, categories: cats } };
}

module.exports = { judge };
