"use strict";
// PROPERTY — canTransition(from,to) is true ONLY for pairs in the contract
// lifecycle transition table. Random (from,to) drawn from the status enum.
const TABLE = {
  open: ["acknowledged", "blocked"],
  acknowledged: ["incorporated", "rejected", "deferred", "blocked"],
  blocked: ["acknowledged", "incorporated", "rejected", "deferred"],
  incorporated: [],
  rejected: [],
  deferred: [],
};
const STATUSES = Object.keys(TABLE);
module.exports = {
  id: "canTransition-matches-contract-table",
  label: "canTransition is true only for contract transition pairs",
  category: "illegal-transition",
  gen(g) { return { from: g.pick(STATUSES), to: g.pick(STATUSES) }; },
  holds(sut, input) {
    const expected = TABLE[input.from].includes(input.to);
    let actual;
    try { actual = !!sut.canTransition(input.from, input.to); }
    catch (_) { return false; } // canTransition must not throw on enum inputs
    return actual === expected;
  },
};
