/*
 * runner.js — harness foundation: temp-repo + ephemeral-port SUT fixtures,
 * injectable clock/ids, HTTP + SSE clients, --prove red→green helper. Plan H-0.
 * Node stdlib only.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createServer } = require("../../extensions/plans_server.js");

function makeClock(startISO) {
  let t = Date.parse(startISO || "2026-06-25T12:00:00.000Z");
  return {
    now() { const v = new Date(t).toISOString(); t += 1000; return v; },
    set(iso) { t = Date.parse(iso); },
    peekMs() { return t; },
  };
}

function makeIds(prefix) {
  let n = 0;
  return { next(p) { return (p || prefix || "id") + "_" + (++n).toString().padStart(4, "0"); } };
}

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engplan-"));
  fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
  return dir;
}

function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

const PLUGIN_DIR = path.join(__dirname, "..", "..");

function planArtifact(plan) {
  return [
    "<!doctype html><html lang=en><head><meta charset=utf-8>",
    '<meta name="engplan-schema" content="engplan/1">',
    '<title>' + (plan.title || "Plan") + "</title>",
    '<link rel="stylesheet" href="/_assets/plan.css">',
    '<script defer src="/_assets/plan.js"></script>',
    "</head><body>",
    '<script id="plan" type="application/json">',
    JSON.stringify(plan, null, 2),
    "</script>",
    '<div id="app">Loading…</div>',
    "</body></html>",
  ].join("\n");
}

function writePlan(repoRoot, plan) {
  const file = path.join(repoRoot, ".plans", plan.slug + "." + (plan.kind || "plan") + ".html");
  fs.writeFileSync(file, planArtifact(plan));
  return file;
}

// Promise HTTP client carrying the token automatically.
function client(base, token) {
  function req(method, p, body, headers) {
    return new Promise((resolve, reject) => {
      const u = new URL(p, base);
      if (token && !u.searchParams.get("token")) u.searchParams.set("token", token);
      const data = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
      const r = http.request(u, { method, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null; try { json = JSON.parse(text); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      r.on("error", reject);
      if (data) r.write(data);
      r.end();
    });
  }
  return {
    get: (p, h) => req("GET", p, null, h),
    post: (p, b, h) => req("POST", p, b, h),
    del: (p, h) => req("DELETE", p, null, h),
    raw: req,
  };
}

// SSE client: collects events; resolves on predicate or timeout.
function sseClient(base, token, planSlug) {
  const u = new URL("/api/stream", base);
  if (planSlug) u.searchParams.set("plan", planSlug);
  if (token) u.searchParams.set("token", token);
  const events = [];
  let buf = "";
  const waiters = [];
  const r = http.request(u, { method: "GET" }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = raw.split("\n").find((l) => l.startsWith("data:"));
        if (line) { let d = line.slice(5).trim(); let j = null; try { j = JSON.parse(d); } catch (_) {} const ev = j || d; events.push(ev); waiters.splice(0).forEach((w) => w(ev)); }
      }
    });
  });
  r.on("error", () => {});
  r.end();
  return {
    events,
    next(timeoutMs) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("sse timeout")), timeoutMs || 2000);
        waiters.push((ev) => { clearTimeout(t); resolve(ev); });
      });
    },
    waitFor(pred, timeoutMs) {
      return new Promise((resolve, reject) => {
        const found = events.find(pred);
        if (found) return resolve(found);
        const t = setTimeout(() => reject(new Error("sse waitFor timeout")), timeoutMs || 3000);
        const check = (ev) => { if (pred(ev)) { clearTimeout(t); resolve(ev); } else waiters.push(check); };
        waiters.push(check);
      });
    },
    close() { try { r.destroy(); } catch (_) {} },
  };
}

// withServer: start SUT in a fresh temp repo, run fn, always tear down.
async function withServer(opts, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  opts = opts || {};
  const repoRoot = opts.repoRoot || tmpRepo();
  const ownRepo = !opts.repoRoot;
  const clock = opts.clock || makeClock();
  const srv = createServer(Object.assign({ repoRoot, pluginDir: PLUGIN_DIR, clock, debounceMs: opts.debounceMs != null ? opts.debounceMs : 20 }, opts.serverOpts || {}));
  await new Promise((resolve) => srv.listen(() => resolve()));
  const base = "http://127.0.0.1:" + srv.port + "/";
  const c = client(base, srv.token);
  const ctx = { srv, base, token: srv.token, repoRoot, client: c, clock, writePlan: (p) => writePlan(repoRoot, p), sse: (slug) => sseClient(base, srv.token, slug) };
  try { return await fn(ctx); }
  finally {
    await new Promise((resolve) => srv.close(() => resolve()));
    if (ownRepo) rmrf(repoRoot);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  makeClock, makeIds, tmpRepo, rmrf, planArtifact, writePlan, client, sseClient,
  withServer, sleep, PLUGIN_DIR,
};
