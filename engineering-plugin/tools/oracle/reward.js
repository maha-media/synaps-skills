/*
 * reward.js — Designer/adversary reward function (spec §3 rule 3, §9 #7).
 * Reward = weighted sum of bugs CAUGHT: mutant kills + fuzz crashes + hidden
 * failures provoked + twin divergences surfaced. It NEVER rewards the Builder
 * passing — collusion is irrational. Feeds the Judge as the adversary-strength
 * signal. Node stdlib only.
 */
"use strict";

const WEIGHTS = {
  mutant_kills: 1.0,
  fuzz_crashes: 2.0,
  hidden_failures_provoked: 1.5,
  twin_divergences: 1.5,
};

function computeReward(signals, weights) {
  signals = signals || {};
  const w = Object.assign({}, WEIGHTS, weights || {});
  let total = 0;
  for (const k of Object.keys(w)) total += (signals[k] || 0) * w[k];
  // The Builder passing contributes ZERO — there is no term for it.
  return { reward: total, weights: w, signals: Object.assign({}, signals) };
}

/**
 * Adversary strength in [0,1]: a normalized view of how much the adversary is
 * still finding. 0 = found nothing this round (Builder strong), >0 = found bugs.
 */
function adversaryStrength(signals, scale) {
  const r = computeReward(signals).reward;
  const s = scale || 5;
  return Math.min(1, r / s);
}

module.exports = { computeReward, adversaryStrength, WEIGHTS };
