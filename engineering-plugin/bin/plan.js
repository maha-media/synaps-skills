#!/usr/bin/env node
/*
 * plan.js — /plan command surface (spec §10, plan P4-2).
 *   plan new <kind> <slug> [title...]   scaffold .plans/, copy fallback assets,
 *                                        write artifact, self-connect, open browser
 *   plan open <slug>                     reuse a live server (else foreground); open browser
 *   plan list                            list repo plans + attention counters
 *   plan serve                           foreground/dev server (non-singleton); print URL
 *   plan status                          report the recorded server (running|stale|down)
 *   plan down                            stop/remove the recorded server
 *   plan reconcile <slug>                force an agent reconcile pass
 * Library functions are exported for tests; CLI at bottom. Node stdlib only.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const EngPlan = require("../assets/engplan.js");
const discovery = require("../lib/discovery.js");
const inbox = require("../lib/inbox.js");
const store = require("../lib/store.js");
const life = require("../lib/server_lifecycle.js");

const PLUGIN_DIR = path.join(__dirname, "..");
const FALLBACK_ASSETS = ["plan.js", "plan.css", "engplan.js", "md.js", "sanitize.js"];

function planArtifact(plan) {
  return [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    '<meta name="engplan-schema" content="engplan/1">',
    "<title>" + escapeHtml(plan.title) + "</title>",
    // server mode first, static fallback second (spec §4.4)
    '<link rel="stylesheet" href="/_assets/plan.css">',
    '<script defer src="/_assets/engplan.js"></script>',
    '<script defer src="/_assets/md.js"></script>',
    '<script defer src="/_assets/sanitize.js"></script>',
    '<script defer src="/_assets/plan.js"></script>',
    '<script>window.addEventListener("error",function(){},true);</script>',
    "</head>", "<body>",
    '<script id="plan" type="application/json">',
    JSON.stringify(plan, null, 2),
    "</script>",
    '<div id="app">Loading… open via the Plans server for live mode.</div>',
    // static fallback loader: if /_assets failed, try ./_assets
    '<script>if(!window.PlanRenderer){var b=document.createElement("script");b.src="./_assets/plan.js";document.head.appendChild(b);}</script>',
    "</body>", "</html>",
  ].join("\n");
}
function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function planNew(repoRoot, kind, slug, opts) {
  opts = opts || {};
  if (["plan", "spec"].indexOf(kind) === -1) throw new Error("kind must be plan|spec");
  if (!EngPlan.validId(slug)) throw new Error("invalid slug: " + slug);
  const plansDir = path.join(repoRoot, ".plans");
  const assetsOut = path.join(plansDir, "_assets");
  fs.mkdirSync(assetsOut, { recursive: true });
  store.ensurePlansGitignore(repoRoot); // keep runtime artifacts out of git from the start
  // copy fallback assets once (static file:// support, spec §4.4/§4.5)
  for (const a of FALLBACK_ASSETS) {
    try { fs.copyFileSync(path.join(PLUGIN_DIR, "assets", a), path.join(assetsOut, a)); } catch (_) {}
  }
  const now = (opts.clock && opts.clock.now) ? opts.clock.now() : new Date().toISOString();
  const plan = {
    schema: "engplan/1", kind, slug,
    title: opts.title || slug, status: "drafting", convergence: "none",
    created_at: now, updated_at: now,
    sections: opts.sections || [{ id: "objective", heading: "Objective", type: "prose", md: "_Draft the objective._" }],
  };
  const file = path.join(plansDir, slug + "." + kind + ".html");
  fs.writeFileSync(file, planArtifact(plan));
  return { file, plansDir, assetsOut, plan };
}

function planList(repoRoot) {
  return discovery.discover(repoRoot, {}).plans;
}

function planReconcile(repoRoot, slug, opts) {
  opts = opts || {};
  if (!EngPlan.validId(slug)) throw new Error("invalid slug");
  const planPath = findPlan(repoRoot, slug);
  const planJson = planPath ? discovery.extractPlanJson(fs.readFileSync(planPath, "utf8")) : null;
  const plan = planJson ? EngPlan.parseEngPlan(planJson) : null;
  const { events } = store.readNotes(repoRoot, slug);
  const out = inbox.reconcile(plan, events, opts.agentFns, { clock: opts.clock });
  store.writeEvents(repoRoot, slug, out.events);
  return out;
}

function findPlan(repoRoot, slug) {
  const e = planList(repoRoot).find((p) => p.id === slug);
  return e ? path.join(repoRoot, e.path) : null;
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try { execFile(cmd, [url], () => {}); return true; } catch (_) { return false; }
}

function startServer(repoRoot, cb) {
  const { createServer } = require("../extensions/plans_server.js");
  const srv = createServer({ repoRoot, pluginDir: PLUGIN_DIR });
  srv.listen(() => cb(srv));
}

// Build the per-plan URL from a base server URL ("http://127…/?token=…").
function planUrl(baseUrl, slug) {
  return baseUrl.replace(/\/(\?|$)/, "/plan/" + slug + "$1");
}

// ---- record-aware server control (S2) ----
// serverStatus from the gitignored record + a live /api/health probe.
function planStatus(repoRoot) { return life.serverStatus(repoRoot); }
// stop a server hosted in THIS process and/or remove the record (never blind-kill).
function planDown(repoRoot) { return life.stopServer(repoRoot); }
// ensure at-most-one server per repo; reuse a live one, else host in-process.
function ensurePlanServer(repoRoot, opts) { return life.ensureServer(repoRoot, opts || {}); }

// Reuse a live repo server (host nothing) else host in-process; returns the
// per-plan openUrl plus {reused,hosted,port}. When hosted:true the CALLER must
// stay foreground — the in-process server is parent-bound and dies on exit.
async function planOpen(repoRoot, slug, opts) {
  opts = opts || {};
  const r = await ensurePlanServer(repoRoot, opts);
  const openUrl = planUrl(r.url, slug);
  if (opts.open !== false) openBrowser(openUrl);
  return { url: r.url, openUrl, port: r.port, reused: !!r.reused, hosted: !!r.hosted };
}

// Explicit foreground/dev server — NOT the singleton record path. Hosts its own
// listener and blocks the caller (the CLI). Documented as non-sidecar.
function planServeForeground(repoRoot) {
  const { createServer } = require("../extensions/plans_server.js");
  const srv = createServer({ repoRoot, pluginDir: PLUGIN_DIR });
  return new Promise((resolve) => srv.listen(() => resolve(srv)));
}

// ---- CLI ----
async function main(argv) {
  const [sub, ...rest] = argv;
  const repoRoot = process.env.REPO_ROOT || process.cwd();
  switch (sub) {
    case "new": {
      const [kind, slug, ...titleParts] = rest;
      if (!kind || !slug) { console.error("usage: plan new <kind> <slug> [title]"); process.exit(2); }
      const r = planNew(repoRoot, kind, slug, { title: titleParts.join(" ") || slug });
      console.log("created " + path.relative(repoRoot, r.file));
      // reuse a live repo server; else host in-process (foreground, parent-bound).
      const o = await planOpen(repoRoot, slug);
      console.log((o.reused ? "serving (reused): " : "serving: ") + o.url);
      console.log("open:    " + o.openUrl);
      if (o.reused) return;            // a live server already hosts it — exit
      console.log("(hosting foreground — Ctrl-C to stop)");
      return;                          // hosted in-process: keep process alive
    }
    case "list": {
      const plans = planList(repoRoot);
      if (!plans.length) { console.log("(no plans found)"); return; }
      for (const p of plans) {
        const a = p.attention || {};
        console.log([p.id.padEnd(28), p.kind.padEnd(5), p.status.padEnd(12),
          "blocking=" + (a.blocking || 0), "unresolved=" + (a.unresolved || 0), "needs_review=" + (a.needs_review || 0)].join(" "));
      }
      return;
    }
    case "reconcile": {
      const slug = rest[0];
      if (!slug) { console.error("usage: plan reconcile <slug>"); process.exit(2); }
      const out = planReconcile(repoRoot, slug);
      console.log("reconciled " + slug + ": " + out.events.length + " events; halted=" + JSON.stringify(out.halted) + "; attention=" + JSON.stringify(out.attention));
      return;
    }
    case "serve": {
      // explicit foreground/dev mode — NOT the singleton record path.
      const srv = await planServeForeground(repoRoot);
      console.log("plans-server (foreground/dev): " + srv.url);
      return;
    }
    case "status": {
      const st = await planStatus(repoRoot);
      if (st.state === "down") { console.log("plans-server: down (no record)"); return; }
      console.log("plans-server: " + st.state +
        (st.url ? "  url=" + st.url : "") +
        (st.pid ? "  pid=" + st.pid : "") +
        (st.port ? "  port=" + st.port : "") +
        (st.started_at ? "  started_at=" + st.started_at : ""));
      return;
    }
    case "down": {
      const d = await planDown(repoRoot);
      if (d.stopped) console.log("plans-server: stopped" + (d.signaled ? " (signaled)" : "") + (d.hosted ? " (in-process)" : ""));
      else if (d.removed) console.log("plans-server: stale record removed");
      else console.log("plans-server: nothing to stop (already down)");
      return;
    }
    case "open": {
      const slug = rest[0];
      if (!slug) { console.error("usage: plan open <slug>"); process.exit(2); }
      const o = await planOpen(repoRoot, slug);
      console.log((o.reused ? "open (reused): " : "open: ") + o.openUrl);
      if (o.reused) return;            // a live server already hosts it — exit
      console.log("(hosting foreground — Ctrl-C to stop)");
      return;                          // hosted in-process: keep process alive
    }
    default:
      console.error("usage: plan <new|open|list|serve|status|down|reconcile> ...");
      process.exit(2);
  }
}

module.exports = { planNew, planList, planReconcile, findPlan, planArtifact, startServer, openBrowser, main,
  planStatus, planDown, ensurePlanServer, planOpen, planServeForeground, planUrl };

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
