"use strict";
// HIDDEN — lifecycle legality. Binds to contract.lifecycle.transitions exactly:
//   open->[acknowledged,blocked], acknowledged->[incorporated,rejected,deferred,blocked],
//   blocked->[acknowledged,incorporated,rejected,deferred], terminals->[].
// canTransition must be true ONLY for those pairs; terminals have NO outgoing
// transition; transition() must throw ValidationError (never silently mutate)
// on any illegal pair.
module.exports = {
  id: "lifecycle-legality",
  label: "only contract lifecycle transitions are legal; terminals are sinks",
  category: "illegal-transition",
  async run(sut, t) {
    const STATUSES = ["open", "acknowledged", "blocked", "incorporated", "rejected", "deferred"];
    const TABLE = {
      open: ["acknowledged", "blocked"],
      acknowledged: ["incorporated", "rejected", "deferred", "blocked"],
      blocked: ["acknowledged", "incorporated", "rejected", "deferred"],
      incorporated: [],
      rejected: [],
      deferred: [],
    };
    const TERMINAL = ["incorporated", "rejected", "deferred"];

    // Exhaustively check every (from,to) pair against the contract table.
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const legal = TABLE[from].includes(to);
        let actual;
        try { actual = !!sut.canTransition(from, to); }
        catch (_) { actual = "threw"; }
        // canTransition must be a clean boolean reflecting exactly the table
        t.check(actual === legal, "illegal-transition");
      }
    }

    // terminals have zero outgoing transitions
    for (const term of TERMINAL) {
      for (const to of STATUSES) {
        let allowed;
        try { allowed = !!sut.canTransition(term, to); } catch (_) { allowed = false; }
        t.check(allowed === false, "illegal-transition");
      }
    }

    const baseEv = { plan_id: "d", section_id: "s1", type: "comment", actor: "human" };

    // transition() must SUCCEED on legal pairs and THROW ValidationError on illegal
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const legal = TABLE[from].includes(to);
        let outcome;
        try {
          const res = sut.transition({ ...baseEv, status: from }, to);
          outcome = (res && res.status === to) ? "ok" : "mutated-wrong";
        } catch (e) {
          outcome = e && e.name === "ValidationError" ? "ve" : "crash";
        }
        if (legal) {
          t.check(outcome === "ok", "illegal-transition");
        } else {
          // illegal must throw ValidationError, never silently mutate, never crash uncategorized
          t.check(outcome === "ve", outcome === "crash" ? "crash" : "illegal-transition");
        }
      }
    }
  },
};
