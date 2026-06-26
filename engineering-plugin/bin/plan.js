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
const themeLib = require("../lib/theme.js");

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
  // Best-effort: seed a deterministic per-repo theme so the served site has a
  // fitting identity from the first scaffold. Never blocks the scaffold, never
  // overwrites an operator/LLM-authored theme.
  try { seedThemeIfMissing(repoRoot); } catch (_) {}
  return { file, plansDir, assetsOut, plan };
}

// ---- theme (engtheme/1) CLI surface (DT-3) ----
function themeFilePath(repoRoot) { return path.join(repoRoot, ".plans", "theme.json"); }

// Write a theme object to .plans/theme.json (pretty). Ensures .plans exists.
function writeThemeFile(repoRoot, theme) {
  const dir = path.join(repoRoot, ".plans");
  fs.mkdirSync(dir, { recursive: true });
  const file = themeFilePath(repoRoot);
  fs.writeFileSync(file, JSON.stringify(theme, null, 2) + "\n");
  return file;
}

// `plan theme` — current resolved theme + source.
function planThemeShow(repoRoot) {
  const t = themeLib.resolveTheme(repoRoot);
  const source = t._source || "default";
  return { theme: t, source };
}

// `plan theme --infer` — write the deterministic inferred theme.
function planThemeInfer(repoRoot) {
  const t = themeLib.inferTheme(repoRoot);
  t.generated_by = "inferred";
  t.generated_at = new Date().toISOString();
  delete t._source;
  const file = writeThemeFile(repoRoot, t);
  return { file, theme: t };
}

// Seed a theme only when none exists (best-effort, used by `plan new`).
function seedThemeIfMissing(repoRoot) {
  if (fs.existsSync(themeFilePath(repoRoot))) return null;
  return planThemeInfer(repoRoot);
}

// `plan theme --write <file|->` — validate (strict) then write. Returns
// { ok, errors[], file?, theme? } and NEVER throws; the CLI maps ok→exit code.
function planThemeWrite(repoRoot, jsonText) {
  let obj;
  try { obj = JSON.parse(jsonText); }
  catch (e) { return { ok: false, errors: ["invalid JSON: " + String(e.message)] }; }
  const { theme, errors } = themeLib.parseThemeStrict(obj);
  if (errors && errors.length) return { ok: false, errors, theme };
  theme.generated_by = "llm";
  theme.generated_at = new Date().toISOString();
  delete theme._source;
  const file = writeThemeFile(repoRoot, theme);
  return { ok: true, errors: [], file, theme };
}

