/*
 * budget.js — composite adversary budget + exhaustion (spec §9 #5). The
 * adversary is "exhausted" when its hard caps are spent AND it is stagnating
 * (N consecutive rounds with no new kill/crash/divergence/hidden-fail). Governed
 * by convergence-loop bounds. Node stdlib only.
 */
"use strict";

const DEFAULTS = {
  max_fuzz_inputs: 5000,
  max_mutants: 50,
  max_property_cases: 20000,
  max_wall_seconds: 600,
  stagnation_rounds: 2, // N rounds with no new find ⇒ exhausted
  max_total_rounds: 10, // hard convergence-loop ceiling
};

class Budget {
  constructor(opts) {
    this.limits = Object.assign({}, DEFAULTS, opts || {});
    this.spent = { fuzz_inputs: 0, mutants: 0, property_cases: 0, rounds: 0 };
    this.startedAt = Date.now();
    this.noFindStreak = 0;
    this.clock = (opts && opts.clock) || { nowMs: () => Date.now() };
  }

  spend(kind, n) { this.spent[kind] = (this.spent[kind] || 0) + (n || 1); }

  /** Record a round outcome. `finds` = number of new bugs the adversary caught. */
  recordRound(finds) {
    this.spent.rounds++;
    if (finds > 0) this.noFindStreak = 0; else this.noFindStreak++;
  }

  wallSeconds() { return (this.clock.nowMs() - this.startedAt) / 1000; }

  capsSpent() {
    return this.spent.fuzz_inputs >= this.limits.max_fuzz_inputs
      || this.spent.mutants >= this.limits.max_mutants
      || this.spent.property_cases >= this.limits.max_property_cases
      || this.wallSeconds() >= this.limits.max_wall_seconds;
  }

  /**
   * Exhausted = adversary cannot find more within budget:
   *  - stagnating (no new find for N rounds), OR
   *  - a hard cap is hit, OR
   *  - the round ceiling is reached.
   * Exhaustion is only "clean" (eligible to SHIP) when stagnating with no
   * outstanding finds — that is the survived-budget signal.
   */
  isExhausted() {
    if (this.spent.rounds >= this.limits.max_total_rounds) return true;
    if (this.noFindStreak >= this.limits.stagnation_rounds) return true;
    if (this.capsSpent()) return true;
    return false;
  }

  /** Clean survival: stagnated (adversary gave up) rather than hit a wall mid-search. */
  survivedCleanly() {
    return this.noFindStreak >= this.limits.stagnation_rounds && this.spent.rounds >= this.limits.stagnation_rounds;
  }

  snapshot() {
    return { limits: this.limits, spent: Object.assign({}, this.spent), noFindStreak: this.noFindStreak, wallSeconds: this.wallSeconds(), exhausted: this.isExhausted(), survivedCleanly: this.survivedCleanly() };
  }
}

module.exports = { Budget, DEFAULTS };
