"use strict";
// AUTO-STRENGTHENED by self-play: a survived mutant became a permanent test.
// Operator: exit-code-2-to-0 (category: bad-request)
module.exports = {
  id: "regress-exit-code-2-to-0", label: "regression guard for exit-code-2-to-0", category: "bad-request",
  async run(sut, t) {
    // category-anchored contract assertion (no asserted oracle values leaked here)
    const cli = sut.runCli(["new"]); t.check(cli.status === 2, "bad-request");
  },
};
