"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ContractFreezer } = require(path.join(__dirname, "..", "..", "tools/oracle/freeze.js"));

const VALID = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", ".oracle/contract/contract.json"), "utf8"));

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "oracle-freeze-")); }
const fakeClock = () => { let n = 0; return { now: () => "2025-01-01T00:00:0" + (n++) + ".000Z" }; };

test("freeze: produces immutable hashed artifact + audit entry", () => {
  const d = tmp();
  const f = new ContractFreezer({ dir: path.join(d, "contract"), revealDir: path.join(d, "reveal"), clock: fakeClock() });
  const r = f.freeze(VALID, { role: "architect", lineage_id: "architect_1" });
  assert.match(r.hash, /^sha256:/);
  assert.ok(fs.existsSync(r.path));
  const cur = f.current();
  assert.equal(cur.hash, r.hash);
  assert.equal(f.history().length, 1);
  assert.equal(f.history()[0].event, "freeze");
});

test("freeze: re-freeze rejected unless controlled procedure", () => {
  const d = tmp();
  const f = new ContractFreezer({ dir: path.join(d, "contract"), revealDir: path.join(d, "reveal"), clock: fakeClock() });
  f.freeze(VALID, { role: "architect" });
  assert.throws(() => f.freeze(VALID, { role: "architect" }), (e) => e.category === "freeze-violation");
  // controlled re-freeze allowed
  const r2 = f.freeze(VALID, { role: "architect", refreeze: true });
  assert.ok(r2.hash);
  assert.equal(f.history().filter((h) => h.event === "refreeze").length, 1);
});

test("freeze: only architect lineage may freeze", () => {
  const d = tmp();
  const f = new ContractFreezer({ dir: path.join(d, "contract"), revealDir: path.join(d, "reveal"), clock: fakeClock() });
  assert.throws(() => f.freeze(VALID, { role: "builder" }), (e) => e.category === "lineage-violation");
  assert.throws(() => f.freeze(VALID, { role: "designer" }), (e) => e.category === "lineage-violation");
});

test("freeze: tampered frozen artifact detected on read", () => {
  const d = tmp();
  const f = new ContractFreezer({ dir: path.join(d, "contract"), revealDir: path.join(d, "reveal"), clock: fakeClock() });
  const r = f.freeze(VALID, { role: "architect" });
  const obj = JSON.parse(fs.readFileSync(r.path, "utf8"));
  obj.version = "9.9.9-tampered";
  fs.writeFileSync(r.path, JSON.stringify(obj));
  assert.throws(() => f.current(), (e) => e.category === "integrity-violation");
});
