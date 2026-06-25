"use strict";
// AUTO-STRENGTHENED by self-play: a survived mutant became a permanent test.
// Operator: event-cap-off (category: cap-exceeded)
module.exports = {
  id: "regress-event-cap-off", label: "regression guard for event-cap-off", category: "cap-exceeded",
  async run(sut, t) {
    // category-anchored contract assertion (no asserted oracle values leaked here)
    const repo = sut.newRepo(); let hit=false; try { for (let i=0;i<60;i++) sut.appendEvent(repo,"p",{section_id:"s",type:"comment",actor:"human"},{limits:{maxEventsPerPlan:50}}); } catch(e){ hit=/cap/.test(e.message);} t.check(hit, "cap-exceeded");
  },
};
