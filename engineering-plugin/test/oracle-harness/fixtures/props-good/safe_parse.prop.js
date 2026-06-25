"use strict";
module.exports = {
  id: "malformed-safe", label: "malformed engplan/1 yields a safe error, never a crash", category: "validation-error",
  gen(g) { return g.anyValue(0); },
  holds(sut, input) {
    try { sut.parsePlan(input); return true; } // accepted (rare) is fine
    catch (e) { return e.name === "ValidationError"; } // must be a safe, named error
  },
};
