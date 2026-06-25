"use strict";
// AUTO-STRENGTHENED by self-play: a survived mutant became a permanent test.
// Operator: actor-validation-drop (category: validation-error)
module.exports = {
  id: "regress-actor-validation-drop", label: "regression guard for actor-validation-drop", category: "validation-error",
  async run(sut, t) {
    // category-anchored contract assertion (no asserted oracle values leaked here)
    let threw=false; try { sut.parseEvent({plan_id:"p",section_id:"s",type:"comment",actor:"bogus"}); } catch(_){threw=true;} t.check(threw, "validation-error");
  },
};
