/*
 * sut.js — System-Under-Test adapter. Boots the P0–P5 build and exposes ONLY
 * its contract surface (engplan/1 parsing + lifecycle, the store, the inbox, and
 * the HTTP server) to grading suites. Grading suites bind to this adapter +
 * the frozen contract; they never read product source. Orchestrator infra.
 *
 * A `targetDir` may be supplied to point at a mutated/twin copy of the build so
 * the same suites grade alternate artifacts (mutation testing, differential twins).
 * Node stdlib only.
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const BUILD_ROOT = path.join(__dirname, "..", "..");

function load(targetDir) {
  const root = targetDir || BUILD_ROOT;
  // fresh module instances per target (avoid require cache cross-talk for mutants)
  const resolve = (p) => path.join(root, p);
  function freshRequire(p) {
    const full = require.resolve(resolve(p));
    delete require.cache[full];
    return require(full);
  }
  const EngPlan = freshRequire("assets/engplan.js");
  const store = freshRequire("lib/store.js");
  const inbox = freshRequire("lib/inbox.js");
  const { createServer } = freshRequire("extensions/plans_server.js");
  return { EngPlan, store, inbox, createServer, root };
}

/** Make an ephemeral repo with a .plans dir + one valid plan artifact. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-sut-"));
  fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
  return dir;
}

function httpReq(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body != null ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : null;
    const req = http.request({ host: "127.0.0.1", port, method, path: p,
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": data ? data.length : 0 }, headers || {}) },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Build a SUT handle bound to a target build dir. Provides the contract surface.
 */
function createSut(opts) {
  opts = opts || {};
  const mod = load(opts.targetDir);
  const repos = [];
  const servers = [];

  const sut = {
    contractSurface: true,
    EngPlan: mod.EngPlan,
    parsePlan: (raw) => mod.EngPlan.parseEngPlan(raw),
    parseEvent: (raw) => mod.EngPlan.parseEvent(raw),
    parseNote: (raw) => mod.EngPlan.parseNote(raw),
    transition: (ev, to) => mod.EngPlan.transition(ev, to),
    canTransition: (a, b) => mod.EngPlan.canTransition(a, b),
    validId: (id) => mod.EngPlan.validId(id),

    newRepo() { const d = makeRepo(); repos.push(d); return d; },
    appendEvent: (repo, slug, ev, o) => mod.store.appendEvent(repo, slug, ev, o),
    readNotes: (repo, slug) => mod.store.readNotes(repo, slug),
    reconcile: (plan, events, ev, o) => mod.inbox.reconcile(plan, events, ev, o),

    async startServer(serverOpts) {
      const repo = (serverOpts && serverOpts.repoRoot) || makeRepo();
      if (!serverOpts || !serverOpts.repoRoot) repos.push(repo);
      const srv = mod.createServer(Object.assign({ repoRoot: repo, pluginDir: mod.root }, serverOpts || {}));
      await new Promise((res) => srv.listen(() => res()));
      servers.push(srv);
      return { srv, repo, port: srv.port, request: (m, p, b, h) => httpReq(srv.port, m, p, b, h) };
    },

    cleanup() {
      for (const s of servers) { try { s.close(() => {}); } catch (_) {} }
      for (const d of repos) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    },
  };
  return sut;
}

module.exports = { createSut, BUILD_ROOT };
