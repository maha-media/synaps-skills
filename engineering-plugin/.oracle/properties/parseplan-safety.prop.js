"use strict";
// PROPERTY — malformed-input safety. For ANY value, parsePlan either returns a
// valid plan object or throws a ValidationError; it must NEVER throw a
// non-ValidationError (a crash) and must never return a non-plan.
module.exports = {
  id: "parsePlan-safe-on-any-value",
  label: "any value -> parsePlan yields a safe ValidationError or a valid plan, never a crash",
  category: "validation-error",
  gen(g) { return g.anyValue(0); },
  holds(sut, input) {
    try {
      const out = sut.parsePlan(input);
      // accepted: must be a plan-shaped object carrying the schema const
      return !!out && typeof out === "object" && !Array.isArray(out) && out.schema === "engplan/1";
    } catch (e) {
      // rejected: must be a categorized ValidationError, never an arbitrary crash
      return !!e && e.name === "ValidationError";
    }
  },
};
