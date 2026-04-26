#!/usr/bin/env node
/**
 * web-tools/_lib/memory.js
 *
 * Thin wrapper around VelociRAG for the `web` plugin namespace.
 *
 *   ~/.synaps-cli/memory/web/
 *     notes/        ← markdown files we write (source of truth)
 *     db/           ← VelociRAG's index (derived)
 *     failures.jsonl ← raw operational failure log
 *
 * All memory writes are best-effort — they NEVER fail an op.
 *
 * API:
 *   recall(query, opts?)            -> Array<MemoryHit>     [] on any failure
 *   commit(text, opts?)             -> {path, indexed}      writes a .md file
 *   logFailure(record)              -> void                 always succeeds
 *   recentFailures(host, op, ms?)   -> Array<rec>
 *   isStale(host, op, errClass)     -> bool
 *   reindex()                       -> bool
 *
 * Env:
 *   WEB_MEMORY_ROOT   override root path (default: ~/.synaps-cli/memory/web)
 *   WEB_MEMORY_DEBUG  if set, log diagnostics to stderr
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ROOT     = process.env.WEB_MEMORY_ROOT || path.join(os.homedir(), '.synaps-cli', 'memory', 'web');
const NOTES    = path.join(ROOT, 'notes');
const INDEX    = path.join(ROOT, 'db');
const FAILURES = path.join(ROOT, 'failures.jsonl');
const SOURCE   = 'web';
const TIMEOUT_MS = 5000;
const STALE_THRESHOLD = 2;
const STALE_WINDOW_MS = 7 * 24 * 3600 * 1000;
const DEBUG = !!process.env.WEB_MEMORY_DEBUG;

function dbg(...a) { if (DEBUG) console.error('[memory]', ...a); }

function ensureDirs() {
  try {
    fs.mkdirSync(NOTES, { recursive: true });
    fs.mkdirSync(INDEX, { recursive: true });
  } catch (e) { dbg('mkdir', e.message); }
}

function velociragAvailable() {
  try {
    const r = spawnSync('velocirag', ['--version'], { encoding: 'utf8', timeout: 2000 });
    return r.status === 0;
  } catch { return false; }
}

// ── tag helpers ────────────────────────────────────────────────────────────

function normalizeTags(tags) {
  if (!tags) return [];
  if (typeof tags === 'string') tags = tags.split(',');
  return tags
    .map(t => String(t).trim())
    .filter(Boolean)
    // colons → hyphens (yaml/cli safe)
    .map(t => t.replace(/:/g, '-'))
    // dots in domain values → hyphens (e.g. domain-github.com → domain-github-com)
    .map(t => t.replace(/\./g, '-'))
    .map(t => t.toLowerCase());
}

function slug(s, max = 50) {
  return String(s || 'note')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max) || 'note';
}

function shortHash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
}

function buildFrontmatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map(x => JSON.stringify(x)).join(', ')}]`);
    } else if (typeof v === 'string' && /[:#\n]/.test(v)) {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

// ── recall ─────────────────────────────────────────────────────────────────

/**
 * recall — semantic search across notes. Optional tag filter (AND semantics
 * implemented client-side because velocirag unions multiple --tags).
 *
 * @param {string} query
 * @param {{limit?:number, tags?:string|string[], threshold?:number}} opts
 * @returns {Array<{file:string, score:number, content:string}>}
 */
function recall(query, opts = {}) {
  if (!query) return [];
  ensureDirs();
  const limit = opts.limit || 5;
  const tags = normalizeTags(opts.tags);
  const args = ['search', query, '--db', INDEX, '--format', 'json', '-l', String(limit * 3)];
  if (opts.threshold) args.push('-t', String(opts.threshold));
  // pass first tag as a server-side filter (cheaper); intersect rest in JS
  if (tags.length) args.push('--tags', tags[0]);
  try {
    const r = spawnSync('velocirag', args, { encoding: 'utf8', timeout: TIMEOUT_MS });
    if (r.status !== 0) { dbg('recall non-zero', r.status, r.stderr); return []; }
    let hits;
    try { hits = JSON.parse(r.stdout || '[]'); } catch { return []; }
    if (!Array.isArray(hits)) hits = hits.results || hits.hits || [];
    if (tags.length > 1) {
      // post-filter for AND semantics — best-effort, depending on what fields velocirag returns
      const required = new Set(tags.slice(1));
      hits = hits.filter(h => {
        const hTags = new Set([...(h.tags || []), ...(h.metadata?.tags || [])]);
        for (const t of required) if (!hTags.has(t)) return false;
        return true;
      });
    }
    return hits.slice(0, limit);
  } catch (e) { dbg('recall threw', e.message); return []; }
}

// ── commit ─────────────────────────────────────────────────────────────────

/**
 * commit — write a markdown note with YAML frontmatter, then reindex.
 *
 * @param {string} text body of the note (markdown)
 * @param {{
 *   tags?: string|string[],
 *   category?: string,
 *   status?: string,       // default 'active'
 *   title?: string,
 *   kind?: string,         // shortcut → tags includes `kind-<kind>`
 *   reindex?: boolean      // default true
 * }} opts
 * @returns {{path: string|null, indexed: boolean}}
 */
function commit(text, opts = {}) {
  if (!text) return { path: null, indexed: false };
  ensureDirs();
  const tags = normalizeTags(opts.tags);
  if (opts.kind && !tags.includes(`kind-${opts.kind}`)) tags.unshift(`kind-${opts.kind}`);

  const titleRaw = opts.title || text.split('\n')[0].slice(0, 60);
  const fm = buildFrontmatter({
    tags,
    category: opts.category,
    status: opts.status || 'active',
    title: titleRaw,
    created: new Date().toISOString().slice(0, 10),
  });

  const body = text.trim().endsWith('\n') ? text : text + '\n';
  const file = path.join(NOTES, `${slug(titleRaw)}-${shortHash(text)}.md`);
  try {
    fs.writeFileSync(file, fm + body);
  } catch (e) {
    dbg('write', e.message);
    return { path: null, indexed: false };
  }

  let indexed = false;
  if (opts.reindex !== false) indexed = reindex();
  return { path: file, indexed };
}

function reindex() {
  ensureDirs();
  try {
    const r = spawnSync(
      'velocirag', ['index', NOTES, '--db', INDEX, '-s', SOURCE],
      { encoding: 'utf8', timeout: 30000 }
    );
    if (r.status !== 0) dbg('reindex non-zero', r.status, r.stderr?.slice(0, 200));
    return r.status === 0;
  } catch (e) { dbg('reindex threw', e.message); return false; }
}

// ── failures ───────────────────────────────────────────────────────────────

function logFailure(rec) {
  try {
    ensureDirs();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n';
    fs.appendFileSync(FAILURES, line);
  } catch (e) { dbg('logFailure', e.message); }
}

function readFailures() {
  try {
    if (!fs.existsSync(FAILURES)) return [];
    return fs.readFileSync(FAILURES, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (e) { dbg('readFailures', e.message); return []; }
}

function recentFailures(host, op, sinceMs = STALE_WINDOW_MS) {
  const cutoff = Date.now() - sinceMs;
  return readFailures().filter(r =>
    r.host === host &&
    r.op === op &&
    new Date(r.ts).getTime() >= cutoff
  );
}

function isStale(host, op, errClass) {
  return recentFailures(host, op).filter(r => r.err_class === errClass).length >= STALE_THRESHOLD;
}

module.exports = {
  ROOT, NOTES, INDEX, FAILURES, SOURCE,
  velociragAvailable,
  recall, commit, reindex,
  logFailure, recentFailures, isStale,
};
