/*
 * done.js — "survived budget" done-condition (spec §4.7, §1.2, §11). [DONE CONDITION]
 * Done = the adversary EXHAUSTED its budget (cleanly survived) AND score ≥
 * threshold — NOT "a fixed list passed." Node stdlib only.
 */
"use strict";

/**
 * @param {object} input { adversaryExhausted, survivedCleanly, score, threshold, outstandingFinds }
 * Returns { state: "ship"|"not-done", reason }
 */
function decideDone(input) {
  input = input || {};
  const threshold = input.threshold != null ? input.threshold : 0.8;
  const score = input.score || 0;
  const exhausted = !!input.adversaryExhausted;
  const survivedCleanly = input.survivedCleanly !== false; // default true unless told otherwise
  const outstanding = input.outstandingFinds || 0;

  if (outstanding > 0) return { state: "not-done", reason: "adversary still finds contract violations" };
  if (!exhausted) return { state: "not-done", reason: "adversary budget not exhausted (keep searching)" };
  if (!survivedCleanly) return { state: "not-done", reason: "budget hit a hard cap mid-search, not a clean survival" };
  if (score < threshold) return { state: "not-done", reason: "score " + score.toFixed(3) + " < threshold " + threshold };
  return { state: "ship", reason: "adversary exhausted within budget AND score " + score.toFixed(3) + " >= " + threshold };
}

module.exports = { decideDone };
