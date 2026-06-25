"use strict";
// AUTO-STRENGTHENED by self-play: a survived mutant became a permanent test.
// Operator: status-404-to-200 (category: not-found)
module.exports = {
  id: "regress-status-404-to-200", label: "regression guard for status-404-to-200", category: "not-found",
  async run(sut, t) {
    // category-anchored contract assertion (no asserted oracle values leaked here)
    const { request } = await sut.startServer({}); const r = await request("GET", "/plan/missing-xyz"); t.check(r.status === 404, "not-found");
  },
};
