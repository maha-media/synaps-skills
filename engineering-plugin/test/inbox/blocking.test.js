/*
 * P3-6 — Blocking semantics: a block halts the blocked section AND its
 * depends_on dependents; resolving the block lifts the halt; non-blocking
 * events never halt. Exercises lib/inbox.js haltedTasks/canStart/blockedSections.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const EngPlan = require("../../assets/engplan.js");
const inbox = require("../../lib/inbox.js");

function buildPlan() {
  return EngPlan.parseEngPlan({
    schema: "engplan/1",
    kind: "plan",
    slug: "blk",
    title: "Blocking plan",
    status: "in_progress",
    sections: [
      { id: "task-a", heading: "A", type: "task" },
      { id: "task-b", heading: "B", type: "task", depends_on: ["task-a"] },
    ],
  });
}

function blockEvent(status) {
  return EngPlan.parseEvent({
    plan_id: "blk", section_id: "task-a", type: "block", actor: "human",
    text: "stop", status: status || "open", created_at: "2026-06-25T00:00:00.000Z",
  });
}

test("open block halts the blocked section AND its dependents", () => {
  const plan = buildPlan();
  const events = [blockEvent("open")];
  const halted = inbox.haltedTasks(plan, events);
  assert.equal(halted.has("task-a"), true, "directly blocked section halted");
  assert.equal(halted.has("task-b"), true, "dependent of blocked section halted");
});

test("canStart false for blocked + dependent while block open", () => {
  const plan = buildPlan();
  const events = [blockEvent("open")];
  assert.equal(inbox.canStart(plan, events, "task-a"), false);
  assert.equal(inbox.canStart(plan, events, "task-b"), false);
});

test("acknowledged block still halts (open OR acknowledged)", () => {
  const plan = buildPlan();
  const halted = inbox.haltedTasks(plan, [blockEvent("acknowledged")]);
  assert.equal(halted.has("task-a"), true);
  assert.equal(halted.has("task-b"), true);
});

test("resolving the block (incorporated) lifts the halt", () => {
  const plan = buildPlan();
  const events = [blockEvent("incorporated")];
  const halted = inbox.haltedTasks(plan, events);
  assert.equal(halted.has("task-a"), false);
  assert.equal(halted.has("task-b"), false);
  assert.equal(inbox.canStart(plan, events, "task-a"), true);
  assert.equal(inbox.canStart(plan, events, "task-b"), true);
});

test("non-blocking event (comment) never halts dependent work", () => {
  const plan = buildPlan();
  const comment = EngPlan.parseEvent({
    plan_id: "blk", section_id: "task-a", type: "comment", actor: "human",
    text: "fyi", status: "open", created_at: "2026-06-25T00:00:00.000Z",
  });
  const halted = inbox.haltedTasks(plan, [comment]);
  assert.equal(halted.size, 0);
  assert.equal(inbox.canStart(plan, [comment], "task-a"), true);
  assert.equal(inbox.canStart(plan, [comment], "task-b"), true);
  // blockedSections is also empty for a comment
  assert.equal(inbox.blockedSections([comment]).size, 0);
});
