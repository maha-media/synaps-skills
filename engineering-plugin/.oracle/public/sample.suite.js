"use strict";
// PUBLIC sample suite (Builder may read). A few happy-path examples that mirror
// the contract; passing these is necessary but not sufficient — the hidden gate
// is broader.
module.exports = {
  id: "public-happy-path",
  label: "valid plan parses, a legal transition works, GET / returns 200",
  category: "missing-behavior",
  async run(sut, t) {
    // a valid engplan/1 plan parses without throwing
    const plan = {
      schema: "engplan/1", kind: "plan", slug: "demo", title: "Demo",
      status: "drafting",
      sections: [{ id: "s1", heading: "Intro", type: "prose" }],
    };
    let parsed = null;
    try { parsed = sut.parsePlan(plan); } catch (_) { /* falls through */ }
    t.check(!!parsed, "schema-mismatch");

    // a valid event parses
    let ev = null;
    try { ev = sut.parseEvent({ plan_id: "demo", section_id: "s1", type: "comment", actor: "human" }); }
    catch (_) {}
    t.check(!!ev, "validation-error");

    // a legal transition open -> acknowledged works
    t.check(sut.canTransition("open", "acknowledged") === true, "illegal-transition");
    let moved = null;
    try { moved = sut.transition({ plan_id: "demo", section_id: "s1", type: "comment", actor: "human", status: "open" }, "acknowledged"); }
    catch (_) {}
    t.check(moved && moved.status === "acknowledged", "illegal-transition");

    // GET / returns 200
    const { request } = await sut.startServer({});
    const root = await request("GET", "/");
    t.check(root.status === 200, "missing-behavior");
  },
};
