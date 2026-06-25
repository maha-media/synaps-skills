/*
 * domprobe.js — DomProbe (Addendum A.2, H-1). Loads the renderer against a
 * fixed engplan/1 doc in the headless DOM shim and exposes assertion helpers
 * for rendered structure, badges, counters, action affordances — no real browser.
 */
"use strict";
const { makeDocument, makeWindow } = require("./dom.js");
const PlanRenderer = require("../../assets/plan.js");

class DomProbe {
  constructor(opts) {
    opts = opts || {};
    this.doc = makeDocument();
    this.window = makeWindow(this.doc);
    this.app = this.doc.createElement("div");
    this.app.setAttribute("id", "app");
    this.doc.body.appendChild(this.app);
    this.plan = null;
    this.opts = opts;
  }

  render(plan, renderOpts) {
    this.plan = PlanRenderer.renderPlan(this.app, plan, Object.assign({ document: this.doc }, renderOpts || {}));
    return this;
  }
  patch(patch) {
    PlanRenderer.applySectionPatch(this.plan, patch, this.app, { document: this.doc });
    return this;
  }
  section(id) { return this.app.querySelector('[data-section-id="' + id + '"]'); }
  sectionIds() { return this.app.querySelectorAll(".plan-section").map((n) => n.getAttribute("data-section-id")); }
  badges(id) { return this.section(id).querySelectorAll(".badge").map((b) => b.textContent); }
  actionOptions(id) { return this.section(id).querySelectorAll(".action-type option").map((o) => o.getAttribute("value")); }
  noteTexts(id) { return this.section(id).querySelectorAll(".note-text").map((n) => ({ text: n.textContent, html: n.innerHTML })); }
  serialize() { return this.app.serialize(); }
  hasExecutableScript() { return /<script\b/i.test(this.serialize()); }
}

module.exports = { DomProbe };
