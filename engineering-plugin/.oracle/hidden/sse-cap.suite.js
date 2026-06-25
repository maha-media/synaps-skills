"use strict";
// HIDDEN — SSE connection cap. contract.server_invariants:
//   "SSE connection cap returns 503 beyond maxSseConnections".
// With limits {maxSseConnections:1}, the 2nd concurrent GET /api/stream?plan=x
// must be refused with 503.
module.exports = {
  id: "sse-cap",
  label: "SSE connection cap returns 503 beyond the limit",
  category: "too-many-streams",
  async run(sut, t) {
    const http = require("node:http");
    const { srv, port, token } = await sut.startServer({ limits: { maxSseConnections: 1 } });

    const open = [];
    function openStream() {
      return new Promise((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, method: "GET",
          path: "/api/stream?plan=demo", headers: token ? { "x-plan-token": token } : {} },
          (res) => { resolve({ status: res.statusCode, res, req }); });
        req.on("error", () => resolve({ status: "error", req }));
        // a successful stream stays open; resolve after headers via response cb,
        // or after a short grace if no headers arrive.
        req.setTimeout(2500, () => resolve({ status: "stream-open", req }));
        req.end();
        open.push(req);
      });
    }

    // first connection should be accepted (200 stream)
    const c1 = await openStream();
    t.check(c1.status === 200, "too-many-streams");

    // second concurrent connection must be refused with 503
    const c2 = await openStream();
    t.check(c2.status === 503, "too-many-streams");

    // cleanup raw sockets we opened
    for (const r of open) { try { r.destroy(); } catch (_) {} }
    try { if (c1.res) c1.res.destroy(); } catch (_) {}
    try { if (c2.res) c2.res.destroy(); } catch (_) {}
  },
};
