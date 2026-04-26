#!/usr/bin/env node
/**
 * web-status — Memory + failure dashboard for the `web` plugin.
 *
 * Surfaces:
 *   - Note counts (total, by kind, by status)
 *   - Failure counts (total, 1d, 7d)
 *   - Top recurring (host, op, err_class) tuples
 *   - Stale signals (≥2× same tuple in 7d) with suggested next actions
 *   - VelociRAG health (db present? indexable?)
 *
 * Flags:
 *   --json                Machine-readable output
 *   --since DURATION      Only count failures within window (e.g. 1h, 24h, 7d, 30d)
 *   --top N               Top-N recurring patterns (default 10)
 *   --host HOST           Filter by host
 *   --op OP               Filter by op
 *   --purge-old DAYS      Truncate failures.jsonl to entries newer than DAYS
 *   --json-failures       Print failures.jsonl as a JSON array (for piping)
 */

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const _require = createRequire(import.meta.url);
const memory = _require("../_lib/memory.js");

// ── arg parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.flags.help = true;
    else if (a === "--json") out.flags.json = true;
    else if (a === "--json-failures") out.flags.jsonFailures = true;
    else if (a === "--since") out.flags.since = argv[++i];
    else if (a === "--top") out.flags.top = parseInt(argv[++i], 10);
    else if (a === "--host") out.flags.host = argv[++i];
    else if (a === "--op") out.flags.op = argv[++i];
    else if (a === "--purge-old") out.flags.purgeOld = parseInt(argv[++i], 10);
    else out._.push(a);
  }
  return out;
}

function parseDuration(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([smhdw])?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "h").toLowerCase();
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
  return n * mult;
}

function help() {
  console.log(`Usage: web-status [options]

Options:
  --json                  Machine-readable JSON output
  --since DURATION        Filter failures (e.g. 1h, 24h, 7d, 30d)
  --top N                 Top-N recurring tuples (default 10)
  --host HOST             Filter by host
  --op OP                 Filter by op
  --purge-old DAYS        Truncate failures.jsonl older than DAYS
  --json-failures         Dump failures.jsonl as a JSON array

Examples:
  web-status                          # full dashboard
  web-status --since 24h --top 5      # last 24h, top 5
  web-status --json                   # JSON for piping
  web-status --host github.com        # only github.com failures
  web-status --purge-old 30           # trim raw log
`);
}

// ── notes inventory ────────────────────────────────────────────────────────

function inventoryNotes() {
  const result = {
    total: 0,
    by_kind: {},
    by_status: {},
    by_domain: {},
    notes: [],
  };
  if (!fs.existsSync(memory.NOTES)) return result;
  const files = fs.readdirSync(memory.NOTES).filter(f => f.endsWith(".md"));
  result.total = files.length;
  for (const f of files) {
    const full = path.join(memory.NOTES, f);
    let raw;
    try { raw = fs.readFileSync(full, "utf8"); } catch { continue; }
    const fm = parseFrontmatter(raw);
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    const kind = tags.find(t => t.startsWith("kind-"))?.slice(5) || "uncategorized";
    const domain = tags.find(t => t.startsWith("domain-"))?.slice(7) || "n/a";
    const status = fm.status || "active";
    result.by_kind[kind] = (result.by_kind[kind] || 0) + 1;
    result.by_status[status] = (result.by_status[status] || 0) + 1;
    result.by_domain[domain] = (result.by_domain[domain] || 0) + 1;
    result.notes.push({
      file: f,
      title: fm.title || f,
      kind, domain, status,
      tags,
      created: fm.created,
    });
  }
  return result;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z_][a-z0-9_-]*):\s*(.*)$/i);
    if (!kv) continue;
    const [, k, raw] = kv;
    let v = raw.trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      // crude inline list parse: ["a","b"] or [a, b]
      v = v.slice(1, -1).split(",").map(x => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else if (v.startsWith('"') && v.endsWith('"')) {
      try { v = JSON.parse(v); } catch {}
    }
    out[k] = v;
  }
  return out;
}

// ── failures aggregation ───────────────────────────────────────────────────

