/*
 * P3-5 — Agent reconcile loop (lib/inbox.js reconcile).
 * Open events get acknowledged then resolved with agent_status + agent_response
 * + responded_at; reconcile is idempotent on already-terminal events; ordering
 * honored by created_at; returns {events,attention,halted}.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const EngPlan = require("../../assets/engplan.js");
const inbox = require("../../lib/inbox.js");

function fixedClock(iso) {
  return { now: () => iso };
}

function buildPlan() {
  return EngPlan.parseEngPlan({
    schema: "engplan/1",
    kind: "plan",
    slug: "demo",
    title: "Demo plan",
    status: "in_progress",
    sections: [
      { id: "s1", heading: "First", type: "task" },
      { id: "s2", heading: "Second", type: "task" },
      { id: "s3", heading: "Third", type: "task" },
    ],
  });
}

// created_at deliberately OUT OF ORDER in array vs chronological time.
function buildEvents() {
  return [
    EngPlan.parseEvent({
      plan_id: "demo", section_id: "s1", type: "comment", actor: "human",
      text: "third chronologically", created_at: "2026-06-25T00:00:03.000Z",
    }),
    EngPlan.parseEvent({
      plan_id: "demo", section_id: "s2", type: "request_change", actor: "human",
      text: "first chronologically", created_at: "2026-06-25T00:00:01.000Z",
    }),
    EngPlan.parseEvent({
      plan_id: "demo", section_id: "s3", type: "clarify", actor: "human",
      text: "second chronologically", created_at: "2026-06-25T00:00:02.000Z",
    }),
  ];
}

test("reconcile returns {events, attention, halted}", () => {
  const out = inbox.reconcile(buildPlan(), buildEvents(), null, {
    clock: fixedClock("2026-06-25T01:00:00.000Z"),
  });
  assert.ok(Array.isArray(out.events));
  assert.ok(out.attention && typeof out.attention === "object");
  assert.ok(Array.isArray(out.halted));
});

test("reconcile acknowledges then resolves open events with response metadata", () => {
  const clock = fixedClock("2026-06-25T01:00:00.000Z");
  const out = inbox.reconcile(buildPlan(), buildEvents(), null, { clock });
  for (const ev of out.events) {
    // default evaluator incorporates comment/request_change/clarify
    assert.equal(ev.status, "incorporated");
    assert.equal(ev.agent_status, "incorporated");
    assert.ok(ev.agent_response.length > 0, "agent_response recorded");
    assert.equal(ev.responded_at, "2026-06-25T01:00:00.000Z");
    assert.deepEqual(ev.changed_sections, [ev.section_id]);
  }
  // all resolved => no outstanding attention
  assert.equal(out.attention.attention_needed, 0);
});

test("reconcile honors ordering by created_at", () => {
  const out = inbox.reconcile(buildPlan(), buildEvents(), null, {
    clock: fixedClock("2026-06-25T01:00:00.000Z"),
  });
  const times = out.events.map((e) => e.created_at);
  const sorted = times.slice().sort();
  assert.deepEqual(times, sorted, "events emitted ascending by created_at");
  // explicit: s2(t1), s3(t2), s1(t3)
  assert.deepEqual(out.events.map((e) => e.section_id), ["s2", "s3", "s1"]);
});

test("reconcile is idempotent on already-terminal events", () => {
  const first = inbox.reconcile(buildPlan(), buildEvents(), null, {
    clock: fixedClock("2026-06-25T01:00:00.000Z"),
  });
  // run again with a DIFFERENT clock; terminal events must be untouched.
  const second = inbox.reconcile(buildPlan(), first.events, null, {
    clock: fixedClock("2026-06-25T09:99-invalid"),
  });
  assert.equal(second.events.length, first.events.length);
  for (let i = 0; i < first.events.length; i++) {
    const a = first.events[i];
    const b = second.events[i];
    assert.equal(b.status, a.status);
    assert.equal(b.agent_status, a.agent_status);
    assert.equal(b.agent_response, a.agent_response);
    assert.equal(b.responded_at, a.responded_at, "responded_at unchanged");
    assert.deepEqual(b.changed_sections, a.changed_sections);
  }
});
