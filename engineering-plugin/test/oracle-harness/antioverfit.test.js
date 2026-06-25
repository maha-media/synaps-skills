"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { checkAll } = require(path.join(__dirname, "..", "..", "tools/oracle/properties.js"));

const FIX = path.join(__dirname, "fixtures");

// A property over an effectively infinite input space the Builder cannot enumerate.
const PROP_DIR = path.join(FIX, "antioverfit-prop");
const fs = require("node:fs");
fs.mkdirSync(PROP_DIR, { recursive: true });
fs.writeFileSync(path.join(PROP_DIR, "double.prop.js"), `
"use strict";
module.exports = {
  id: "double-is-2x", label: "double(n) === n+n for all n", category: "property-violation",
  gen(g) { return g.int(-1000000, 1000000); },
  holds(sut, n) { return sut.double(n) === n + n; },
};
`);

test("antioverfit: lookup-table/overfit SUT fails the property with a counterexample", () => {
  const overfit = () => ({ double: (n) => ({ 1: 2, 2: 4, 3: 6 })[n] }); // only knows public examples
  const r = checkAll(PROP_DIR, { sutFactory: overfit, cases: 2000 });
  assert.equal(r.failed.length, 1, "overfit must fail the generative property");
  assert.ok(r.failed[0].counterexampleSize >= 0);
});

test("antioverfit: general correct SUT passes the property", () => {
  const correct = () => ({ double: (n) => n + n });
  const r = checkAll(PROP_DIR, { sutFactory: correct, cases: 2000 });
  assert.equal(r.failed.length, 0);
});
