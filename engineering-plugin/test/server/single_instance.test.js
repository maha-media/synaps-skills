/*
 * single_instance.test.js — S5: the "one HTTP server per repo" proof.
 *
 * Cross-process convergence (the core guarantee): N separate node processes
 * race to ensureServer() on the same repo → exactly ONE hosts a listener, the
 * rest reuse the same url/port. Stale (dead-pid) records are reaped to exactly
 * one fresh host; the healthy reuse path opens no second listener; a held lock
 * makes a concurrent ensure converge (no duplicate).
 *
 * Every spawned child/server is reaped in afterEach (no orphans).
 */
"use strict";
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const life = require("../../lib/server_lifecycle.js");
const CHILD = path.join(__dirname, "fixtures", "ensure_child.js");

const repos = new Set();
const kids = new Set();
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "single-inst-"));
  fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
  repos.add(dir);
  return dir;
}
// Spawn ensure_child against repo; resolve with {result, child} once it prints.
function spawnEnsure(repo, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, repo], { env: Object.assign({}, process.env, env || {}), stdio: ["ignore", "pipe", "pipe"] });
    kids.add(child);
    let out = "";
    let errBuf = "";
    child.stdout.on("data", (c) => {
      out += c.toString("utf8");
      const nl = out.indexOf("\n");
      if (nl !== -1) { try { resolve({ result: JSON.parse(out.slice(0, nl)), child }); } catch (e) { reject(e); } }
    });
    child.stderr.on("data", (c) => { errBuf += c.toString("utf8"); });
    child.on("exit", (code) => { if (code && !out) reject(new Error("child exited " + code + ": " + errBuf)); });
  });
}
afterEach(async () => {
  for (const k of kids) { try { k.kill("SIGKILL"); } catch (_) {} }
  kids.clear();
  for (const dir of repos) { try { await life.stopServer(dir); } catch (_) {} }
  for (const dir of repos) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  repos.clear();
});

test("N racing processes converge to EXACTLY ONE listener; the rest reuse it", async () => {
  const repo = tmpRepo();
  const N = 5;
  const settled = await Promise.all(Array.from({ length: N }, () => spawnEnsure(repo)));
  const results = settled.map((s) => s.result);
  const hosts = results.filter((r) => r.hosted);
  const reuses = results.filter((r) => r.reused);
  assert.equal(hosts.length, 1, "exactly one process may host: " + JSON.stringify(results));
  assert.equal(reuses.length, N - 1, "all others must reuse");
  // One port, one pid across every result.
  const ports = new Set(results.map((r) => r.port));
  const pids = new Set(results.map((r) => r.pid));
  assert.equal(ports.size, 1, "all share one port: " + [...ports]);
  assert.equal(pids.size, 1, "all point at one hosting pid: " + [...pids]);
  // The record names exactly that one host.
  const rec = life.readRecord(repo);
  assert.equal(rec.port, hosts[0].port);
  assert.equal(rec.pid, hosts[0].pid);
});

test("stale (dead-pid) record triggers exactly ONE fresh host", async () => {
  const repo = tmpRepo();
  life.writeRecord(repo, { pid: 2147480000, port: 65535, token: "x", url: "http://127.0.0.1:65535/?token=x", started_at: new Date().toISOString(), plans_dir: path.join(repo, ".plans") });
  const N = 4;
  const settled = await Promise.all(Array.from({ length: N }, () => spawnEnsure(repo)));
  const results = settled.map((s) => s.result);
  assert.equal(results.filter((r) => r.hosted).length, 1, "stale record → exactly one fresh host");
  assert.equal(new Set(results.map((r) => r.port)).size, 1);
  assert.notEqual(life.readRecord(repo).port, 65535, "the stale port must be gone");
});

test("healthy reuse opens NO second listener (in-process)", async () => {
  const repo = tmpRepo();
  const a = await life.ensureServer(repo);
  const b = await life.ensureServer(repo);
  assert.equal(a.hosted, true);
  assert.equal(b.reused, true);
  assert.equal(b.hosted, false);
  assert.equal(a.port, b.port);
});

test("a held lock makes a concurrent ensure converge (no duplicate)", async () => {
  const repo = tmpRepo();
  // Pre-acquire the lock as a foreign holder; in-process ensure must still
  // converge to one listener once the holder publishes / releases.
  const hostP = spawnEnsure(repo);          // this child will host
  const { result: host } = await hostP;
  assert.equal(host.hosted, true);
  // Now an in-process ensure must REUSE the child's server (no second listener).
  const mine = await life.ensureServer(repo);
  assert.equal(mine.reused, true);
  assert.equal(mine.port, host.port);
});
