/*
 * P3-7 — Attention counters (lib/inbox.js computeAttention).
 * Maps event types→counters (Decision G); sections needs-human-review add to
 * needs_review; attention_needed is the sum; resolved events drop out.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const EngPlan = require("../../assets/engplan.js");
const inbox = require("../../lib/inbox.js");

function ev(type, status, section) {
  return EngPlan.parseEvent({
    plan_id: "p", section_id: section || "s1", type, actor: "human",
    status: status || "open", created_at: "2026-06-25T00:00:00.000Z",
  });
}

test("open block -> blocking", () => {
  const a = inbox.computeAttention([ev("block")], null);
  assert.equal(a.blocking, 1);
  assert.equal(a.unresolved, 0);
  assert.equal(a.needs_review, 0);
  assert.equal(a.new_criteria, 0);
  assert.equal(a.attention_needed, 1);
});

test("open comment/request_change/clarify -> unresolved", () => {
  const a = inbox.computeAttention(
    [ev("comment"), ev("request_change"), ev("clarify")], null);
  assert.equal(a.unresolved, 3);
  assert.equal(a.blocking, 0);
  assert.equal(a.attention_needed, 3);
});

test("open approve -> needs_review", () => {
  const a = inbox.computeAttention([ev("approve")], null);
  assert.equal(a.needs_review, 1);
  assert.equal(a.attention_needed, 1);
});

test("section approval needs-human-review -> needs_review", () => {
  const plan = EngPlan.parseEngPlan({
    schema: "engplan/1", kind: "plan", slug: "p", title: "P", status: "in_progress",
    sections: [{ id: "s1", heading: "H", type: "gate", approval: "needs-human-review" }],
  });
  const a = inbox.computeAttention([], plan);
  assert.equal(a.needs_review, 1);
  assert.equal(a.attention_needed, 1);
});

test("approve event + needs-human-review section both count toward needs_review", () => {
  const plan = EngPlan.parseEngPlan({
    schema: "engplan/1", kind: "plan", slug: "p", title: "P", status: "in_progress",
    sections: [{ id: "s1", heading: "H", type: "gate", approval: "needs-human-review" }],
  });
  const a = inbox.computeAttention([ev("approve")], plan);
  assert.equal(a.needs_review, 2);
  assert.equal(a.attention_needed, 2);
});

test("add_acceptance_criterion -> new_criteria", () => {
  const a = inbox.computeAttention([ev("add_acceptance_criterion")], null);
  assert.equal(a.new_criteria, 1);
  assert.equal(a.attention_needed, 1);
});

test("attention_needed is the sum of all counters", () => {
  const a = inbox.computeAttention([
    ev("block"),
    ev("comment"), ev("request_change"),
    ev("approve"),
    ev("add_acceptance_criterion"),
  ], null);
  assert.equal(a.blocking, 1);
  assert.equal(a.unresolved, 2);
  assert.equal(a.needs_review, 1);
  assert.equal(a.new_criteria, 1);
  assert.equal(a.attention_needed, 1 + 2 + 1 + 1);
});

test("resolved (incorporated) events drop out of counters", () => {
  const a = inbox.computeAttention([
    ev("block", "incorporated"),
    ev("comment", "incorporated"),
    ev("approve", "incorporated"),
    ev("add_acceptance_criterion", "incorporated"),
  ], null);
  assert.equal(a.blocking, 0);
  assert.equal(a.unresolved, 0);
  assert.equal(a.needs_review, 0);
  assert.equal(a.new_criteria, 0);
  assert.equal(a.attention_needed, 0);
});

test("acknowledged events still count (open OR acknowledged)", () => {
  const a = inbox.computeAttention([ev("block", "acknowledged")], null);
  assert.equal(a.blocking, 1);
});
