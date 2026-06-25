"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AuditTrail } = require(path.join(__dirname, "..", "..", "tools/oracle/audit.js"));

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "oracle-audit-")); }
const clk = () => { let n = 0; return { now: () => "2025-01-01T00:00:" + String(n++).padStart(2, "0") + ".000Z" }; };

test("audit_trail: freeze/commit/reveal/verdict appended immutably with lineage+time", () => {
  const a = new AuditTrail({ dir: tmp(), clock: clk() });
  a.append("commit", { round: 1, hash: "sha256:x" }, "designer");
  a.append("freeze", { round: 1, impl_hash: "sha256:y" }, "builder");
  a.append("verdict", { round: 1, counts: { pass: 5, fail: 0 } }, "tester");
  const recs = a.records();
  assert.equal(recs.length, 3);
  assert.equal(recs[0].lineage, "designer");
  assert.ok(recs[0].ts);
});

test("audit_trail: replay reconstructs a round's history", () => {
  const a = new AuditTrail({ dir: tmp(), clock: clk() });
  a.append("commit", { round: 1 });
  a.append("commit", { round: 2 });
  a.append("reveal", { round: 1, verified: true });
  assert.equal(a.replay(1).length, 2);
});

test("audit_trail: Plan Inbox oracle-status carries counts/categories only, no hidden source", () => {
  const dir = tmp(); const plans = tmp();
  const a = new AuditTrail({ dir, plansDir: plans, clock: clk() });
  const surfaced = a.surface("my-plan", { round: 1, state: "not-done", counts: { pass: 8, fail: 2 }, categories: [{ category: "property-violation", count: 2 }], score: 0.7 });
  assert.equal(surfaced.kind, "oracle-status");
  assert.deepEqual(surfaced.categories, ["property-violation"]);
  const f = path.join(plans, "my-plan.oracle.jsonl");
  const written = fs.readFileSync(f, "utf8");
  assert.ok(!/assert|expect|it\(|module\.exports/.test(written), "no hidden source in inbox");
});

test("audit_trail: a leaky payload is rejected", () => {
  const a = new AuditTrail({ dir: tmp(), clock: clk() });
  assert.throws(() => a.append("verdict", { round: 1, note: "expected: secret, actual: 7" }), (e) => e.category === "egress-leak");
});
