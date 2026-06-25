/*
 * state.test.js — tests for lib/cac/state.js (spec §5 state machine).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { STATES, EVENTS, transition } = require("../../lib/cac/state.js");

const GOOD = { token_persisted: true, tree_clean: true, gate_green: true };

test("every legal transition succeeds and returns the expected next state", () => {
  assert.equal(transition(STATES.RUNNING, EVENTS.CONTEXT_PRESSURE).state, STATES.ARMED);
  assert.equal(transition(STATES.ARMED, EVENTS.SAFE_POINT_REACHED).state, STATES.CHECKPOINT_REACHED);
  assert.equal(
    transition(STATES.CHECKPOINT_REACHED, EVENTS.CHECKPOINT_COMMITTED, GOOD).state,
    STATES.SUSPENDED
  );
  assert.equal(transition(STATES.SUSPENDED, EVENTS.PRE_COMPACT_OK).state, STATES.COMPACTING);
  assert.equal(transition(STATES.COMPACTING, EVENTS.SUMMARY_BUILT).state, STATES.RESUMING);
  assert.equal(transition(STATES.RESUMING, EVENTS.CONTINUITY_VERIFIED).state, STATES.RUNNING);
});

test("legal transitions return a reason string", () => {
  const r = transition(STATES.RUNNING, EVENTS.CONTEXT_PRESSURE);
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.length > 0);
});

test("illegal transition RUNNING --> COMPACTING (skip ahead) rejected", () => {
  assert.throws(() => transition(STATES.RUNNING, EVENTS.SUMMARY_BUILT), /illegal transition/);
  assert.throws(() => transition(STATES.RUNNING, EVENTS.PRE_COMPACT_OK), /illegal transition/);
});

test("illegal transition ARMED --> RUNNING rejected", () => {
  assert.throws(() => transition(STATES.ARMED, EVENTS.CONTINUITY_VERIFIED), /illegal transition/);
  assert.throws(() => transition(STATES.ARMED, EVENTS.CONTEXT_PRESSURE), /illegal transition/);
});

test("CHECKPOINT_REACHED --> SUSPENDED rejected when tree dirty", () => {
  assert.throws(
    () => transition(STATES.CHECKPOINT_REACHED, EVENTS.CHECKPOINT_COMMITTED, { token_persisted: true, tree_clean: false, gate_green: true }),
    /tree not clean/
  );
});

test("CHECKPOINT_REACHED --> SUSPENDED rejected when gate not green", () => {
  assert.throws(
    () => transition(STATES.CHECKPOINT_REACHED, EVENTS.CHECKPOINT_COMMITTED, { token_persisted: true, tree_clean: true, gate_green: false }),
    /gate not green/
  );
});

test("CHECKPOINT_REACHED --> SUSPENDED rejected when token not persisted", () => {
  assert.throws(
    () => transition(STATES.CHECKPOINT_REACHED, EVENTS.CHECKPOINT_COMMITTED, { token_persisted: false, tree_clean: true, gate_green: true }),
    /token not persisted/
  );
});

test("guard rejection carries a reason on the thrown error", () => {
  try {
    transition(STATES.CHECKPOINT_REACHED, EVENTS.CHECKPOINT_COMMITTED, GOOD && { token_persisted: false });
    assert.fail("should have thrown");
  } catch (e) {
    assert.equal(typeof e.reason, "string");
  }
});

test("unknown state rejected", () => {
  assert.throws(() => transition("NONSENSE", EVENTS.CONTEXT_PRESSURE), /unknown state/);
});

test("purity: same args yield same result (twice)", () => {
  const a = transition(STATES.CHECKPOINT_REACHED, EVENTS.CHECKPOINT_COMMITTED, GOOD);
  const b = transition(STATES.CHECKPOINT_REACHED, EVENTS.CHECKPOINT_COMMITTED, GOOD);
  assert.deepEqual(a, b);
  const c = transition(STATES.RUNNING, EVENTS.CONTEXT_PRESSURE);
  const d = transition(STATES.RUNNING, EVENTS.CONTEXT_PRESSURE);
  assert.deepEqual(c, d);
});
