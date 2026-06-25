"use strict";
// AUTO-STRENGTHENED by self-play: a survived mutant became a permanent test.
// Operator: status-400-to-200-badid (category: bad-request)
module.exports = {
  id: "regress-status-400-to-200-badid", label: "regression guard for status-400-to-200-badid", category: "bad-request",
  async run(sut, t) {
    // category-anchored contract assertion (no asserted oracle values leaked here)
    const cli = sut.runCli(["new"]); t.check(cli.status === 2, "bad-request");
  },
};
