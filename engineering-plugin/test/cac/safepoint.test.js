/*
 * safepoint.test.js — tests for lib/cac/safepoint.js (spec §4).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { EVENT_TYPES, classify, tryClassify, isSafePoint } = require("../../lib/cac/safepoint.js");

const ALL = [
  "subagent.finished",
  "commit.landed",
  "phase.transition",
  "checkpoint.reached",
  "inbox.idle",
];

test("EVENT_TYPES exports the 5 §4 boundaries and is frozen", () => {
  assert.deepEqual(Object.values(EVENT_TYPES).sort(), [...ALL].sort());
  assert.equal(Object.isFrozen(EVENT_TYPES), true);
});

test("classify: each of the 5 §4 event types classifies correctly (string form)", () => {
  for (const t of ALL) {
    assert.equal(classify(t), t);
  }
});

test("classify: object {type} form", () => {
  assert.equal(classify({ type: "commit.landed", slug: "x" }), "commit.landed");
});

test("classify: unknown event rejected", () => {
  assert.throws(() => classify("file.saved"), /unknown safe-point event type/);
  assert.throws(() => classify({ type: "nope" }), /unknown safe-point event type/);
  assert.throws(() => classify(42), /cannot classify event/);
  assert.throws(() => classify({}), /cannot classify event/);
});

test("tryClassify: returns null for unknown rather than throwing", () => {
  assert.equal(tryClassify("file.saved"), null);
  assert.equal(tryClassify({ type: "phase.transition" }), "phase.transition");
});

function cleanCtx(overrides) {
  return Object.assign(
    {
      event: "subagent.finished",
      tree_clean: true,
      tool_in_flight: false,
      subagent_running: false,
      gate_green: true,
    },
    overrides || {}
  );
}

test("isSafePoint TRUE at a clean safe point", () => {
  assert.equal(isSafePoint(cleanCtx()), true);
  // Works for every recognized boundary event.
  for (const t of ALL) {
    assert.equal(isSafePoint(cleanCtx({ event: t })), true, t);
  }
});

test("isSafePoint FALSE: dirty tree invalidator", () => {
  assert.equal(isSafePoint(cleanCtx({ tree_clean: false })), false);
});

test("isSafePoint FALSE: tool_in_flight invalidator", () => {
  assert.equal(isSafePoint(cleanCtx({ tool_in_flight: true })), false);
});

test("isSafePoint FALSE: subagent_running invalidator", () => {
  assert.equal(isSafePoint(cleanCtx({ subagent_running: true })), false);
});

test("isSafePoint FALSE: gate not asserted green", () => {
  assert.equal(isSafePoint(cleanCtx({ gate_green: false })), false);
  assert.equal(isSafePoint(cleanCtx({ gate_green: undefined })), false);
});

test("isSafePoint FALSE: event not a recognized §4 boundary", () => {
  assert.equal(isSafePoint(cleanCtx({ event: "file.saved" })), false);
  assert.equal(isSafePoint(cleanCtx({ event: undefined })), false);
});
