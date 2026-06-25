"use strict";
const http = require("node:http");

// A STRONG grading suite: exercises observable contract behavior so each
// contract-tied mutant produces a detectable failure. Designed to KILL mutants.
module.exports = {
  id: "strong-contract", label: "full contract conformance", category: "missing-behavior",
  async run(sut, t) {
    // engplan/1 schema validation present
    let threw = false; try { sut.parsePlan({ schema: "engplan/2", kind: "plan", slug: "x", title: "T", status: "drafting", sections: [] }); } catch (_) { threw = true; }
    t.check(threw, "schema-mismatch");
    // actor validation present
    threw = false; try { sut.parseEvent({ plan_id: "p", section_id: "s", type: "comment", actor: "bogus" }); } catch (_) { threw = true; }
    t.check(threw, "validation-error");
    // lifecycle legality: terminal status has no outgoing transition
    t.check(!sut.canTransition("incorporated", "acknowledged"), "illegal-transition");
    // event cap enforced
    const repo = sut.newRepo();
    let capHit = false;
    try { for (let i = 0; i < 80; i++) sut.appendEvent(repo, "capplan", { section_id: "s", type: "comment", actor: "human" }, { limits: { maxEventsPerPlan: 50 } }); }
    catch (e) { if (/cap/.test(e.message)) capHit = true; }
    t.check(capHit, "cap-exceeded");
    // server: loopback bind + 404 + 400
    const { srv, request } = await sut.startServer({ limits: { maxSseConnections: 1 } });
    const addr = srv.httpServer.address();
    t.check(addr.address === "127.0.0.1", "loopback-violation");
    const r404 = await request("GET", "/plan/nonexistent-plan-xyz");
    t.check(r404.status === 404, "not-found");
    const r400 = await request("GET", "/plan/" + encodeURIComponent("../etc"));
    t.check(r400.status === 400 || r400.status === 404, "bad-request");
    // SSE cap → 503 on the 2nd concurrent stream
    const port = srv.port;
    const tok = srv.token;
    const hdr = tok ? { "x-plan-token": tok } : {};
    const s1 = http.get({ host: "127.0.0.1", port, path: "/api/stream?plan=capx", headers: hdr });
    await new Promise((res) => setTimeout(res, 100));
    const capCode = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/stream?plan=capy", headers: hdr }, (resp) => { resolve(resp.statusCode); resp.destroy(); });
      req.on("error", () => resolve(0));
    });
    t.check(capCode === 503, "too-many-streams");
    try { s1.destroy(); } catch (_) {}
    // CLI usage exit code = 2 on missing args
    const cli = sut.runCli(["new"]);
    t.check(cli.status === 2, "bad-request");
  },
};
