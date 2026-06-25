"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const EngPlan = require("../../assets/engplan.js");

const VALID = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../fixtures/valid-plan.json"), "utf8")
);
function clone() { return JSON.parse(JSON.stringify(VALID)); }

test("valid engplan/1 parses into typed shape", () => {
  const p = EngPlan.parseEngPlan(clone());
  assert.equal(p.schema, "engplan/1");
  assert.equal(p.kind, "plan");
  assert.equal(p.slug, "sample-plan");
  assert.equal(p.title, "Sample Plan");
  assert.equal(p.status, "in_progress");
  assert.equal(p.convergence, "informed");
  assert.equal(p.sections.length, 2);
  assert.equal(p.sections[1].state, "doing");
  assert.equal(p.sections[1].approval, "needs-human-review");
  assert.equal(p.sections[1].risk, "risky");
  assert.deepEqual(p.sections[1].acceptance, ["builds clean", "tests pass"]);
  assert.deepEqual(p.sections[1].verification, ["run node --test"]);
});

test("parseEngPlan also accepts a JSON string", () => {
  const p = EngPlan.parseEngPlan(JSON.stringify(clone()));
  assert.equal(p.slug, "sample-plan");
});

test("schema != engplan/1 is rejected with ValidationError", () => {
  const bad = clone();
  bad.schema = "engplan/2";
  assert.throws(() => EngPlan.parseEngPlan(bad), (e) => {
    assert.equal(e.name, "ValidationError");
    return /schema/i.test(e.message);
  });
});

test("missing schema rejected", () => {
  const bad = clone();
  delete bad.schema;
  assert.throws(() => EngPlan.parseEngPlan(bad), /ValidationError|schema/);
});

test("required top-level fields enforced", () => {
  for (const field of ["kind", "slug", "title", "status"]) {
    const bad = clone();
    delete bad[field];
    assert.throws(() => EngPlan.parseEngPlan(bad), (e) => e.name === "ValidationError",
      "expected throw when missing " + field);
  }
});

test("sections must be an array", () => {
  const bad = clone();
  delete bad.sections;
  assert.throws(() => EngPlan.parseEngPlan(bad), (e) => e.name === "ValidationError");
  const bad2 = clone();
  bad2.sections = "nope";
  assert.throws(() => EngPlan.parseEngPlan(bad2), (e) => e.name === "ValidationError");
});

test("section requires id, heading, type", () => {
  for (const field of ["id", "heading", "type"]) {
    const bad = clone();
    delete bad.sections[0][field];
    assert.throws(() => EngPlan.parseEngPlan(bad), (e) => e.name === "ValidationError",
      "expected throw when section missing " + field);
  }
});

test("empty section id rejected", () => {
  const bad = clone();
  bad.sections[0].id = "";
  assert.throws(() => EngPlan.parseEngPlan(bad), (e) => e.name === "ValidationError");
});

test("invalid section id characters rejected", () => {
  const bad = clone();
  bad.sections[0].id = "bad id with spaces!";
  assert.throws(() => EngPlan.parseEngPlan(bad), (e) => e.name === "ValidationError");
});

test("duplicate section ids rejected", () => {
  const bad = clone();
  bad.sections[1].id = bad.sections[0].id;
  assert.throws(() => EngPlan.parseEngPlan(bad), (e) => {
    assert.equal(e.name, "ValidationError");
    return /duplicate/i.test(e.message);
  });
});

test("section.type constrained to enum", () => {
  const bad = clone();
  bad.sections[0].type = "not-a-type";
  assert.throws(() => EngPlan.parseEngPlan(bad), (e) => e.name === "ValidationError");
});

test("section.state constrained to enum", () => {
  const bad = clone();
  bad.sections[1].state = "halfway";
  assert.throws(() => EngPlan.parseEngPlan(bad), (e) => e.name === "ValidationError");
});

test("section.approval constrained to enum", () => {
  const bad = clone();
  bad.sections[1].approval = "rubber-stamped";
  assert.throws(() => EngPlan.parseEngPlan(bad), (e) => e.name === "ValidationError");
});

test("section.risk constrained to enum", () => {
  const bad = clone();
  bad.sections[1].risk = "spicy";
  assert.throws(() => EngPlan.parseEngPlan(bad), (e) => e.name === "ValidationError");
});

test("plan.kind constrained to enum", () => {
  const bad = clone();
  bad.kind = "novel";
  assert.throws(() => EngPlan.parseEngPlan(bad), (e) => e.name === "ValidationError");
});

test("plan.status constrained to enum", () => {
  const bad = clone();
  bad.status = "vibing";
  assert.throws(() => EngPlan.parseEngPlan(bad), (e) => e.name === "ValidationError");
});

test("unknown fields are ignored without crashing", () => {
  const x = clone();
  x.mystery_field = { deep: [1, 2, 3] };
  x.sections[0].extra_section_field = "whatever";
  let p;
  assert.doesNotThrow(() => { p = EngPlan.parseEngPlan(x); });
  // known fields still present and correct
  assert.equal(p.slug, "sample-plan");
  assert.equal(p.sections[0].id, "intro");
  // ignored-policy: unknown field not surfaced as a top-level typed prop
  assert.equal(p.mystery_field, undefined);
});

test("enum lists exported match the spec", () => {
  assert.deepEqual(EngPlan.SECTION_TYPES, ["prose", "task", "risk", "gate", "criteria", "evidence"]);
  assert.deepEqual(EngPlan.TASK_STATE, ["todo", "doing", "done", "blocked"]);
  assert.deepEqual(EngPlan.APPROVAL, ["none", "needs-human-review", "approved"]);
  assert.deepEqual(EngPlan.RISK, ["none", "risky", "security-sensitive"]);
});
