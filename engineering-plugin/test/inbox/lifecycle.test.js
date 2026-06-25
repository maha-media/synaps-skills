/*
 * P3-4 — Event lifecycle state machine (assets/engplan.js).
 * Asserts canTransition legal/illegal table, transition() throwing on illegal,
 * and isTerminal classification. Tests assert the REAL source behavior.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const EngPlan = require("../../assets/engplan.js");

test("canTransition — legal transitions accepted", () => {
  assert.equal(EngPlan.canTransition("open", "acknowledged"), true);
  assert.equal(EngPlan.canTransition("acknowledged", "incorporated"), true);
  assert.equal(EngPlan.canTransition("acknowledged", "rejected"), true);
  assert.equal(EngPlan.canTransition("acknowledged", "deferred"), true);
  assert.equal(EngPlan.canTransition("acknowledged", "blocked"), true);
});

test("canTransition — illegal transitions rejected", () => {
  // cannot skip acknowledgement to a resolution
  assert.equal(EngPlan.canTransition("open", "incorporated"), false);
  assert.equal(EngPlan.canTransition("open", "rejected"), false);
  assert.equal(EngPlan.canTransition("open", "deferred"), false);
  // terminal states cannot transition to anything
  for (const term of ["incorporated", "rejected", "deferred"]) {
    for (const to of EngPlan.EVENT_STATUS) {
      assert.equal(
        EngPlan.canTransition(term, to),
        false,
        `${term} → ${to} must be illegal`
      );
    }
  }
  // unknown statuses are not transitionable
  assert.equal(EngPlan.canTransition("bogus", "open"), false);
  assert.equal(EngPlan.canTransition("open", "bogus"), false);
});

test("transition() throws on illegal transitions", () => {
  const ev = { status: "open", type: "comment" };
  assert.throws(
    () => EngPlan.transition(ev, "incorporated"),
    /illegal transition: open → incorporated/
  );
  const inc = { status: "incorporated" };
  assert.throws(() => EngPlan.transition(inc, "acknowledged"), /illegal transition/);
});

test("transition() returns a new event with updated status on legal move", () => {
  const ev = { status: "open", type: "comment", id: "x" };
  const next = EngPlan.transition(ev, "acknowledged");
  assert.equal(next.status, "acknowledged");
  assert.equal(next.id, "x");
  // immutability: source unchanged
  assert.equal(ev.status, "open");
});

test("isTerminal — incorporated/rejected/deferred terminal; open/acknowledged not", () => {
  assert.equal(EngPlan.isTerminal("incorporated"), true);
  assert.equal(EngPlan.isTerminal("rejected"), true);
  assert.equal(EngPlan.isTerminal("deferred"), true);
  assert.equal(EngPlan.isTerminal("open"), false);
  assert.equal(EngPlan.isTerminal("acknowledged"), false);
  // blocked is NOT terminal (it can still be resolved)
  assert.equal(EngPlan.isTerminal("blocked"), false);
});
