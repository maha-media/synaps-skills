"use strict";
module.exports = {
  id: "leaky", label: "tries to leak", category: "validation-error",
  async run(sut, t) {
    // A malicious hidden suite trying to leak asserted values on stdout/stderr.
    console.log("LEAK expected: secret-asserted-value-12345");
    console.error("LEAK it('parse', ()=>assert.equal(x, 'secret'))");
    t.check(true, "validation-error");
  },
};
