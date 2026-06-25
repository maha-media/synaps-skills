/*
 * feedback.js — behavioral-feedback channel (spec §5 note, §8). Fix-loop
 * feedback to the Builder describes BEHAVIOR GAPS only: failure categories +
 * which contract element failed — NEVER test internals, inputs, or asserted
 * values. Reuses the verdict egress validator for leak prevention. Routed
 * through the Plan Inbox. Node stdlib only.
 */
"use strict";
const { looksLikeLeak } = require("./verdict.js");
const { CATEGORY_TAXONOMY } = require("./verdict.js");

function err(category, message) { const e = new Error(message); e.category = category; return e; }

/**
 * Build a behavioral-feedback message for the Builder.
 * @param {object} opts { round, categories:[code], contractElements:[string], hint? }
 * `contractElements` are names from the frozen contract (endpoints/exit codes/
 * lifecycle), e.g. "GET /plan/<id>", "exit_codes.2". `hint` is an optional
 * category-level prose string (validated for leaks).
 */
function makeFeedback(opts) {
  opts = opts || {};
  const categories = (opts.categories || []).map((c) => (typeof c === "string" ? c : c.category));
  for (const c of categories) {
    if (!CATEGORY_TAXONOMY.includes(c)) throw err("validation-error", "feedback category not in taxonomy: " + c);
  }
  const msg = {
    kind: "behavioral-feedback",
    round: opts.round != null ? opts.round : 0,
    categories,
    contract_elements: (opts.contractElements || []).map(String),
    hint: typeof opts.hint === "string" ? opts.hint : undefined,
  };
  // Hard leak gate: feedback must not embed asserted values / test source.
  if (looksLikeLeak(msg)) throw err("egress-leak", "feedback would leak hidden test source or asserted values");
  return msg;
}

module.exports = { makeFeedback };
