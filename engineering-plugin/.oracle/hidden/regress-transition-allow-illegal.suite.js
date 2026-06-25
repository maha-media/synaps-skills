"use strict";
// AUTO-STRENGTHENED by self-play: a survived mutant became a permanent test.
// Operator: transition-allow-illegal (category: illegal-transition)
module.exports = {
  id: "regress-transition-allow-illegal", label: "regression guard for transition-allow-illegal", category: "illegal-transition",
  async run(sut, t) {
    // category-anchored contract assertion (no asserted oracle values leaked here)
    t.check(!sut.canTransition("incorporated", "acknowledged"), "illegal-transition");
  },
};
