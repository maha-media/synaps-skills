"use strict";
// HIDDEN — malformed engplan/1 must yield a safe ValidationError, never a crash
// or a silent accept. Binds to contract.data_schemas.engplan/1 + lifecycle
// invariant "illegal input throws ValidationError, never silently mutates".
module.exports = {
  id: "malformed-engplan-safety",
  label: "malformed engplan/1 plan/event/note yields a safe categorized error, never a crash",
  category: "validation-error",
  async run(sut, t) {
    // classify a throwing call: "ve" = ValidationError (good), "crash" = other
    // throwable, "none" = did not throw at all.
    function cls(fn) {
      try { fn(); return "none"; }
      catch (e) { return e && e.name === "ValidationError" ? "ve" : "crash"; }
    }
    function mustReject(fn) {
      const r = cls(fn);
      // never an uncategorized crash
      t.check(r !== "crash", "crash");
      // must be rejected, not silently accepted
      t.check(r === "ve", r === "none" ? "schema-mismatch" : "validation-error");
    }

    const VALID_PLAN = { schema: "engplan/1", kind: "plan", slug: "demo", title: "T", status: "drafting", sections: [{ id: "s1", heading: "H", type: "prose" }] };

    // ---- bad plans ----
    const badPlans = [
      null, undefined, 42, "string", true, [], {},
      "{not json", "[]", "null",
      { ...VALID_PLAN, schema: "engplan/2" },          // wrong schema const
      { ...VALID_PLAN, schema: undefined },             // missing schema
      { ...VALID_PLAN, kind: "weird" },                 // invalid kind
      { ...VALID_PLAN, kind: undefined },               // missing kind
      { ...VALID_PLAN, slug: "" },                      // empty slug
      { ...VALID_PLAN, slug: "../escape" },             // bad slug chars
      { ...VALID_PLAN, slug: 12 },                      // non-string slug
      { ...VALID_PLAN, slug: undefined },               // missing slug
      { ...VALID_PLAN, title: undefined },              // missing title
      { ...VALID_PLAN, title: 99 },                     // non-string title
      { ...VALID_PLAN, status: "frozen" },              // invalid status
      { ...VALID_PLAN, status: undefined },             // missing status
      { ...VALID_PLAN, sections: undefined },           // missing sections
      { ...VALID_PLAN, sections: "x" },                 // non-array sections
      { ...VALID_PLAN, sections: {} },                  // non-array sections
      { ...VALID_PLAN, sections: [{ id: "a", heading: "H", type: "prose" }, { id: "a", heading: "H2", type: "task" }] }, // dup section id
      { ...VALID_PLAN, sections: [{ id: "a", heading: "H", type: "nope" }] },     // invalid section type
      { ...VALID_PLAN, sections: [{ heading: "H", type: "prose" }] },             // section missing id
      { ...VALID_PLAN, sections: [{ id: "a", type: "prose" }] },                  // section missing heading
    ];
    for (const p of badPlans) mustReject(() => sut.parsePlan(p));

    // ---- bad events ----
    const VALID_EVENT = { plan_id: "demo", section_id: "s1", type: "comment", actor: "human" };
    const badEvents = [
      null, undefined, 7, "x", [], {},
      { ...VALID_EVENT, plan_id: undefined },           // missing plan_id
      { ...VALID_EVENT, section_id: undefined },        // missing section_id
      { ...VALID_EVENT, type: "explode" },              // invalid type
      { ...VALID_EVENT, type: undefined },              // missing type
      { ...VALID_EVENT, actor: "alien" },               // invalid actor
      { ...VALID_EVENT, actor: undefined },             // missing actor
      { ...VALID_EVENT, status: "frozen" },             // invalid status
      { ...VALID_EVENT, text: 123 },                    // non-string text
    ];
    for (const e of badEvents) mustReject(() => sut.parseEvent(e));

    // ---- bad notes (event with type=comment) ----
    const VALID_NOTE = { plan_id: "demo", section_id: "s1", actor: "human" };
    const badNotes = [
      null, undefined, 0, "x", [], {},
      { ...VALID_NOTE, plan_id: undefined },
      { ...VALID_NOTE, section_id: undefined },
      { ...VALID_NOTE, actor: "robot" },
      { ...VALID_NOTE, text: {} },                      // non-string text
    ];
    for (const n of badNotes) mustReject(() => sut.parseNote(n));

    // sanity: the valid shapes must NOT be rejected
    t.check(cls(() => sut.parsePlan(VALID_PLAN)) === "none", "validation-error");
    t.check(cls(() => sut.parseEvent(VALID_EVENT)) === "none", "validation-error");
    t.check(cls(() => sut.parseNote(VALID_NOTE)) === "none", "validation-error");
  },
};
