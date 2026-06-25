/*
 * watch.test.js — P2-1: lib/watch.js watchPlans computes a section-id delta on
 * change. Deterministic: we seed a snapshot then drive _process(file) directly
 * to avoid fs.watch timing flakiness.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { watchPlans } = require("../../lib/watch.js");

function artifact(sections) {
  return [
    "<!doctype html><html><head></head><body>",
    '<script id="plan" type="application/json">',
    JSON.stringify({ schema: "engplan/1", kind: "plan", slug: "demo", title: "Demo", status: "drafting", sections }, null, 2),
    "</script><div id=app></div></body></html>",
  ].join("\n");
}

test("watchPlans onChange fires with slug + section-id delta on modify", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engplan-watch-"));
  const file = "demo.plan.html";
  const full = path.join(dir, file);
  // initial state: one section s1
  fs.writeFileSync(full, artifact([{ id: "s1", heading: "S1", type: "prose", md: "a" }]));

  const seen = [];
  const w = watchPlans(dir, (chg) => seen.push(chg), { debounceMs: 5 });
  try {
    // modify: change s1 body AND add s2
    fs.writeFileSync(full, artifact([
      { id: "s1", heading: "S1", type: "prose", md: "b" },
      { id: "s2", heading: "S2", type: "task", md: "new" },
    ]));
    w._process(file); // deterministic, bypass fs.watch

    assert.equal(seen.length, 1, "exactly one change emitted");
    const chg = seen[0];
    assert.equal(chg.slug, "demo", "slug derived from filename");
    assert.ok(chg.changed.includes("s1"), "modified section reported");
    assert.ok(chg.changed.includes("s2"), "added section reported");
    assert.equal(chg.removed.length, 0);
    assert.equal(chg.full, false, "a real delta is not a full refresh");
  } finally {
    w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watchPlans signals full refresh when artifact JSON is unparseable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engplan-watch-"));
  const file = "demo.plan.html";
  fs.writeFileSync(path.join(dir, file), artifact([{ id: "s1", heading: "S1", type: "prose", md: "a" }]));
  const seen = [];
  const w = watchPlans(dir, (chg) => seen.push(chg), { debounceMs: 5 });
  try {
    fs.writeFileSync(path.join(dir, file), "<html>no plan json here</html>");
    w._process(file);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].full, true, "unparseable artifact → full refresh");
  } finally {
    w.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
