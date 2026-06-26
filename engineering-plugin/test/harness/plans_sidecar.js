#!/usr/bin/env node
/*
 * plans_sidecar.js — unattended, parent-bound merge-gate harness for the plans
 * server sidecar (plan: plans-server-sidecar, S6). NO human in the loop.
 *
 * Drives a REAL sidecar child over the v2 newline-delimited JSON frames and
 * proves the whole guarantee end to end:
 *   [1] init → trigger{plans} → a url-bearing status/insert_text + /api/health 200
 *   [2] a second client (ensureServer) REUSES the same listener (one server/repo)
 *   [3] KILL THE PARENT (SIGKILL the sidecar) → its in-process server DIES and the
 *       record goes stale (parent-bound lifetime; no orphan, no .unref())
 *   [4] the next trigger REAPS the stale record and hosts exactly one fresh server
 *   [5] a clean `shutdown` frame closes the server + removes the record (tree clean)
 *   [6] the full project test suite (count reported)
 *
 * Every spawned child is reaped on exit (SIGKILL sweep). Exits 0 only when every
 * stage is green. Run: node test/harness/plans_sidecar.js  (npm run harness:sidecar)
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const cp = require("child_process");

const PLUGIN_DIR = path.resolve(__dirname, "..", "..");
const SIDECAR = path.join(PLUGIN_DIR, "bin", "plans-sidecar.js");
const life = require(path.join(PLUGIN_DIR, "lib", "server_lifecycle.js"));

function line(c) { return c.repeat(64); }
function log(s) { process.stdout.write(s + "\n"); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const CHILDREN = new Set();
function reapAll() { for (const c of CHILDREN) { try { c.kill("SIGKILL"); } catch (_) {} } CHILDREN.clear(); }
process.on("exit", reapAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { reapAll(); process.exit(1); });

// A real sidecar child speaking v2 frames over stdio.
function spawnSidecar(repoRoot) {
  const child = cp.spawn(process.execPath, [SIDECAR], {
    cwd: PLUGIN_DIR,
    env: Object.assign({}, process.env, { REPO_ROOT: repoRoot, PLUGIN_DIR }),
    stdio: ["pipe", "pipe", "inherit"],
  });
  CHILDREN.add(child);
  const frames = [];
  const waiters = [];
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const lineStr = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!lineStr.trim()) continue;
      let f; try { f = JSON.parse(lineStr); } catch (_) { continue; }
      frames.push(f);
      waiters.splice(0).forEach((w) => w(f));
    }
  });
  function send(frame) { child.stdin.write(JSON.stringify(frame) + "\n"); }
  function waitFor(pred, ms) {
    const hit = frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for frame")), ms || 4000);
      waiters.push(function w(f) { if (pred(f)) { clearTimeout(t); resolve(f); } else waiters.push(w); });
    });
  }
  return { child, frames, send, waitFor };
}

function getHealth(url) {
  // url is http://127…:port/?token=tok
  const u = new URL(url);
  const probe = "http://127.0.0.1:" + u.port + "/api/health?token=" + encodeURIComponent(u.searchParams.get("token") || "");
  return new Promise((resolve) => {
    const req = http.get(probe, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (_) { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on("error", () => resolve({ status: 0, body: null }));
    req.setTimeout(800, () => { try { req.destroy(); } catch (_) {} resolve({ status: 0, body: null }); });
  });
}

function check(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  log(line("="));
  log("plans-server-sidecar — unattended parent-bound harness (S6)");
  log(line("="));

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-harness-"));
  fs.mkdirSync(path.join(repo, ".plans"), { recursive: true });

  let urlA, portA;
  try {
    // [1] init → trigger → url-bearing status/insert_text + health 200 -------
    const A = spawnSidecar(repo);
    await A.waitFor((f) => f.type === "hello" && f.protocol_version === 2);
    A.send({ type: "init" });
    A.send({ type: "trigger", name: "plans" });
    const ins = await A.waitFor((f) => f.type === "insert_text" && /^http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(f.text || ""));
    urlA = ins.text;
    await A.waitFor((f) => f.type === "status" && /plans server/.test(f.label || "") && (f.label || "").includes(urlA));
    const recA = life.readRecord(repo);
    check(recA && recA.url === urlA, "record must be written with the served url");
    portA = recA.port;
    const h1 = await getHealth(urlA);
    check(h1.status === 200 && h1.body && h1.body.ok, "/api/health must answer 200 ok for the live sidecar server");
    check(h1.body.pid === recA.pid, "health pid must match the record (it IS the sidecar's server)");
    log("  [1] trigger → url-bearing status + /api/health 200      ✓  port=" + portA);

    // [2] second client reuses the SAME listener (one server per repo) -------
    const reuse = await life.ensureServer(repo);
    check(reuse.reused === true && reuse.hosted === false, "second client must REUSE (host nothing)");
    check(reuse.port === portA, "the reuser must get the same port (single instance)");
    log("  [2] second client ensureServer reuses (hosts nothing)   ✓  same port=" + portA);

    // [3] KILL THE PARENT → server dies, record goes stale ------------------
    // Sanity (would-be RED): the server is alive RIGHT NOW.
    check((await getHealth(urlA)).status === 200, "pre-kill: server must be alive");
    A.child.kill("SIGKILL");          // abrupt parent death (no graceful shutdown)
    CHILDREN.delete(A.child);
    await sleep(300);
    const hDead = await getHealth(urlA);
    check(hDead.status !== 200, "GREEN: after parent death the in-process server must be DEAD (no orphan): got " + hDead.status);
    const stale = await life.serverStatus(repo);
    check(stale.state === "stale", "record must read as STALE after an abrupt parent death (pid dead), got " + stale.state);
    log("  [3] kill parent → server dead (RED→GREEN), record stale ✓");

    // [4] next trigger reaps the stale record and hosts ONE fresh server -----
    const B = spawnSidecar(repo);
    await B.waitFor((f) => f.type === "hello");
    B.send({ type: "init" });
    B.send({ type: "trigger", name: "plans" });
    const insB = await B.waitFor((f) => f.type === "insert_text" && /token=/.test(f.text || ""));
    const urlB = insB.text;
    const recB = life.readRecord(repo);
    check(recB && recB.url === urlB, "fresh record must name the new sidecar");
    check(recB.port !== portA, "the stale port must be reaped — a fresh listener on a new port");
    check((await getHealth(urlB)).status === 200, "the fresh server must answer /api/health 200");
    log("  [4] stale-after-death reap → one fresh server           ✓  newPort=" + recB.port);

    // [5] clean shutdown removes the record (tree clean) --------------------
    B.send({ type: "shutdown" });
    await B.waitFor((f) => f.type === "status" && f.state === "stopped");
    await sleep(200);
    check(life.readRecord(repo) === null, "clean shutdown must REMOVE the record");
    check((await life.serverStatus(repo)).state === "down", "serverStatus must report 'down' after clean shutdown");
    check((await getHealth(urlB)).status !== 200, "the server must be closed after shutdown");
    CHILDREN.delete(B.child);
    log("  [5] clean shutdown → record removed, status down        ✓");
  } finally {
    try { await life.stopServer(repo); } catch (_) {}
    reapAll();
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {}
  }

  // [6] full project test suite ------------------------------------------
  const r = cp.spawnSync(process.execPath, ["--test", "test/**/*.test.js"], { cwd: PLUGIN_DIR, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const pass = Number((out.match(/(?:ℹ|#)\s*pass\s+(\d+)/) || [])[1] || 0);
  const fail = Number((out.match(/(?:ℹ|#)\s*fail\s+(\d+)/) || [])[1] || 0);
  check(fail === 0 && pass > 0, "full suite not green (pass=" + pass + " fail=" + fail + ")");
  log("  [6] full suite: " + pass + " pass, " + fail + " fail                       ✓");

  // No-orphan sweep: nothing of ours should still be listening.
  check(CHILDREN.size === 0, "no spawned children may remain");

  log("\n" + line("="));
  log("HARNESS GREEN — sidecar lifecycle ✓  single-instance ✓  parent-bound reap ✓  clean shutdown ✓  suite " + pass + "/" + pass + " ✓");
  log(line("="));
  process.exit(0);
}

main().catch((e) => { log("\nHARNESS FAILED: " + (e && e.message)); reapAll(); process.exit(1); });
