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

/*
 * No-op browser-launcher shim. The product CLI (`plan new` / `plan open`) shells
 * out to xdg-open/open/start to pop a real browser tab. During grading that
 * would hijack the human's actual browser on every round. We prepend a temp dir
 * of no-op stubs to PATH so the launch is captured harmlessly. Oracle infra only;
 * product code is untouched.
 */
let _shimDir = null;
function browserShimDir() {
  if (_shimDir && fs.existsSync(_shimDir)) return _shimDir;
  _shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-noopen-"));
  const isWin = process.platform === "win32";
  for (const name of ["xdg-open", "open", "start"]) {
    const file = path.join(_shimDir, isWin ? name + ".cmd" : name);
    fs.writeFileSync(file, isWin ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (!isWin) fs.chmodSync(file, 0o755);
  }
  return _shimDir;
}

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
    buildRoot: mod.root,
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
      // auto-attach the per-session token so grading suites exercise real routes
      const tok = srv.token;
      const request = (m, p, b, h) => httpReq(srv.port, m, p, b, Object.assign(tok ? { "x-plan-token": tok } : {}, h || {}));
      return { srv, repo, port: srv.port, token: tok, request };
    },

    cleanup() {
      for (const s of servers) { try { s.close(() => {}); } catch (_) {} }
      for (const d of repos) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
    },

    /** Run the product CLI (bin/plan.js) from the target build; returns {status,stdout,stderr}. */
    runCli(args, env) {
      const cp = require("node:child_process");
      const repo = makeRepo(); repos.push(repo);
      const shim = browserShimDir();
      const basePath = process.env.PATH || "";
      return cp.spawnSync(process.execPath, ["bin/plan.js", ...args], {
        cwd: mod.root, encoding: "utf8",
        env: Object.assign({}, process.env, {
          REPO_ROOT: repo,
          // route browser-launch through the no-op shim (never the human's browser)
          PATH: shim + path.delimiter + basePath,
        }, env || {}),
        // Serving commands (new/open/serve) never self-exit; bound them tightly
        // and SIGKILL so grading can't hang or leak server processes. Terminating
        // commands (list/reconcile, artifact creation) complete well under this.
        timeout: (env && env.__cliTimeout) || 5000,
        killSignal: "SIGKILL",
      });
    },
  };
  return sut;
}

module.exports = { createSut, BUILD_ROOT };
