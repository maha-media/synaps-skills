"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const PlanRenderer = require("../../assets/plan.js");
const { makeDocument, makeWindow } = require("../harness/dom.js");

const VALID = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../fixtures/valid-plan.json"), "utf8")
);
function clone() { return JSON.parse(JSON.stringify(VALID)); }

function withFakeBrowser(fn) {
  const w = makeWindow();
  const savedLS = global.localStorage;
  const savedWin = global.window;
  const savedFetch = global.fetch;
  global.localStorage = w.localStorage;
  global.window = { __PLAN_TOKEN__: "" };
  // Simulate the file:// (no server) environment: no fetch available.
  delete global.fetch;
  try { return fn(w); }
  finally {
    if (savedLS === undefined) delete global.localStorage; else global.localStorage = savedLS;
    if (savedWin === undefined) delete global.window; else global.window = savedWin;
    if (savedFetch === undefined) delete global.fetch; else global.fetch = savedFetch;
  }
}

test("submitEvent (no fetch) persists a note to localStorage and is reloadable on fresh renderPlan", () => {
  withFakeBrowser(() => {
    const ctx = { slug: "sample-plan", author: "tester" /* NOTE: no fetch */ };
    const section = { id: "intro" };
    const ret = PlanRenderer.submitEvent(section, "comment", "offline note <b>hi</b>", ctx);
    assert.ok(ret, "submitEvent returns something");

    // raw localStorage holds the note keyed by slug+section
    const raw = global.localStorage.getItem("engplan:sample-plan:intro");
    assert.ok(raw, "localStorage entry written");
    const arr = JSON.parse(raw);
    assert.equal(arr.length, 1);
    assert.equal(arr[0].text, "offline note <b>hi</b>");
    assert.equal(arr[0].section_id, "intro");
    assert.equal(arr[0].type, "comment");

    // fresh renderPlan (no fetch) reads the localStorage note back into the thread
    const d = makeDocument();
    const app = d.createElement("div");
    PlanRenderer.renderPlan(app, clone(), { document: d /* no fetch -> offline mode */ });
    const intro = app.querySelector('[data-section-id="intro"]');
    const thread = intro.querySelector(".note-thread");
    assert.ok(thread, "thread present");
    const noteText = thread.querySelector(".note-text");
    assert.ok(noteText, "note rendered into thread");
    assert.equal(noteText.textContent, "offline note <b>hi</b>");
  });
});

test("notes round-trip across two reloads in the same browser", () => {
  withFakeBrowser(() => {
    const ctx = { slug: "sample-plan" };
    PlanRenderer.submitEvent({ id: "intro" }, "comment", "first", ctx);
    PlanRenderer.submitEvent({ id: "intro" }, "request_change", "second", ctx);

    const d = makeDocument();
    const app = d.createElement("div");
    PlanRenderer.renderPlan(app, clone(), { document: d });
    const notes = app.querySelector('[data-section-id="intro"]').querySelectorAll(".note-text");
    assert.equal(notes.length, 2);
    assert.equal(notes[0].textContent, "first");
    assert.equal(notes[1].textContent, "second");
  });
});
