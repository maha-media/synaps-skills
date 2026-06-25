"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DomProbe } = require("./domprobe.js");
const { SCENARIOS } = require("./scenarios.js");
const EngPlan = require("../../assets/engplan.js");

test("H-1: DomProbe asserts sections, badges, action affordances from engplan/1", () => {
  const probe = new DomProbe();
  probe.render({ schema:"engplan/1", kind:"plan", slug:"p", title:"P", status:"in_progress",
    sections:[{id:"t1",heading:"T1",type:"task",state:"doing",risk:"risky",acceptance:["a"],md:"**b**"}] });
  assert.deepEqual(probe.sectionIds(), ["t1"]);
  const badges = probe.badges("t1");
  assert.ok(badges.includes("doing"), "state badge");
  assert.ok(badges.includes("risky"), "risk badge");
  assert.equal(probe.actionOptions("t1").length, EngPlan.EVENT_TYPES.length, "all action affordances present");
});

test("H-1: DomProbe finds no executable script for stored-XSS note", () => {
  const probe = new DomProbe();
  probe.render({ schema:"engplan/1", kind:"plan", slug:"p", title:"P", status:"drafting",
    sections:[{id:"s",heading:"S",type:"prose",md:"x"}] }, { events:[{id:"e",plan_id:"p",section_id:"s",type:"comment",actor:"human",author:"a",text:"<script>alert(1)</script>",status:"open"}] });
  assert.equal(probe.hasExecutableScript(), false, "no live <script> in rendered DOM");
});

test("H-1/S10: legacy markdown renders degraded", async () => { await SCENARIOS.S10.fn({ control:false }); });
