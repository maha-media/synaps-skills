"use strict";
// HIDDEN — loopback-only bind. contract.server_invariants:
//   "binds 127.0.0.1 only (loopback); never 0.0.0.0".
module.exports = {
  id: "loopback-only",
  label: "server binds 127.0.0.1 only",
  category: "loopback-violation",
  async run(sut, t) {
    const { srv } = await sut.startServer({});
    const addr = srv && srv.httpServer && srv.httpServer.address();
    t.check(!!addr && typeof addr === "object", "loopback-violation");
    t.check(addr.address === "127.0.0.1", "loopback-violation");
    // must never be a wildcard / any-interface bind
    t.check(addr.address !== "0.0.0.0", "loopback-violation");
    t.check(addr.address !== "::", "loopback-violation");
    t.check(addr.address !== "::0", "loopback-violation");
  },
};
