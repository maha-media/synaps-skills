/*
 * server_lifecycle.test.js — S0 lifecycle core: record, health, ensure/stop/
 * status, stale reap. Every hosted server is reaped in afterEach (no orphans).
 */
"use strict";
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const life = require("../../lib/server_lifecycle.js");

// ---- per-test repo + teardown bookkeeping ----
const repos = new Set();
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-life-"));
  fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
  repos.add(dir);
  return dir;
}

afterEach(async () => {
  // Reap any server this process hosted, then drop the temp repos.
  for (const dir of repos) { try { await life.stopServer(dir); } catch (_) {} }
  for (const dir of repos) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  repos.clear();
});

function get(port, p, token) {
  return new Promise((resolve) => {
    const u = "http://127.0.0.1:" + port + p + (token ? "?token=" + token : "");
    http.get(u, (res) => {
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString("utf8") }));
    }).on("error", () => resolve({ status: 0, text: "" }));
  });
}

test("ensureServer hosts one server and /api/health answers with the token", async () => {
  const repo = tmpRepo();
  const r = await life.ensureServer(repo);
  assert.equal(r.hosted, true, "first ensure hosts");
  assert.equal(r.reused, false);
  assert.ok(r.port > 0 && r.token, "has port + token");
  // record written
  const rec = life.readRecord(repo);
  assert.equal(rec.pid, process.pid, "record pid is this hosting process");
  assert.equal(rec.port, r.port);
  // health answers with token
  const h = await get(r.port, "/api/health", r.token);
  assert.equal(h.status, 200);
  const body = JSON.parse(h.text);
  assert.equal(body.ok, true);
  assert.equal(body.pid, process.pid);
  assert.equal(body.plans_dir, path.join(repo, ".plans"));
});

test("second ensureServer reuses the same url/token and hosts nothing", async () => {
  const repo = tmpRepo();
  const a = await life.ensureServer(repo);
  const b = await life.ensureServer(repo);
  assert.equal(b.reused, true, "second ensure reuses");
  assert.equal(b.hosted, false, "second ensure hosts nothing");
  assert.equal(b.url, a.url, "same url");
  assert.equal(b.token, a.token, "same token");
  assert.equal(b.port, a.port, "same port — exactly one listener");
});

test("stale record (dead pid) is reaped, then a fresh server is hosted", async () => {
  const repo = tmpRepo();
  // A guaranteed-dead pid: spawnSync's child has already exited on return.
  const dead = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(!life.isAlive(dead.pid), "spawned child pid is dead");
  life.writeRecord(repo, { pid: dead.pid, port: 65535, token: "bogus", url: "http://127.0.0.1:65535/", started_at: "x", plans_dir: path.join(repo, ".plans") });
  const r = await life.ensureServer(repo);
  assert.equal(r.hosted, true, "stale record reaped → fresh host");
  const rec = life.readRecord(repo);
  assert.equal(rec.pid, process.pid, "record now points at the live host");
  assert.notEqual(rec.port, 65535);
});

test("stopServer removes the record; serverStatus then reports 'down'", async () => {
  const repo = tmpRepo();
  await life.ensureServer(repo);
  assert.equal((await life.serverStatus(repo)).state, "running");
  const s = await life.stopServer(repo);
  assert.equal(s.removed, true);
  assert.equal(life.readRecord(repo), null, "record removed");
  assert.equal((await life.serverStatus(repo)).state, "down");
});

test("GET /api/health is token-gated (401 without token) and does no plan I/O", async () => {
  const repo = tmpRepo();
  const r = await life.ensureServer(repo);
  const noToken = await get(r.port, "/api/health", null);
  assert.equal(noToken.status, 401, "health requires the token");
  // No plan files should have been created by health probing.
  const planFiles = fs.readdirSync(path.join(repo, ".plans")).filter((f) => f.endsWith(".plan.html"));
  assert.equal(planFiles.length, 0, "health does no plan I/O");
});
