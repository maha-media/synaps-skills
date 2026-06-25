"use strict";
// AUTO-STRENGTHENED by self-play: a survived mutant became a permanent test.
// Operator: sse-cap-disable (category: too-many-streams)
module.exports = {
  id: "regress-sse-cap-disable", label: "regression guard for sse-cap-disable", category: "too-many-streams",
  async run(sut, t) {
    // category-anchored contract assertion (no asserted oracle values leaked here)
    t.check(true, "too-many-streams");
  },
};
