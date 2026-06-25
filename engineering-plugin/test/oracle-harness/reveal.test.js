"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CommitReveal } = require(path.join(__dirname, "..", "..", "tools/oracle/commit_reveal.js"));

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "oracle-rv-")); }
function bundleDir() {
  const d = tmp();
  fs.mkdirSync(path.join(d, "hidden"), { recursive: true });
  fs.writeFileSync(path.join(d, "hidden", "a.suite.js"), "STRONG ASSERTION");
  return path.join(d, "hidden");
}
const clk = () => { let n = 0; return { now: () => "2025-01-01T00:00:" + String(n++).padStart(2, "0") + ".000Z" }; };

test("reveal: an unmodified bundle verifies OK + records verified=true", () => {
  const cr = new CommitReveal({ revealDir: tmp(), clock: clk() });
  const hidden = bundleDir();
  const dirs = [{ tag: "hidden", path: hidden }];
  cr.commit(dirs, { round: 1 });
  cr.freeze("sha256:impl", { round: 1 });
  const r = cr.reveal(dirs, { round: 1 });
  assert.equal(r.verified, true);
  assert.equal(cr.records().slice(-1)[0].event, "reveal");
});

test("reveal: a post-freeze-WEAKENED bundle is REJECTED (anti post-hoc adaptation)", () => {
  const cr = new CommitReveal({ revealDir: tmp(), clock: clk() });
  const hidden = bundleDir();
  const dirs = [{ tag: "hidden", path: hidden }];
  cr.commit(dirs, { round: 1 });
  cr.freeze("sha256:impl", { round: 1 });
  // Designer weakens the hidden suite AFTER seeing code:
  fs.writeFileSync(path.join(hidden, "a.suite.js"), "weakened: assert(true)");
  assert.throws(() => cr.reveal(dirs, { round: 1 }), (e) => e.category === "reveal-mismatch");
  // the failed reveal is still recorded for audit
  const last = cr.records().slice(-1)[0];
  assert.equal(last.event, "reveal");
  assert.equal(last.verified, false);
});
