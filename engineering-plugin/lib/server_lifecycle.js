/*
 * server_lifecycle.js — at-most-one-plans-server-per-repo coordination.
 *
 * A gitignored server record (.plans/.server.json) plus an O_EXCL lock
 * (.plans/.server.lock) let independent processes converge on a SINGLE live
 * HTTP server per repo. The owning (hosting) process keeps the server in its
 * own event loop for the lifetime of that process — NO detached daemon, NO
 * .unref(), never handed to another process. A non-owner only ever READS the
 * recorded {url, token} and hosts nothing.
 *
 *   ensureServer(repoRoot, { createServer })  reuse-or-host (parent-bound)
 *   stopServer(repoRoot)                       close in-proc server / reap record
 *   serverStatus(repoRoot)                     { state: running|stale|down, ... }
 *   reapStale(repoRoot)                        drop a dead/unhealthy record
 *   readRecord / writeRecord / removeRecord / recordPath / lockPath
 *   isAlive(pid) / health(port, token, ms)
 *
 * Node stdlib only. Loopback-only, token-gated. Plan S0.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const PLUGIN_DIR = path.join(__dirname, "..");

// Servers this process is hosting, keyed by resolved repoRoot. Lets stopServer
// close the exact in-process listener and lets us avoid double-hosting.
const HOSTED = new Map();
// repoRoots for which we've registered process-exit record cleanup.
const CLEANUP_REGISTERED = new Set();

const DEFAULTS = {
  healthTimeoutMs: 500,
  lockTimeoutMs: 5000,
  lockStaleMs: 15000,
  lockRetryMs: 25,
};

function plansDir(repoRoot) { return path.join(path.resolve(repoRoot), ".plans"); }
function recordPath(repoRoot) { return path.join(plansDir(repoRoot), ".server.json"); }
function lockPath(repoRoot) { return path.join(plansDir(repoRoot), ".server.lock"); }
function nowISO() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---- record persistence ----
function readRecord(repoRoot) {
  try {
    const rec = JSON.parse(fs.readFileSync(recordPath(repoRoot), "utf8"));
    return rec && typeof rec === "object" ? rec : null;
  } catch (_) { return null; }
}

function writeRecord(repoRoot, rec) {
  const p = recordPath(repoRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

function removeRecord(repoRoot) {
  try { fs.unlinkSync(recordPath(repoRoot)); } catch (_) { /* already gone */ }
}

// ---- liveness ----
// process.kill(pid, 0): throws ESRCH if no such process, EPERM if alive but not
// ours (still alive). Anything else → treat as dead.
function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

// GET /api/health on a recorded server. Resolves the parsed body on a 200 ok
// response, else null (never throws).
function health(port, token, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const u = "http://127.0.0.1:" + port + "/api/health?token=" + encodeURIComponent(token || "");
    const req = http.get(u, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) return finish(null);
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(body && body.ok ? body : null);
        } catch (_) { finish(null); }
      });
    });
    req.on("error", () => finish(null));
    req.setTimeout(timeoutMs || DEFAULTS.healthTimeoutMs, () => { try { req.destroy(); } catch (_) {} finish(null); });
  });
}

// A record is "live" iff its pid is alive AND its server answers /api/health
// with the matching token and pid. Token match alone proves it is OUR server
// (only our process knows the token); the pid cross-check is belt-and-braces.
async function verifyLive(rec, opts) {
  if (!rec || !rec.pid || !rec.port || !rec.token) return false;
  if (!isAlive(rec.pid)) return false;
  const h = await health(rec.port, rec.token, (opts && opts.healthTimeoutMs) || DEFAULTS.healthTimeoutMs);
  return !!(h && h.ok && h.pid === rec.pid);
}

// ---- stale reaping ----
async function reapStale(repoRoot, opts) {
  const rec = readRecord(repoRoot);
  if (!rec) return false;
  if (await verifyLive(rec, opts)) return false;
  removeRecord(repoRoot);
  return true;
}

// ---- hosting ----
function hostServer(repoRoot, opts) {
  const factory = (opts && opts.createServer) || require("../extensions/plans_server.js").createServer;
  const server = factory(Object.assign({
    repoRoot,
    pluginDir: (opts && opts.pluginDir) || PLUGIN_DIR,
    startedAt: nowISO(),
  }, (opts && opts.serverOpts) || {}));
  return new Promise((resolve) => server.listen(() => resolve(server)));
}

