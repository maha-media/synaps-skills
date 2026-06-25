"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CommitReveal } = require(path.join(__dirname, "..", "..", "tools/oracle/commit_reveal.js"));

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "oracle-fo-")); }
function bundle() {
  const d = tmp();
  fs.mkdirSync(path.join(d, "hidden"), { recursive: true });
  fs.writeFileSync(path.join(d, "hidden", "a.suite.js"), "x");
  return [{ tag: "hidden", path: path.join(d, "hidden") }];
}
const clk = () => { let n = 0; return { now: () => "2025-01-01T00:00:" + String(n++).padStart(2, "0") + ".000Z" }; };

test("freeze_order: a freeze before any commit is REJECTED (Builder could not peek)", () => {
  const cr = new CommitReveal({ revealDir: tmp(), clock: clk() });
  assert.throws(() => cr.freeze("sha256:impl", { round: 1 }), (e) => e.category === "ordering-violation");
});

test("freeze_order: commit→freeze accepted in order", () => {
  const cr = new CommitReveal({ revealDir: tmp(), clock: clk() });
  cr.commit(bundle(), { round: 1 });
  const f = cr.freeze("sha256:impl", { round: 1 });
  assert.equal(f.event, "freeze");
});

test("freeze_order: reveal before freeze is REJECTED", () => {
  const cr = new CommitReveal({ revealDir: tmp(), clock: clk() });
  const b = bundle();
  cr.commit(b, { round: 1 });
  assert.throws(() => cr.reveal(b, { round: 1 }), (e) => e.category === "ordering-violation");
});

test("freeze_order: commit after freeze is REJECTED", () => {
  const cr = new CommitReveal({ revealDir: tmp(), clock: clk() });
  const b = bundle();
  cr.commit(b, { round: 1 });
  cr.freeze("sha256:impl", { round: 1 });
  assert.throws(() => cr.commit(b, { round: 1 }), (e) => e.category === "ordering-violation");
});