// `plan theme --digest` — a compact, prompt-ready blob for an LLM to consume:
// title candidates, detected languages, brand colors found, README excerpt,
// the current resolved theme, the engtheme/1 schema, and the font registry.
function planThemeDigest(repoRoot) {
  const read = (p, max) => { try { const s = fs.statSync(path.join(repoRoot, p)); if (!s.isFile() || s.size > (max || 200000)) return null; return fs.readFileSync(path.join(repoRoot, p), "utf8"); } catch (_) { return null; } };
  const exists = (p) => { try { return fs.existsSync(path.join(repoRoot, p)); } catch (_) { return false; } };

  // title candidates
  const candidates = [];
  const pkg = read("package.json"); let pkgObj = null;
  if (pkg) { try { pkgObj = JSON.parse(pkg); } catch (_) {} }
  if (pkgObj && pkgObj.name) candidates.push("package.json name: " + pkgObj.name + (pkgObj.description ? "  — " + pkgObj.description : ""));
  const cargo = read("Cargo.toml");
  if (cargo) { const m = cargo.match(/\[package\][\s\S]*?\bname\s*=\s*"([^"]+)"/); if (m) candidates.push("Cargo.toml name: " + m[1]); }
  const py = read("pyproject.toml");
  if (py) { const m = py.match(/\bname\s*=\s*"([^"]+)"/); if (m) candidates.push("pyproject name: " + m[1]); }
  let readme = read("README.md") || read("README.MD") || read("Readme.md") || read("README");
  if (readme) { const h1 = readme.match(/^#\s+(.+)$/m); if (h1) candidates.push("README H1: " + h1[1].trim()); }
  candidates.push("directory name: " + path.basename(repoRoot));

  // languages
  const langs = [];
  if (pkgObj) langs.push("JavaScript/Node");
  if (exists("tsconfig.json")) langs.push("TypeScript");
  if (cargo) langs.push("Rust");
  if (py || exists("requirements.txt") || exists("setup.py")) langs.push("Python");
  if (exists("go.mod")) langs.push("Go");

  // brand colors (reuse the inference scan via a hex sample)
  let accent = null; try { accent = themeLib.inferAccent(repoRoot); } catch (_) {}

  // README excerpt
  let excerpt = "";
  if (readme) excerpt = readme.replace(/^#.*$/m, "").replace(/\s+/g, " ").trim().slice(0, 400);

  // current theme
  const cur = planThemeShow(repoRoot);

  // font registry
  const families = themeLib.FONT_FAMILIES.map((f) => "  - " + f.name + "  (" + f.stack + ")").join("\n");
  const systems = themeLib.SYSTEM_STACKS.map((s) => "  - " + s.id + "  (" + s.stack + ")").join("\n");
  const pairings = Object.keys(themeLib.FONT_PAIRINGS).map((k) => "  - " + k + ": " + themeLib.FONT_PAIRINGS[k].display + " + " + themeLib.FONT_PAIRINGS[k].ui).join("\n");
  const paletteKeys = themeLib.PALETTE_KEYS.join(", ");

  return [
    "=== REPO DIGEST (for engtheme/1 generation) ===",
    "",
    "Title candidates (pick/refine the most human, fitting one):",
    candidates.map((c) => "  - " + c).join("\n"),
    "",
    "Detected languages: " + (langs.length ? langs.join(", ") : "(none detected)"),
    "Discovered brand color: " + (accent || "(none found — choose a fitting accent)"),
    "",
    "README excerpt:",
    "  " + (excerpt || "(no README)"),
    "",
    "Current resolved theme: source=" + cur.source + ", title=" + JSON.stringify(cur.theme.title) +
      ", accent=" + cur.theme.palette.accent + ", fonts=" + cur.theme.fonts.display + "/" + cur.theme.fonts.ui,
    "",
    "=== engtheme/1 SCHEMA ===",
    'schema: "engtheme/1" (required)',
    "title: string <=80 (sanitized to text)",
    "tagline: string <=140 (optional)",
    "monogram: string <=3 (optional; else derived from title initials)",
    "palette: object — EVERY value must be a strict color (#rgb | #rrggbb | #rrggbbaa | rgb()/rgba() numeric).",
    "  keys: " + paletteKeys,
    "fonts: { display, ui } — family name from the registry below (case-insensitive) OR a system-stack id.",
    'generated_by: "llm" (set automatically by `plan theme --write`)',
    "rationale: short note on why these choices fit the project (optional)",
    "",
    "=== BUNDLED FONT REGISTRY (local, no CDN) ===",
    "Display/UI families:",
    families,
    "System stacks (always available, no @font-face):",
    systems,
    "Suggested pairings (display + ui):",
    pairings,
    "",
    "=== GUIDANCE ===",
    "Choose a title/tagline/monogram + palette + font pairing that FIT the project's domain & vibe.",
    "Ensure contrast/legibility (text on bg, accent on surface). Keep the palette cohesive.",
    'Return ONLY schema-valid JSON, then run: plan theme --write <file.json>  (or pipe via stdin: plan theme --write -)',
    "",
  ].join("\n");
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
    case "theme": {
      const flag = rest[0];
      if (!flag) {
        const r = planThemeShow(repoRoot);
        console.log("theme source: " + r.source);
        console.log(JSON.stringify(r.theme, null, 2));
        return;
      }
      if (flag === "--infer") {
        const r = planThemeInfer(repoRoot);
        console.log("wrote " + path.relative(repoRoot, r.file) + " (inferred): " + r.theme.title);
        return;
      }
      if (flag === "--digest") {
        console.log(planThemeDigest(repoRoot));
        return;
      }
      if (flag === "--write") {
        const target = rest[1];
        if (!target) { console.error("usage: plan theme --write <file.json|->"); process.exit(2); }
        let jsonText;
        try { jsonText = (target === "-") ? fs.readFileSync(0, "utf8") : fs.readFileSync(target, "utf8"); }
        catch (e) { console.error("could not read theme: " + String(e.message)); process.exit(2); }
        const r = planThemeWrite(repoRoot, jsonText);
        if (!r.ok) {
          console.error("theme rejected — NOT written:");
          for (const e of r.errors) console.error("  - " + e);
          process.exit(1);
        }
        console.log("wrote " + path.relative(repoRoot, r.file) + " (llm): " + r.theme.title);
        return;
      }
      console.error("usage: plan theme [--infer | --digest | --write <file|->]");
      process.exit(2);
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
      console.error("usage: plan <new|open|list|serve|status|down|reconcile|theme> ...");
      process.exit(2);
  }
}

module.exports = { planNew, planList, planReconcile, findPlan, planArtifact, startServer, openBrowser, main,
  planStatus, planDown, ensurePlanServer, planOpen, planServeForeground, planUrl,
  planThemeShow, planThemeInfer, planThemeWrite, planThemeDigest, seedThemeIfMissing, writeThemeFile };

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
