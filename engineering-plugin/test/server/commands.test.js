"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cmd = require("../../bin/plan.js");

function tmpRepo() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "plancmd-")); fs.mkdirSync(path.join(d, ".plans"), { recursive: true }); return d; }
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }

test("plan new scaffolds .plans/, _assets fallback, artifact, self-connects (P4-2)", () => {
  const repo = tmpRepo();
  try {
    const r = cmd.planNew(repo, "plan", "demo-x", { title: "Demo X" });
    assert.ok(fs.existsSync(r.file), "artifact created");
    assert.ok(fs.existsSync(path.join(repo, ".plans", "_assets", "plan.js")), "fallback plan.js copied");
    assert.ok(fs.existsSync(path.join(repo, ".plans", "_assets", "plan.css")), "fallback css copied");
    const txt = fs.readFileSync(r.file, "utf8");
    assert.match(txt, /id="plan"/, "embeds plan JSON");
    assert.match(txt, /\/_assets\/plan\.js/, "server-mode asset path");
    assert.match(txt, /\.\/_assets\/plan\.js/, "static fallback asset path");
  } finally { rmrf(repo); }
});

test("plan new rejects bad kind/slug", () => {
  const repo = tmpRepo();
  try {
    assert.throws(() => cmd.planNew(repo, "bogus", "x"));
    assert.throws(() => cmd.planNew(repo, "plan", "../evil"));
  } finally { rmrf(repo); }
});

test("plan list shows attention counters per plan (P4-2)", () => {
  const repo = tmpRepo();
  try {
    cmd.planNew(repo, "plan", "a-plan", { title: "A" });
    cmd.planNew(repo, "spec", "b-spec", { title: "B" });
    const plans = cmd.planList(repo);
    assert.equal(plans.length, 2);
    assert.ok(plans.every((p) => p.attention && typeof p.attention.blocking === "number"));
  } finally { rmrf(repo); }
});

test("plan reconcile runs a reconcile pass and persists (P4-2)", () => {
  const repo = tmpRepo();
  try {
    cmd.planNew(repo, "plan", "rec", { title: "R", sections: [{ id: "s1", heading: "S1", type: "task", state: "todo" }] });
    const store = require("../../lib/store.js");
    store.appendEvent(repo, "rec", { plan_id: "rec", section_id: "s1", type: "comment", actor: "human", text: "hi" });
    const out = cmd.planReconcile(repo, "rec");
    assert.ok(out.events[0].status === "incorporated" || out.events[0].agent_status, "event resolved");
    const onDisk = JSON.parse(fs.readFileSync(path.join(repo, ".plans", "rec.events.json"), "utf8"));
    assert.ok(onDisk[0].agent_response, "agent_response persisted");
  } finally { rmrf(repo); }
});

test("plan serve / open start a loopback server and report URL (P4-2)", async () => {
  const repo = tmpRepo();
  try {
    cmd.planNew(repo, "plan", "srv", { title: "S" });
    await new Promise((resolve, reject) => {
      cmd.startServer(repo, (srv) => {
        try {
          assert.equal(srv.httpServer.address().address, "127.0.0.1");
          assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\//);
          srv.close(() => resolve());
        } catch (e) { srv.close(() => reject(e)); }
      });
    });
  } finally { rmrf(repo); }
});