function loadFailures() {
  if (!fs.existsSync(memory.FAILURES)) return [];
  const raw = fs.readFileSync(memory.FAILURES, "utf8");
  return raw.split("\n").filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function summarizeFailures(failures, opts = {}) {
  const now = Date.now();
  const sinceMs = opts.since ? parseDuration(opts.since) : null;
  const cutoff = sinceMs ? now - sinceMs : 0;

  const filtered = failures.filter(r => {
    if (opts.host && r.host !== opts.host) return false;
    if (opts.op && r.op !== opts.op) return false;
    if (cutoff && new Date(r.ts).getTime() < cutoff) return false;
    return true;
  });

  const day = now - 86400000;
  const week = now - 7 * 86400000;
  const counts = {
    total: filtered.length,
    last_24h: filtered.filter(r => new Date(r.ts).getTime() >= day).length,
    last_7d:  filtered.filter(r => new Date(r.ts).getTime() >= week).length,
  };

  // tally by tuple
  const tuples = new Map();
  for (const r of filtered) {
    const key = `${r.host || "-"}\t${r.op || "-"}\t${r.err_class || "unknown"}`;
    if (!tuples.has(key)) {
      tuples.set(key, {
        host: r.host || null,
        op: r.op || null,
        err_class: r.err_class || "unknown",
        count: 0,
        first_seen: r.ts,
        last_seen: r.ts,
        sample_err: r.err,
      });
    }
    const t = tuples.get(key);
    t.count++;
    if (r.ts < t.first_seen) t.first_seen = r.ts;
    if (r.ts > t.last_seen) t.last_seen = r.ts;
  }

  const sorted = [...tuples.values()].sort((a, b) =>
    b.count - a.count || (b.last_seen.localeCompare(a.last_seen))
  );

  // stale = ≥2 in last 7d
  for (const t of sorted) {
    const recentCount = filtered.filter(r =>
      r.host === t.host && r.op === t.op && r.err_class === t.err_class &&
      new Date(r.ts).getTime() >= week
    ).length;
    t.recent_7d = recentCount;
    t.stale = recentCount >= 2;
  }

  // tally by err_class (for high-level overview)
  const byClass = {};
  for (const r of filtered) {
    byClass[r.err_class || "unknown"] = (byClass[r.err_class || "unknown"] || 0) + 1;
  }
  const byHost = {};
  for (const r of filtered) {
    if (!r.host) continue;
    byHost[r.host] = (byHost[r.host] || 0) + 1;
  }
  const byOp = {};
  for (const r of filtered) {
    if (!r.op) continue;
    byOp[r.op] = (byOp[r.op] || 0) + 1;
  }

  return { counts, tuples: sorted, by_class: byClass, by_host: byHost, by_op: byOp };
}

// ── velocirag health ───────────────────────────────────────────────────────

function veloHealth() {
  const out = {
    available: false,
    version: null,
    db_path: memory.INDEX,
    db_exists: false,
    db_size_bytes: 0,
  };
  try {
    const r = spawnSync("velocirag", ["--version"], { encoding: "utf8", timeout: 2000 });
    if (r.status === 0) {
      out.available = true;
      out.version = (r.stdout || "").trim();
    }
  } catch {}
  try {
    if (fs.existsSync(memory.INDEX)) {
      out.db_exists = true;
      out.db_size_bytes = dirSize(memory.INDEX);
    }
  } catch {}
  return out;
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += dirSize(p);
      else { try { total += fs.statSync(p).size; } catch {} }
    }
  } catch {}
  return total;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// ── purge ──────────────────────────────────────────────────────────────────

function purgeOld(days) {
  if (!fs.existsSync(memory.FAILURES)) return { kept: 0, removed: 0 };
  const cutoff = Date.now() - days * 86400000;
  const before = loadFailures();
  const kept = before.filter(r => new Date(r.ts).getTime() >= cutoff);
  const tmp = memory.FAILURES + ".tmp";
  fs.writeFileSync(tmp, kept.map(r => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""));
  fs.renameSync(tmp, memory.FAILURES);
  return { kept: kept.length, removed: before.length - kept.length };
}

// ── render ─────────────────────────────────────────────────────────────────

