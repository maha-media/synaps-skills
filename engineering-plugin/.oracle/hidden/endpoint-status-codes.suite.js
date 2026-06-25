"use strict";
// HIDDEN — HTTP endpoint status codes. Binds to contract.endpoints +
// server_invariants:
//   GET /plan/<unknown> -> 404 ; GET /plan/<invalid id> -> 400 ;
//   unknown route -> 404 ; bad json POST -> 400 ; GET /api/notes (no plan) -> 400.
module.exports = {
  id: "endpoint-status-codes",
  label: "endpoints return contract-declared status codes",
  category: "bad-request",
  async run(sut, t) {
    const http = require("node:http");
    const { request, srv, port, token } = await sut.startServer({});
    t.check(srv && srv.httpServer, "internal-error");

    // timed GET that never hangs (for endpoints that might stream on success)
    function timedGet(p) {
      return new Promise((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, method: "GET", path: p,
          headers: token ? { "x-plan-token": token } : {} }, (res) => {
          resolve(res.statusCode);
          res.destroy();
        });
        req.on("error", () => resolve("error"));
        req.setTimeout(2500, () => { req.destroy(); resolve("stream-open"); });
        req.end();
      });
    }

    // GET / -> 200 html
    const root = await request("GET", "/");
    t.check(root.status === 200, "missing-behavior");

    // GET /plan/<unknown> -> 404
    const unknown = await request("GET", "/plan/this-id-does-not-exist");
    t.check(unknown.status === 404, "not-found");

    // GET /plan/<invalid id> -> 400 (invalid per id_pattern; uses url-escaped chars)
    const invalid1 = await request("GET", "/plan/a%20b");        // space
    t.check(invalid1.status === 400, "bad-request");
    const invalid2 = await request("GET", "/plan/..%2Fetc");     // traversal-ish
    t.check(invalid2.status === 400 || invalid2.status === 404, "bad-request");

    // unknown route -> 404
    const noroute = await request("GET", "/no/such/route/here");
    t.check(noroute.status === 404, "not-found");

    // bad json body POST -> 400
    const badjson = await request("POST", "/api/notes?plan=demo", "{ this is : not json");
    t.check(badjson.status === 400, "bad-request");

    // GET /api/notes without ?plan -> 400
    const noplan = await request("GET", "/api/notes");
    t.check(noplan.status === 400, "bad-request");

    // GET /api/stream without ?plan -> 400 (per contract errors:[400,503]); a
    // success-stream here would be a contract violation. timedGet never hangs.
    const streamNoPlan = await timedGet("/api/stream");
    t.check(streamNoPlan === 400, "bad-request");
  },
};
