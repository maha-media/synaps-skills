
"use strict";
module.exports = {
  id: "double-is-2x", label: "double(n) === n+n for all n", category: "property-violation",
  gen(g) { return g.int(-1000000, 1000000); },
  holds(sut, n) { return sut.double(n) === n + n; },
};
