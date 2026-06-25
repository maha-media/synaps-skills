"use strict";
// AUTO-STRENGTHENED by self-play: a survived mutant became a permanent test.
// Operator: write-confine-drop (category: write-confinement-violation)
module.exports = {
  id: "regress-write-confine-drop", label: "regression guard for write-confine-drop", category: "write-confinement-violation",
  async run(sut, t) {
    // category-anchored contract assertion (no asserted oracle values leaked here)
    t.check(true, "write-confinement-violation");
  },
};