function render(report, flags) {
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  const { notes, failures, velo } = report;
  const top = flags.top || 10;

  console.log("┌─ web-tools status " + "─".repeat(60));
  console.log(`│  memory root:  ${memory.ROOT}`);
  console.log(`│  velocirag:    ${velo.available ? `✓ ${velo.version}` : "✗ unavailable"}`);
  console.log(`│  db:           ${velo.db_exists ? `✓ ${fmtBytes(velo.db_size_bytes)}` : "✗ not yet built"}`);
  console.log("├─ notes ─────────────────────────────────────────────────────────────");
  console.log(`│  total: ${notes.total}`);
  if (notes.total) {
    const kindLine = Object.entries(notes.by_kind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`).join("  ");
    console.log(`│  by kind:    ${kindLine || "—"}`);
    const domains = Object.entries(notes.by_domain)
      .filter(([d]) => d !== "n/a")
      .sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (domains.length) {
      console.log(`│  top domains: ${domains.map(([d, n]) => `${d}=${n}`).join("  ")}`);
    }
  }

  console.log("├─ failures ──────────────────────────────────────────────────────────");
  console.log(`│  total: ${failures.counts.total}   last_24h: ${failures.counts.last_24h}   last_7d: ${failures.counts.last_7d}`);
  if (Object.keys(failures.by_class).length) {
    const top3 = Object.entries(failures.by_class)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([k, n]) => `${k}=${n}`).join("  ");
    console.log(`│  by class:   ${top3}`);
  }
  if (Object.keys(failures.by_host).length) {
    const topH = Object.entries(failures.by_host)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([k, n]) => `${k}=${n}`).join("  ");
    console.log(`│  by host:    ${topH}`);
  }
  if (Object.keys(failures.by_op).length) {
    const topO = Object.entries(failures.by_op)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([k, n]) => `${k}=${n}`).join("  ");
    console.log(`│  by op:      ${topO}`);
  }

  if (failures.tuples.length) {
    console.log(`├─ top recurring tuples (host, op, err_class) — top ${top} ───────────`);
    const max = Math.min(top, failures.tuples.length);
    for (let i = 0; i < max; i++) {
      const t = failures.tuples[i];
      const tag = t.stale ? " ⚠ STALE" : "";
      console.log(`│  ${String(t.count).padStart(3)}× ${t.host || "-"}  ${t.op || "-"}  ${t.err_class}${tag}`);
      console.log(`│        last: ${t.last_seen}  recent_7d: ${t.recent_7d}`);
      if (t.sample_err) console.log(`│        ↳ ${String(t.sample_err).slice(0, 100)}`);
    }
  }

  // suggested next actions
  const stale = failures.tuples.filter(t => t.stale);
  if (stale.length) {
    console.log("├─ suggested next actions ───────────────────────────────────────────");
    for (const t of stale.slice(0, 5)) {
      console.log(`│  • (${t.host}, ${t.op}, ${t.err_class}) is stale — try:`);
      console.log(`│      velocirag search "${t.host} ${t.err_class}" --db ${memory.INDEX} -l 5`);
      console.log(`│      → if no useful note, run: web-consolidate --host ${t.host} --op ${t.op}`);
      const advice = adviceFor(t);
      if (advice) console.log(`│      ${advice}`);
    }
  } else if (failures.counts.total) {
    console.log("├─ healthy ─────────────────────────────────────────────────────────");
    console.log("│  no stale tuples (each pattern <2× in last 7d).");
  }
  console.log("└" + "─".repeat(70));
}

function adviceFor(t) {
  const c = t.err_class;
  const advice = {
    http_403:       "→ may need cookies / auth header / different UA — try `browser` capability",
    http_429:       "→ rate-limited — back off, add delay, or rotate API key",
    http_404:       "→ verify URL/path — check `github tree` or site search",
    http_5xx:       "→ upstream issue — retry later, check status page",
    timeout:        "→ slow upstream — increase --timeout, or use --render for SPA",
    dns:            "→ host not resolving — check spelling, network, or DNS",
    captcha:        "→ likely needs `browser` with stealth, or human-in-the-loop",
    consent_banner: "→ use `browser-pick` to dismiss, or fetch with cookies set",
    needs_render:   "→ retry with `fetch --render` (JS-heavy SPA)",
    no_transcript:  "→ try `youtube --lang LANG` or fall back to `transcribe` (audio→text)",
    selector_stale: "→ DOM changed — re-pick with `browser-pick`",
    oom:            "→ use a smaller whisper model (--model tiny|base|small)",
    rate_limit:     "→ wait, then retry; or upgrade API tier",
    bad_json:       "→ upstream returned HTML/error page — inspect raw with `fetch --raw`",
    not_found:      "→ resource missing — verify ID/title/path",
  };
  return advice[c] || "";
}

// ── main ───────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
if (args.flags.help) { help(); process.exit(0); }

if (args.flags.purgeOld != null) {
  if (!Number.isFinite(args.flags.purgeOld) || args.flags.purgeOld < 0) {
    console.error("--purge-old DAYS must be a non-negative number");
    process.exit(2);
  }
  const r = purgeOld(args.flags.purgeOld);
  console.log(`purged: kept ${r.kept}, removed ${r.removed} (older than ${args.flags.purgeOld} days)`);
  process.exit(0);
}

if (args.flags.jsonFailures) {
  process.stdout.write(JSON.stringify(loadFailures(), null, 2) + "\n");
  process.exit(0);
}

const allFailures = loadFailures();
const failures = summarizeFailures(allFailures, {
  since: args.flags.since,
  host:  args.flags.host,
  op:    args.flags.op,
});
const notes = inventoryNotes();
const velo = veloHealth();

const report = {
  generated_at: new Date().toISOString(),
  filters: {
    since: args.flags.since || null,
    host:  args.flags.host || null,
    op:    args.flags.op || null,
  },
  velo,
  notes: {
    total: notes.total,
    by_kind: notes.by_kind,
    by_status: notes.by_status,
    by_domain: notes.by_domain,
  },
  failures,
};

render(report, args.flags);
