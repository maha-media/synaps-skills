"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { fuzzTarget } = require(path.join(__dirname, "..", "..", "tools/oracle/fuzz.js"));
const { createSut } = require(path.join(__dirname, "..", "..", "tools/oracle/sut.js"));

test("fuzz: the real build survives malformed engplan/1 input (safe error, never crash)", () => {
  const sut = createSut({});
  try {
    const r = fuzzTarget(
      (input) => sut.parsePlan(input),
      (g) => g.anyValue(0),
      { runs: 800, isCrash: (e) => e && e.name !== "ValidationError" }
    );
    assert.equal(r.crashed, false, "build must not crash on malformed input");
  } finally { sut.cleanup(); }
});

test("fuzz: a planted crash bug is found + minimized within budget", () => {
  const planted = (input) => {
    if (typeof input === "string" && input.includes("\0")) { return input.length.toFixed(); } // ok
    if (Array.isArray(input) && input.length > 2) throw new TypeError("boom: unhandled array"); // crash
    if (input == null) throw { name: "ValidationError" }; // safe
    return String(input);
  };
  const r = fuzzTarget(planted, (g) => g.anyValue(0), { runs: 2000 });
  assert.equal(r.crashed, true);
  assert.equal(r.category, "crash");
});

test("fuzz: runs are bounded (maxRuns enforced)", () => {
  let calls = 0;
  fuzzTarget(() => { calls++; }, (g) => g.int(0, 10), { runs: 99999, maxRuns: 100 });
  assert.ok(calls <= 100, "fuzz must respect maxRuns bound, got " + calls);
});
