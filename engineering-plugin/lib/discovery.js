/*
 * discovery.js — bounded repo scan for plan/spec artifacts. Spec §6, §7.2.
 * Plan P1-3. Ignores .git/node_modules; depth + file-count bounds.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const EngPlan = require("../assets/engplan.js");
const inbox = require("./inbox.js");
const store = require("./store.js");

const IGNORE = new Set([".git", "node_modules", ".worktrees", "target", "__pycache__"]);
const DEFAULTS = { maxDepth: 8, maxFiles: 5000 };

function extractPlanJson(htmlText) {
  // pull <script id="plan" type="application/json">...</script>
  const m = htmlText.match(/<script\s+id=["']plan["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

function discover(repoRoot, opts) {
  opts = opts || {};
  const limits = Object.assign({}, DEFAULTS, opts.limits || {});
  const results = [];
  let fileCount = 0;
  let truncated = false;

  function walk(dir, depth) {
    if (depth > limits.maxDepth || truncated) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      if (truncated) return;
      const name = ent.name;
      if (IGNORE.has(name)) continue;
      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && /\.(plan|spec)\.html$/.test(name)) {
        if (++fileCount > limits.maxFiles) { truncated = true; return; }
        try {
          const txt = fs.readFileSync(full, "utf8");
          const json = extractPlanJson(txt);
          if (!json) continue;
          let plan;
          try { plan = EngPlan.parseEngPlan(json); } catch (_) { continue; } // skip malformed
          const rel = path.relative(repoRoot, full);
          let attention = { blocking: 0, unresolved: 0, needs_review: 0 };
          try {
            const { events } = store.readNotes(repoRoot, plan.slug);
            const a = inbox.computeAttention(events, plan);
            attention = { blocking: a.blocking, unresolved: a.unresolved, needs_review: a.needs_review };
          } catch (_) {}
          let mtime = null;
          try { mtime = fs.statSync(full).mtime.toISOString(); } catch (_) {}
          results.push({
            id: plan.slug,
            title: plan.title,
            kind: plan.kind,
            status: plan.status,
            mtime,
            path: rel,
            attention,
          });
        } catch (_) { /* skip unreadable/malformed */ }
      }
    }
  }
  walk(repoRoot, 0);
  return { plans: results, truncated };
}

module.exports = { discover, extractPlanJson, DEFAULTS };
