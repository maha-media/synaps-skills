/*
 * plan_cli.test.js — S2: CLI status/down + reuse in open/new.
 *  - planStatus reports running/stale/down from the record + health
 *  - planDown stops/removes the recorded server; status then 'down'
 *  - planOpen reuses a live server (same port) instead of spawning a second
 *  - planServeForeground still hosts a foreground dev server
 * Every host reaped in afterEach (no orphans).
 */
"use strict";
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const plan = require("../../bin/plan.js");
const life = require("../../lib/server_lifecycle.js");

const repos = new Set();
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-cli-s2-"));
  fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
  repos.add(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of repos) { try { await life.stopServer(dir); } catch (_) {} }
  for (const dir of repos) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  repos.clear();
});

test("planStatus reports 'down' with no record, 'running' once hosted", async () => {
  const repo = tmpRepo();
  assert.equal((await plan.planStatus(repo)).state, "down");
  const r = await plan.ensurePlanServer(repo);
  assert.equal(r.hosted, true);
  const st = await plan.planStatus(repo);
  assert.equal(st.state, "running");
  assert.equal(st.port, r.port);
});

test("planStatus reports 'stale' for a dead-pid record", async () => {
  const repo = tmpRepo();
  life.writeRecord(repo, { pid: 2147480000, port: 65535, token: "x", url: "http://127.0.0.1:65535/?token=x", started_at: new Date().toISOString(), plans_dir: path.join(repo, ".plans") });
  assert.equal((await plan.planStatus(repo)).state, "stale");
});

test("planDown stops/removes the recorded server; status then 'down'", async () => {
  const repo = tmpRepo();
  await plan.ensurePlanServer(repo);
  assert.equal((await plan.planStatus(repo)).state, "running");
  const d = await plan.planDown(repo);
  assert.equal(d.stopped, true);
  assert.equal((await plan.planStatus(repo)).state, "down");
  assert.equal(life.readRecord(repo), null);
});

test("planOpen reuses a live server (same port), hosts nothing second time", async () => {
  const repo = tmpRepo();
  const first = await plan.planOpen(repo, "demo-slug", { open: false });
  assert.equal(first.hosted, true);
  assert.match(first.openUrl, /\/plan\/demo-slug\?token=/);
  const second = await plan.planOpen(repo, "demo-slug", { open: false });
  assert.equal(second.reused, true);
  assert.equal(second.hosted, false);
  assert.equal(second.port, first.port);
});

test("planServeForeground hosts a foreground dev server (own listener, no record reuse)", async () => {
  const repo = tmpRepo();
  const srv = await plan.planServeForeground(repo);
  assert.ok(srv.url);
  assert.ok(srv.port);
  // foreground/dev mode is intentionally NOT the singleton record path
  await new Promise((res) => srv.close(res));
});
