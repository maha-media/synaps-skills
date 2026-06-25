"use strict";
// AUTO-STRENGTHENED by self-play: a survived mutant became a permanent test.
// Operator: schema-check-drop (category: schema-mismatch)
module.exports = {
  id: "regress-schema-check-drop", label: "regression guard for schema-check-drop", category: "schema-mismatch",
  async run(sut, t) {
    // category-anchored contract assertion (no asserted oracle values leaked here)
    let threw=false; try { sut.parsePlan({schema:"engplan/2",kind:"plan",slug:"x",title:"T",status:"drafting",sections:[]}); } catch(_){threw=true;} t.check(threw, "schema-mismatch");
  },
};
