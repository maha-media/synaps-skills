"use strict";
// AUTO-STRENGTHENED by self-play: a survived mutant became a permanent test.
// Operator: bind-any-interface (category: loopback-violation)
module.exports = {
  id: "regress-bind-any-interface", label: "regression guard for bind-any-interface", category: "loopback-violation",
  async run(sut, t) {
    // category-anchored contract assertion (no asserted oracle values leaked here)
    const { srv } = await sut.startServer({}); t.check(srv.httpServer.address().address === "127.0.0.1", "loopback-violation");
  },
};
