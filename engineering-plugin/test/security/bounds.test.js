/*
 * bounds.test.js — P4-SEC-5: resource bounds. Oversized POST body rejected;
 * per-plan event cap enforced; discovery scan bounded by maxFiles.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { withServer } = require("../harness/runner.js");
const discovery = require("../../lib/discovery.js");

function artifact(slug) {
  return [
    "<!doctype html><html><head></head><body>",
    '<script id="plan" type="application/json">',
    JSON.stringify({ schema: "engplan/1", kind: "plan", slug, title: slug, status: "drafting", sections: [{ id: "s1", heading: "h", type: "prose", md: "x" }] }, null, 2),
    "</script><div id=app></div></body></html>",
  ].join("\n");
}

test("oversized POST body rejected (413)", async () => {
  await withServer(async (ctx) => {
    const huge = "y".repeat(300 * 1024);
    const body = JSON.stringify({ plan_id: "p", section_id: "s1", type: "comment", actor: "human", text: huge });
    const status = await new Promise((resolve, reject) => {
      const u = new URL("/api/notes", ctx.base);
      u.searchParams.set("token", ctx.token);
      const r = http.request(u, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode); });
      r.on("error", reject);
      r.write(body);
      r.end();
    });
    assert.equal(status, 413);
  });
});

test("event cap enforced", async () => {
  await withServer({ serverOpts: { limits: { maxEventsPerPlan: 1 } } }, async (ctx) => {
    const mk = (n) => ctx.client.post("/api/notes", { plan_id: "p", section_id: "s1", type: "comment", actor: "human", text: "n" + n });
    assert.equal((await mk(1)).status, 200);
    assert.equal((await mk(2)).status, 413, "second event past cap rejected");
  });
});

test("discovery bounded by maxFiles → truncated", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "engplan-bounds-"));
  const plansDir = path.join(repo, ".plans");
  fs.mkdirSync(plansDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(plansDir, "a.plan.html"), artifact("a"));
    fs.writeFileSync(path.join(plansDir, "b.plan.html"), artifact("b"));

    const out = discovery.discover(repo, { limits: { maxFiles: 1 } });
    assert.equal(out.truncated, true, "scan should report truncation at the bound");
    assert.ok(out.plans.length <= 1, "scan stops at maxFiles, got " + out.plans.length);

    // unbounded control: both discovered
    const full = discovery.discover(repo, {});
    assert.equal(full.plans.length, 2);
    assert.equal(full.truncated, false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
