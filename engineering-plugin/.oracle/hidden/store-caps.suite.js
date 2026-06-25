"use strict";
// HIDDEN — store caps. contract.store_limits: maxEventsPerPlan=1000,
// maxBodyBytes=262144. The store must reject appends that exceed the event cap
// and appends whose body exceeds maxBodyBytes (category cap-exceeded).
module.exports = {
  id: "store-caps",
  label: "store enforces maxEventsPerPlan and maxBodyBytes",
  category: "cap-exceeded",
  async run(sut, t) {
    function append(repo, slug, ev, opts) {
      try { sut.appendEvent(repo, slug, ev, opts); return "ok"; }
      catch (e) { return e && e.name === "ValidationError" ? "ve" : "throw"; }
    }

    // ---- event cap ----
    const repo1 = sut.newRepo();
    const CAP = 4;
    let capHit = false;
    for (let i = 0; i < CAP + 3; i++) {
      const r = append(repo1, "demo", { plan_id: "demo", section_id: "s1", type: "comment", actor: "human", text: "t" + i }, { limits: { maxEventsPerPlan: CAP } });
      if (r !== "ok") { capHit = true; break; }
    }
    // appends beyond the cap must be rejected
    t.check(capHit, "cap-exceeded");

    // ---- body cap (maxBodyBytes) ----
    // An oversized note body must be rejected by the store, not silently written.
    const repo2 = sut.newRepo();
    const bigText = "x".repeat(262144 * 2); // well over maxBodyBytes
    const r2 = append(repo2, "demo", { plan_id: "demo", section_id: "s1", type: "comment", actor: "human", text: bigText }, { limits: { maxBodyBytes: 262144 } });
    t.check(r2 !== "ok", "cap-exceeded");

    // ---- body cap with contract default (no explicit limit) ----
    // store_limits declares a default maxBodyBytes; a 2x-oversized body must
    // still be rejected even when limits are not explicitly supplied.
    const repo3 = sut.newRepo();
    const r3 = append(repo3, "demo", { plan_id: "demo", section_id: "s1", type: "comment", actor: "human", text: bigText }, {});
    t.check(r3 !== "ok", "cap-exceeded");
  },
};
