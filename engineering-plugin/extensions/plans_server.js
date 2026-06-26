/*
 * plans_server.js — HTML Plan Ecosystem plans-server.
 *  - tiny HTTP server bound to 127.0.0.1 on a random ephemeral port
 *  - serves renderer assets from ${PLUGIN_DIR}/assets (single source of truth)
 *  - repo-wide plan discovery, single-plan render, SSE live updates
 *  - Plan Inbox notes/events persistence + agent respond
 *  - agent registry endpoints (fleet)
 *  - JSON-RPC over stdio loop (Synaps extension contract) when run as main
 *
 * Security (spec §7): loopback-only, per-session token, path confinement,
 * write allowlist, body/SSE/discovery bounds, CSP, no code execution from data.
 *
 * Node stdlib only. Plan P1-1..P1-4, P2-2/2-4, P3-1/3-3, P5-1.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EngPlan = require("../assets/engplan.js");
const { safeRealpath, isInside } = require("../lib/paths.js");
const store = require("../lib/store.js");
const discovery = require("../lib/discovery.js");
const inbox = require("../lib/inbox.js");
const { watchPlans } = require("../lib/watch.js");
const { Registry } = require("../lib/registry/index.js");
const cacHooks = require("../lib/cac/hooks.js");

const ASSET_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml; charset=utf-8",
};
// Long-lived, content-stable assets (bundled fonts + logo) get an immutable
// cache; code/markup (js/css/html) stays uncached so edits land immediately.
const ASSET_CACHE = new Set([".woff2", ".woff", ".svg"]);

const DEFAULT_LIMITS = {
  maxBodyBytes: 256 * 1024,
  maxSseConnections: 32,
  maxEventsPerPlan: 1000,
  discovery: { maxDepth: 8, maxFiles: 5000 },
};

function createServer(opts) {
  opts = opts || {};
  const repoRoot = path.resolve(opts.repoRoot || process.cwd());
  const pluginDir = path.resolve(opts.pluginDir || path.join(__dirname, ".."));
  const assetsDir = path.join(pluginDir, "assets");
  const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
  const clock = opts.clock || { now: () => new Date().toISOString() };
  // token: on by default. Pass token:false to disable (tests of legacy only).
  const token = opts.token === false ? null : (opts.token || crypto.randomBytes(16).toString("hex"));
  // Process-stable start timestamp — surfaced by /api/health and the server record.
  const startedAt = opts.startedAt || clock.now();
  const registry = new Registry(repoRoot, { clock, limits: opts.registryLimits });

  let sseClients = new Set();      // {res, slug}
  let rosterClients = new Set();   // res

  // ---- helpers ----
  function checkToken(req, q) {
    if (!token) return true;
    const provided = (q && q.token) || req.headers["x-plan-token"];
    if (!provided) return false;
    const a = Buffer.from(String(provided));
    const b = Buffer.from(token);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  function send(res, code, body, headers) {
    const h = Object.assign({
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
    }, headers || {});
    res.writeHead(code, h);
    res.end(body);
  }
  function sendJson(res, code, obj, headers) {
    send(res, code, JSON.stringify(obj), Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers || {}));
  }

  function readBody(req, cb) {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      size += c.length;
      if (size > limits.maxBodyBytes) { aborted = true; cb(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!aborted) cb(null, Buffer.concat(chunks).toString("utf8")); });
    req.on("error", (e) => { if (!aborted) cb(e); });
  }

  function serveAsset(res, name) {
    // name comes from URL path after /_assets/
    let abs;
    try { abs = safeRealpath(assetsDir, name); } catch (_) { return send(res, 403, "forbidden"); }
    if (!isInside(assetsDir, abs)) return send(res, 403, "forbidden");
    fs.readFile(abs, (err, data) => {
      if (err) return send(res, 404, "not found");
      const ext = path.extname(abs);
      const type = ASSET_TYPES[ext] || "application/octet-stream";
      const headers = { "Content-Type": type };
      if (ASSET_CACHE.has(ext)) headers["Cache-Control"] = "public, max-age=31536000, immutable";
      send(res, 200, data, headers);
    });
  }

  function injectToken(htmlText) {
    // inject token + base into served plan HTML so renderer fetches carry it
    const tag = '<script>window.__PLAN_TOKEN__=' + JSON.stringify(token || "") + ';</script>';
    if (/<\/head>/i.test(htmlText)) return htmlText.replace(/<\/head>/i, tag + "</head>");
    return tag + htmlText;
  }

  function findPlanPath(id) {
    const { plans } = discovery.discover(repoRoot, { limits: limits.discovery });
    const e = plans.find((p) => p.id === id);
    return e ? path.join(repoRoot, e.path) : null;
  }

  // Locate a plan file by FILENAME stem (`<id>.plan.html` / `<id>.spec.html`),
  // independent of whether its embedded JSON parses. Used by /api/plan/:id so a
  // file with broken JSON can be distinguished (422) from a missing one (404).
  // Bounded walk, same ignore set as discovery; confined to repoRoot.
  function findPlanFileByStem(id) {
    const want = new Set([id + ".plan.html", id + ".spec.html"]);
    const IGNORE = new Set([".git", "node_modules", ".worktrees", "target", "__pycache__"]);
    const maxDepth = (limits.discovery && limits.discovery.maxDepth) || 8;
    let found = null;
    (function walk(dir, depth) {
      if (found || depth > maxDepth) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of entries) {
        if (found) return;
        if (IGNORE.has(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full, depth + 1);
        else if (ent.isFile() && want.has(ent.name)) found = full;
      }
    })(repoRoot, 0);
    return found;
  }

  function renderShell() {
    const shellPath = path.join(assetsDir, "shell.html");
    try { return injectToken(fs.readFileSync(shellPath, "utf8")); }
    catch (_) { return "<!doctype html><meta charset=utf-8><title>Plans</title><div id=app>shell missing</div>"; }
  }

  // ---- request router ----
  const server = http.createServer((req, res) => {
    let pathname, q;
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      pathname = decodeURIComponent(u.pathname || "/");
      q = {}; for (const [k, v] of u.searchParams) q[k] = v;
    } catch (_) { return send(res, 400, "bad url"); }

    // --- assets (served before token gate; confined by safeRealpath + isInside) ---
    if (pathname.startsWith("/_assets/")) {
      return serveAsset(res, pathname.slice("/_assets/".length));
    }

    // token gate (all non-asset routes)
    if (!checkToken(req, q)) return sendJson(res, 401, { error: "unauthorized" });

    try {
      // --- sidebar shell ---
      if (pathname === "/" || pathname === "/index.html") {
        return send(res, 200, renderShell(), { "Content-Type": "text/html; charset=utf-8" });
      }
      // --- liveness/health probe (token-gated, NO plan I/O) ---
      // Used by the lifecycle layer to confirm a recorded server is genuinely
      // ours (matching token) and alive. Intentionally does zero discovery,
      // file, or store work so it is cheap and side-effect free.
      if (pathname === "/api/health" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          started_at: startedAt,
          plans_dir: path.join(repoRoot, ".plans"),
        });
      }
      // --- discovery ---
      if (pathname === "/api/plans" && req.method === "GET") {
        const { plans } = discovery.discover(repoRoot, { limits: limits.discovery });
        return sendJson(res, 200, plans);
      }
      // --- agent roster ---
      if (pathname === "/api/agents" && req.method === "GET") {
        return sendJson(res, 200, registry.list());
      }
      if (pathname === "/api/agents" && req.method === "POST") {
        return readBody(req, (err, body) => {
          if (err) return sendJson(res, 413, { error: String(err.message) });
          let raw; try { raw = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: "bad json" }); }
          try {
            const agent = raw.id && registry.list().some((a) => a.id === raw.id)
              ? registry.heartbeat(raw.id, raw)
              : registry.register(raw);
            broadcastRoster();
            return sendJson(res, 200, agent);
          } catch (e) { return sendJson(res, 400, { error: String(e.message) }); }
        });
      }
      if (pathname.startsWith("/api/agents/") && pathname.endsWith("/stream") === false && req.method === "DELETE") {
        const id = pathname.slice("/api/agents/".length);
        registry.deregister(id); broadcastRoster();
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === "/api/agents/stream" && req.method === "GET") {
        return openSse(req, res, rosterClients, () => registry.list(), "roster");
      }
      // --- JSON plan API (PS-1): parsed engplan/1 for the SPA ---
      // 200 valid · 400 bad id · 404 missing · 422 unparseable/invalid JSON.
      const planApiM = pathname.match(/^\/api\/plan\/([^/]+)$/);
      if (planApiM && req.method === "GET") {
        const id = planApiM[1];
        if (!EngPlan.validId(id)) return sendJson(res, 400, { error: "invalid plan id" });
        // Prefer the discovery path (valid plans anywhere in the repo); fall
        // back to a filename-stem locate so a file with broken JSON is a 422.
        const p = findPlanPath(id) || findPlanFileByStem(id);
        if (!p) return sendJson(res, 404, { error: "plan not found" });
        let txt;
        try { txt = fs.readFileSync(p, "utf8"); } catch (_) { return sendJson(res, 404, { error: "plan not found" }); }
        const json = discovery.extractPlanJson(txt);
        if (!json) return sendJson(res, 422, { error: "plan JSON missing or unparseable" });
        let plan;
        try { plan = EngPlan.parseEngPlan(json); }
        catch (e) { return sendJson(res, 422, { error: "plan JSON invalid: " + String(e.message) }); }
        return sendJson(res, 200, plan);
      }
      // --- render a single plan ---
      if (pathname.startsWith("/plan/") && req.method === "GET") {
        const id = pathname.slice("/plan/".length);
        if (!EngPlan.validId(id)) return send(res, 400, "bad id");
        const p = findPlanPath(id);
        if (!p) return send(res, 404, "plan not found");
        let txt; try { txt = fs.readFileSync(p, "utf8"); } catch (_) { return send(res, 404, "plan not found"); }
        return send(res, 200, injectToken(txt), { "Content-Type": "text/html; charset=utf-8" });
      }
      // --- SSE live stream ---
      if (pathname === "/api/stream" && req.method === "GET") {
        const slug = q.plan;
        if (!EngPlan.validId(slug)) return send(res, 400, "bad plan");
        return openSse(req, res, sseClients, null, slug, slug);
      }
      // --- notes ---
      if (pathname === "/api/notes" && req.method === "GET") {
        const slug = q.plan;
        if (!EngPlan.validId(slug)) return sendJson(res, 400, { error: "bad plan" });
        try { return sendJson(res, 200, store.readNotes(repoRoot, slug)); }
        catch (e) { return sendJson(res, 400, { error: String(e.message) }); }
      }
      if (pathname === "/api/notes" && req.method === "POST") {
        return readBody(req, (err, body) => {
          if (err) return sendJson(res, 413, { error: String(err.message) });
          let raw; try { raw = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: "bad json" }); }
          const slug = raw.plan_id || q.plan;
          if (!EngPlan.validId(slug)) return sendJson(res, 400, { error: "bad plan" });
          try {
            const ev = store.appendEvent(repoRoot, slug, raw, { clock, limits });
            broadcastPlan(slug, { type: "note", event: ev });
            return sendJson(res, 200, ev);
          } catch (e) {
            const code = /cap exceeded|too large/.test(e.message) ? 413 : 400;
            return sendJson(res, code, { error: String(e.message) });
          }
        });
      }
      // --- CAC §7 checkpoint.reached producer (additive) ---
      // Emits the §4 safe-point boundary event onto the existing SSE bus via the
      // shared broadcastPlan producer. Reuses readBody/sendJson exactly like the
      // other /api POST routes; does not touch openSse, the SSE cap, token, or
      // write-confinement.
      if (pathname === "/api/checkpoint" && req.method === "POST") {
        return readBody(req, (err, body) => {
          if (err) return sendJson(res, 413, { error: String(err.message) });
          let raw; try { raw = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: "bad json" }); }
          const slug = raw.slug || q.plan;
          if (!EngPlan.validId(slug)) return sendJson(res, 400, { error: "bad plan" });
          try {
            const event = cacHooks.checkpointReachedEvent({
              slug,
              phase: raw.phase,
              checkpoint: raw.checkpoint,
              head_commit: raw.head_commit,
            });
            broadcastPlan(slug, event);
            return sendJson(res, 200, event);
          } catch (e) {
            return sendJson(res, 400, { error: String(e.message) });
          }
        });
      }
      // --- agent respond ---
      const respM = pathname.match(/^\/api\/events\/([^/]+)\/respond$/);
      if (respM && req.method === "POST") {
        const eventId = respM[1];
        return readBody(req, (err, body) => {
          if (err) return sendJson(res, 413, { error: String(err.message) });
          let raw; try { raw = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: "bad json" }); }
          const slug = raw.plan_id || q.plan;
          if (!EngPlan.validId(slug)) return sendJson(res, 400, { error: "bad plan" });
          try {
            const ev = store.respondToEvent(repoRoot, slug, eventId, raw, { clock });
            broadcastPlan(slug, { type: "respond", event: ev });
            return sendJson(res, 200, ev);
          } catch (e) { return sendJson(res, 400, { error: String(e.message) }); }
        });
      }
      // --- reconcile trigger ---
      if (pathname === "/api/reconcile" && req.method === "POST") {
        const slug = q.plan;
        if (!EngPlan.validId(slug)) return sendJson(res, 400, { error: "bad plan" });
        try {
          const planPath = findPlanPath(slug);
          const planJson = planPath ? discovery.extractPlanJson(fs.readFileSync(planPath, "utf8")) : null;
          const plan = planJson ? EngPlan.parseEngPlan(planJson) : null;
          const { events } = store.readNotes(repoRoot, slug);
          const out = inbox.reconcile(plan, events, opts.agentFns, { clock });
          store.writeEvents(repoRoot, slug, out.events);
          broadcastPlan(slug, { type: "reconcile", attention: out.attention, halted: out.halted });
          return sendJson(res, 200, out);
        } catch (e) { return sendJson(res, 400, { error: String(e.message) }); }
      }

      return send(res, 404, "not found");
    } catch (e) {
      return sendJson(res, 500, { error: "internal" });
    }
  });

  // ---- SSE plumbing ----
  function openSse(req, res, pool, snapshotFn, slug, channel) {
    if (pool.size >= limits.maxSseConnections) { return send(res, 503, "too many streams"); }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });
    res.write(": connected\n\n");
    const client = { res, slug: channel || slug };
    pool.add(client);
    if (snapshotFn) { try { res.write("event: roster\ndata: " + JSON.stringify(snapshotFn()) + "\n\n"); } catch (_) {} }
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) {} }, 15000);
    req.on("close", () => { clearInterval(ping); pool.delete(client); });
  }

  function broadcastPlan(slug, payload) {
    const data = "data: " + JSON.stringify(Object.assign({ plan: slug }, payload)) + "\n\n";
    for (const c of sseClients) { if (c.slug === slug) { try { c.res.write(data); } catch (_) {} } }
  }
  function broadcastRoster() {
    const data = "event: roster\ndata: " + JSON.stringify(registry.list()) + "\n\n";
    for (const c of rosterClients) { try { c.res.write(data); } catch (_) {} }
  }

  // ---- file watcher → SSE ----
  let watcher = null;
  function startWatcher() {
    const plansDir = path.join(repoRoot, ".plans");
    try { fs.mkdirSync(plansDir, { recursive: true }); } catch (_) {}
    watcher = watchPlans(plansDir, (chg) => {
      if (!chg.slug) return;
      broadcastPlan(chg.slug, { type: "filechange", changed: chg.changed, removed: chg.removed, full: chg.full });
    }, { debounceMs: opts.debounceMs != null ? opts.debounceMs : 50 });
  }

  // ---- start/stop ----
  function listen(cb) {
    server.listen(opts.port || 0, "127.0.0.1", () => {
      startWatcher();
      const addr = server.address();
      api.url = "http://127.0.0.1:" + addr.port + "/" + (token ? "?token=" + token : "");
      if (cb) cb(api);
    });
  }
  function close(cb) {
    if (watcher) try { watcher.close(); } catch (_) {}
    for (const c of sseClients) try { c.res.end(); } catch (_) {}
    for (const c of rosterClients) try { c.res.end(); } catch (_) {}
    sseClients.clear(); rosterClients.clear();
    server.close(() => { if (cb) cb(); });
  }

  const api = {
    httpServer: server, listen, close,
    url: null,
    token, repoRoot, pluginDir, registry, startedAt,
    broadcastPlan, // exposed for tests
  };
  Object.defineProperty(api, "port", { get() { const a = server.address(); return a ? a.port : null; }, configurable: true });
  return api;
}

// ---- JSON-RPC over stdio (Synaps extension contract) ----
// Opts (all optional): { input, output, repoRoot, pluginDir, exit }.
// Defaults to process.stdin/stdout for the real extension; tests inject streams.
function runStdioExtension(opts) {
  opts = opts || {};
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const pluginDir = opts.pluginDir || process.env.PLUGIN_DIR || path.join(__dirname, "..");
  const repoRoot = opts.repoRoot || process.env.REPO_ROOT || process.cwd();
  const life = opts.lifecycle || require("../lib/server_lifecycle.js");
  const doExit = opts.exit !== false;
  let iHosted = false; // true only if THIS process hosts the repo server

  // Record-aware: reuse a live repo server (host nothing) else host in-process.
  // Parent/session-bound — a hosted server dies when this extension process exits.
  async function ensureRepoServer() {
    const r = await life.ensureServer(repoRoot, { pluginDir });
    if (r.hosted) iHosted = true;
    return r;
  }

  let buf = Buffer.alloc(0);
  input.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) break;
      const header = buf.slice(0, sep).toString("ascii");
      const m = header.match(/content-length:\s*(\d+)/i);
      if (!m) { buf = buf.slice(sep + 4); continue; }
      const len = parseInt(m[1], 10);
      if (buf.length < sep + 4 + len) break;
      const body = buf.slice(sep + 4, sep + 4 + len).toString("utf8");
      buf = buf.slice(sep + 4 + len);
      let msg; try { msg = JSON.parse(body); } catch (_) { continue; }
      handleRpc(msg);
    }
  });

  function reply(id, result, error) {
    const payload = { jsonrpc: "2.0", id };
    if (error) payload.error = error; else payload.result = result;
    const data = Buffer.from(JSON.stringify(payload), "utf8");
    output.write("Content-Length: " + data.length + "\r\n\r\n");
    output.write(data);
  }

  // Session-bound teardown: stop ONLY a server we host (a reuser must never
  // kill or adopt a foreign owner's server). Then exit if configured.
  async function teardown() {
    if (iHosted) { try { await life.stopServer(repoRoot); } catch (_) {} iHosted = false; }
  }

  async function handleRpc(msg) {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        return reply(id, { protocol_version: 1, extension: "engineering", capabilities: [], name: "plans-server" });
      case "ping":
        return reply(id, { ok: true, name: "plans-server", protocol: 1 });
      case "hook.handle":
        // Lifecycle hooks (on_session_start / on_session_end) — no gating.
        return reply(id, { action: "continue" });
      case "shutdown":
        await teardown();
        return reply(id, { ok: true });
      case "plan/serve":
        try {
          const r = await ensureRepoServer();
          return reply(id, { url: r.url, port: r.port, reused: !!r.reused, hosted: !!r.hosted });
        } catch (e) { return reply(id, null, { code: -32000, message: String(e && e.message) }); }
      case "plan/status":
        try { return reply(id, await life.serverStatus(repoRoot)); }
        catch (e) { return reply(id, null, { code: -32000, message: String(e && e.message) }); }
      case "plan/down":
        try {
          const d = await life.stopServer(repoRoot);
          if (d.hosted) iHosted = false;
          return reply(id, d);
        } catch (e) { return reply(id, null, { code: -32000, message: String(e && e.message) }); }
      case "plan/list":
        return reply(id, discovery.discover(repoRoot, {}).plans);
      case "plan/reconcile": {
        const slug = params && params.slug;
        try {
          const planPath = findPlanPathFor(repoRoot, slug);
          const planJson = planPath ? discovery.extractPlanJson(fs.readFileSync(planPath, "utf8")) : null;
          const plan = planJson ? EngPlan.parseEngPlan(planJson) : null;
          const { events } = store.readNotes(repoRoot, slug);
          const out = inbox.reconcile(plan, events, null, {});
          store.writeEvents(repoRoot, slug, out.events);
          return reply(id, out);
        } catch (e) { return reply(id, null, { code: -32000, message: String(e.message) }); }
      }
      default:
        if (id !== undefined) reply(id, null, { code: -32601, message: "method not found: " + method });
    }
  }

  // Parent/session death closes our stdin → session-bound teardown.
  input.on("end", () => { teardown().then(() => { if (doExit) process.exit(0); }); });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(sig, () => { teardown().then(() => { if (doExit) process.exit(0); }); });

  return { teardown, repoRoot, isHosting: () => iHosted };
}

function findPlanPathFor(repoRoot, id) {
  const { plans } = discovery.discover(repoRoot, {});
  const e = plans.find((p) => p.id === id);
  return e ? path.join(repoRoot, e.path) : null;
}

module.exports = { createServer, runStdioExtension, DEFAULT_LIMITS };

if (require.main === module) {
  runStdioExtension();
}
