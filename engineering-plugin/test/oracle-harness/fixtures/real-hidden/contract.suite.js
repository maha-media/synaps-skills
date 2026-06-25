"use strict";
// Machinery fixture: grades the REAL build's contract surface via the SUT adapter.
module.exports = {
  id: "real-contract", label: "engplan/1 contract conformance", category: "validation-error",
  async run(sut, t) {
    const plan = sut.parsePlan({ schema: "engplan/1", kind: "plan", slug: "x", title: "T", status: "drafting", sections: [] });
    t.check(plan.slug === "x", "validation-error");
    t.check(sut.canTransition("open", "acknowledged"), "illegal-transition");
    t.check(!sut.canTransition("incorporated", "acknowledged"), "illegal-transition");
  },
};
