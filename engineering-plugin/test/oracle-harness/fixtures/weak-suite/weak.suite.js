"use strict";
// A DELIBERATELY WEAK suite: only checks a trivial happy path. It should FAIL to
// kill most contract-tied mutants → the mutation gate must REJECT it.
module.exports = {
  id: "weak", label: "weak happy-path only", category: "missing-behavior",
  async run(sut, t) {
    const plan = sut.parsePlan({ schema: "engplan/1", kind: "plan", slug: "ok", title: "T", status: "drafting", sections: [] });
    t.check(plan.slug === "ok", "missing-behavior");
  },
};