function registerProcessCleanup(repoRoot) {
  const key = path.resolve(repoRoot);
  if (CLEANUP_REGISTERED.has(key)) return;
  CLEANUP_REGISTERED.add(key);
  // Remove the record when THIS hosting process exits (parent-bound teardown).
  process.once("exit", () => { if (HOSTED.has(key)) removeRecord(key); });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.once(sig, () => {
      const srv = HOSTED.get(key);
      if (srv) { try { srv.close(() => {}); } catch (_) {} }
      removeRecord(key);
      // Re-raise default disposition so the parent's teardown semantics hold.
      process.exit(0);
    });
  }
}

function recordFor(server, repoRoot) {
  return {
    pid: process.pid,
    port: server.port,
    token: server.token,
    url: server.url,
    started_at: server.startedAt || nowISO(),
    plans_dir: plansDir(repoRoot),
  };
}

function reuseResult(rec) {
  return { url: rec.url, token: rec.token, port: rec.port, pid: rec.pid, reused: true, hosted: false };
}

// ---- O_EXCL lock with double-checked reuse ----
const REUSED = Symbol("reused-while-waiting");

// Acquire the lock. While contending, keep re-reading the record: if a live
// server appears we abandon the lock attempt and signal the caller to reuse.
async function acquireLock(repoRoot, opts) {
  const lp = lockPath(repoRoot);
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const deadline = Date.now() + cfg.lockTimeoutMs;
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(lp, "wx");
      try { fs.writeSync(fd, String(process.pid)); } catch (_) {}
      return fd;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Someone else holds the lock. If they've already published a live
      // server, reuse it instead of waiting for the lock.
      if (await verifyLive(readRecord(repoRoot), opts)) return REUSED;
      // Break a genuinely stale lock (holder died mid-host).
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lp).mtimeMs; } catch (_) {}
      if (age > cfg.lockStaleMs) { try { fs.unlinkSync(lp); } catch (_) {} continue; }
      if (Date.now() > deadline) { try { fs.unlinkSync(lp); } catch (_) {} continue; }
      await sleep(cfg.lockRetryMs);
    }
  }
}

function releaseLock(repoRoot, fd) {
  if (fd != null && fd !== REUSED) { try { fs.closeSync(fd); } catch (_) {} }
  try { fs.unlinkSync(lockPath(repoRoot)); } catch (_) {}
}

// ---- the core: reuse-or-host ----
async function ensureServer(repoRoot, opts) {
  opts = opts || {};
  const key = path.resolve(repoRoot);

  // Fast path: a live+healthy record → reuse, host nothing.
  let rec = readRecord(key);
  if (await verifyLive(rec, opts)) return reuseResult(rec);

  // Serialize hosting behind the lock; double-check after acquiring.
  const fd = await acquireLock(key, opts);
  if (fd === REUSED) {
    rec = readRecord(key);
    if (await verifyLive(rec, opts)) return reuseResult(rec);
    // Record vanished after the holder released — fall through to host.
  }
  try {
    rec = readRecord(key);
    if (await verifyLive(rec, opts)) return reuseResult(rec);
    removeRecord(key); // reap any dead/unhealthy record

    const server = await hostServer(key, opts);
    const record = recordFor(server, key);
    writeRecord(key, record);
    HOSTED.set(key, server);
    registerProcessCleanup(key);
    return { url: record.url, token: record.token, port: record.port, pid: record.pid, reused: false, hosted: true, server };
  } finally {
    releaseLock(key, fd);
  }
}

// ---- stop / status ----
async function stopServer(repoRoot, opts) {
  const key = path.resolve(repoRoot);
  const own = HOSTED.get(key);
  if (own) {
    await new Promise((resolve) => { try { own.close(() => resolve()); } catch (_) { resolve(); } });
    HOSTED.delete(key);
    removeRecord(key);
    return { stopped: true, removed: true, hosted: true };
  }
  // Not hosted here: only signal a VERIFIED record (never blind-kill).
  const rec = readRecord(key);
  if (await verifyLive(rec, opts)) {
    try { process.kill(rec.pid, "SIGTERM"); } catch (_) {}
    removeRecord(key);
    return { stopped: true, removed: true, signaled: true };
  }
  const had = !!rec;
  removeRecord(key);
  return { stopped: false, removed: had };
}

async function serverStatus(repoRoot, opts) {
  const rec = readRecord(path.resolve(repoRoot));
  if (!rec) return { state: "down" };
  if (await verifyLive(rec, opts)) return Object.assign({ state: "running" }, rec);
  return Object.assign({ state: "stale" }, rec);
}

module.exports = {
  recordPath, lockPath, readRecord, writeRecord, removeRecord,
  isAlive, health, verifyLive, reapStale,
  ensureServer, stopServer, serverStatus,
  // exposed for tests / harness
  _HOSTED: HOSTED, DEFAULTS, plansDir,
};
