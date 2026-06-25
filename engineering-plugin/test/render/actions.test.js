"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const PlanRenderer = require("../../assets/plan.js");
const EngPlan = require("../../assets/engplan.js");
const { makeDocument } = require("../harness/dom.js");

function basePlan() {
  return {
    schema: "engplan/1", kind: "plan", slug: "act-plan", title: "Act Plan",
    status: "in_progress", sections: [
      { id: "task1", heading: "Task One", type: "task", state: "todo", md: "do it" },
    ],
  };
}

test("each section renders action UI: select.action-type, textarea.action-text, button.action-submit", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  PlanRenderer.renderPlan(app, basePlan(), { document: d });
  const sec = app.querySelector('[data-section-id="task1"]');
  assert.ok(sec.querySelector("select.action-type"), "action-type select");
  assert.ok(sec.querySelector("textarea.action-text"), "action-text textarea");
  assert.ok(sec.querySelector("button.action-submit"), "action-submit button");
});

test("select.action-type contains every EngPlan.EVENT_TYPES as an <option>", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  PlanRenderer.renderPlan(app, basePlan(), { document: d });
  const sel = app.querySelector("select.action-type");
  const options = sel.querySelectorAll("option");
  const values = options.map((o) => o.getAttribute("value"));
  // 14 actions + comment = 15
  assert.equal(EngPlan.EVENT_TYPES.length, 15);
  assert.equal(options.length, EngPlan.EVENT_TYPES.length);
  for (const t of EngPlan.EVENT_TYPES) {
    assert.ok(values.includes(t), "option present for action: " + t);
  }
});

test("note text is shown via textContent (inert) and does not produce an executable <script>", () => {
  const d = makeDocument();
  const app = d.createElement("div");
  const xss = '<script>alert(1)</script>';
  const ev = {
    id: "e1", plan_id: "act-plan", section_id: "task1", type: "comment",
    actor: "human", author: "attacker", text: xss, status: "open",
  };
  PlanRenderer.renderPlan(app, basePlan(), { document: d, events: [ev] });
  const note = app.querySelector('[data-section-id="task1"] .note-text');
  assert.ok(note, "note rendered");
  // textContent holds the raw string verbatim (inert)
  assert.equal(note.textContent, xss);
  // innerHTML does NOT contain an executable <script> element
  assert.ok(!/<script/i.test(note.innerHTML), "no live <script> in innerHTML: " + note.innerHTML);
});
