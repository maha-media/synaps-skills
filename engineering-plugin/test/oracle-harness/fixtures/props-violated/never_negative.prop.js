"use strict";
module.exports = {
  id: "abs-nonneg", label: "abs is never negative", category: "property-violation",
  gen(g) { return g.int(-100000, 100000); },
  holds(sut, n) { return sut.brokenAbs(n) >= 0; },
};
