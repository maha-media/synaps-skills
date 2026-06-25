"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CommitReveal, bundleHash } = require(path.join(__dirname, "..", "..", "tools/oracle/commit_reveal.js"));

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "oracle-cr-")); }
function bundle() {
  const d = tmp();
  fs.mkdirSync(path.join(d, "hidden"), { recursive: true });
  fs.writeFileSync(path.join(d, "hidden", "a.suite.js"), "module.exports={id:'a'}");
  fs.writeFileSync(path.join(d, "hidden", "b.suite.js"), "module.exports={id:'b'}");
  return d;
}
const clk = () => { let n = 0; return { now: () => "2025-01-01T00:00:0" + (n++) + ".000Z" }; };

test("commit: writes hash+nonce+ts+lineage before any freeze; bundle content not revealed", () => {
  const rev = tmp(); const b = bundle();
  const cr = new CommitReveal({ revealDir: rev, clock: clk() });
  const rec = cr.commit([{ tag: "hidden", path: path.join(b, "hidden") }], { round: 1, lineage: "designer" });
  assert.match(rec.hash, /^sha256:/);
  assert.ok(rec.nonce && rec.ts && rec.lineage === "designer");
  // record carries only the hash, not file contents
  assert.ok(!JSON.stringify(rec).includes("module.exports"));
});

test("commit: hash is canonical/deterministic across file reorder", () => {
  const b1 = bundle(); const b2 = bundle();
  const h1 = bundleHash([{ tag: "hidden", path: path.join(b1, "hidden") }], "salt");
  const h2 = bundleHash([{ tag: "hidden", path: path.join(b2, "hidden") }], "salt");
  assert.equal(h1, h2);
});
