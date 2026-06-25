#!/usr/bin/env node
/*
 * plan.js — /plan command surface (spec §10, plan P4-2).
 *   plan new <kind> <slug> [title...]   scaffold .plans/, copy fallback assets,
 *                                        write artifact, self-connect, open browser
 *   plan open <slug>                     print server URL for the plan
 *   plan list                            list repo plans + attention counters
 *   plan serve                           ensure server running; print URL (foreground)
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

// ---- CLI ----
function main(argv) {
  const [sub, ...rest] = argv;
  const repoRoot = process.env.REPO_ROOT || process.cwd();
  switch (sub) {
    case "new": {
      const [kind, slug, ...titleParts] = rest;
      if (!kind || !slug) { console.error("usage: plan new <kind> <slug> [title]"); process.exit(2); }
      const r = planNew(repoRoot, kind, slug, { title: titleParts.join(" ") || slug });
      console.log("created " + path.relative(repoRoot, r.file));
      startServer(repoRoot, (srv) => {
        const u = srv.url.replace(/\/(\?|$)/, "/plan/" + slug + "$1");
        console.log("serving: " + srv.url);
        console.log("open:    " + u);
        openBrowser(u);
      });
      return;
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
      startServer(repoRoot, (srv) => { console.log("plans-server: " + srv.url); });
      return;
    }
    case "open": {
      const slug = rest[0];
      if (!slug) { console.error("usage: plan open <slug>"); process.exit(2); }
      startServer(repoRoot, (srv) => {
        const u = srv.url.replace(/\/(\?|$)/, "/plan/" + slug + "$1");
        console.log("open: " + u);
        openBrowser(u);
      });
      return;
    }
    default:
      console.error("usage: plan <new|open|list|serve|reconcile> ...");
      process.exit(2);
  }
}

module.exports = { planNew, planList, planReconcile, findPlan, planArtifact, startServer, openBrowser, main };

if (require.main === module) main(process.argv.slice(2));
