/**
 * web-tools/_lib/hooks.mjs  (ESM)
 *
 * PRE / ACT / POST hook helpers for individual capability scripts.
 *
 * Per the self-healing protocol every script does:
 *
 *     PRE   recallAndEmit(query, {host, op})
 *     ACT   ... real work ...
 *     POST  on success: exit 0 (NO auto-write)
 *           on failure: failAndExit({host, op, err, exitCode, ...})
 *
 * All hook calls are best-effort and NEVER throw — they swallow internal
 * errors so a flaky velocirag install can't break the actual capability.
 *
 * API:
 *   extractHost(url)                       -> string|null
 *   classifyError(err, {stderr, exit})     -> string  (e.g. "http_403")
 *   recallAndEmit(query, opts)             -> Array<hit>   (also prints to stderr)
 *   failAndExit(opts)                      -> never (calls process.exit)
 *
 * Env:
 *   WEB_HOOKS_QUIET   suppress stderr surface output (still logs failures)
 *   WEB_MEMORY_DEBUG  passthrough to _lib/memory
 */

import { createRequire } from "node:module";

// memory.js is CommonJS so we use createRequire to load it from this ESM module
const _require = createRequire(import.meta.url);
export const memory = _require("./memory.js");

const QUIET = !!process.env.WEB_HOOKS_QUIET;

function _stderr(...a) { if (!QUIET) console.error(...a); }

// ── host / url helpers ─────────────────────────────────────────────────────

export function extractHost(urlOrText) {
  if (!urlOrText) return null;
  try {
    const u = new URL(String(urlOrText));
    if (u.hostname) return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {}
  const m = String(urlOrText).match(/([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}/i);
  return m ? m[0].toLowerCase().replace(/^www\./, "") : null;
}

// ── error classifier ───────────────────────────────────────────────────────

const _CLASS_RX = [
  [/\b(403|forbidden)\b/i,                          "http_403"],
  [/\b(401|unauthor[i\s]?z?ed)\b/i,                 "http_401"],
  [/\b(404|not\s*found)\b/i,                        "http_404"],
  [/\b(429|too\s*many)\b/i,                         "http_429"],
  [/\b(5\d\d|server\s*error|bad\s*gateway)\b/i,     "http_5xx"],
  [/\b(timed?\s*out|ETIMEDOUT|deadline)\b/i,        "timeout"],
  [/\b(ENOTFOUND|getaddrinfo|dns)\b/i,              "dns"],
  [/\b(ECONNREFUSED|connection\s*refused)\b/i,      "conn_refused"],
  [/\b(ECONNRESET|socket\s*hang\s*up)\b/i,          "conn_reset"],
  [/\bcert(ificate)?|TLS|SSL|self[-\s]signed/i,     "tls"],
  [/captcha|cloudflare\s*challenge/i,               "captcha"],
  [/cookie|consent\s*banner/i,                      "consent_banner"],
  [/selector|element\s+not\s+found|no\s+node/i,     "selector_stale"],
  [/CDP|remote\s*debug|connectOverCDP/i,            "no_browser"],
  [/out\s*of\s*memory|OOM|CUDA\s*out/i,             "oom"],
  [/no\s*captions|TRANSCRIPT_UNAVAILABLE/i,         "no_transcript"],
  [/age[-\s]?gate|age\s*restricted/i,               "age_gate"],
  [/quota|rate\s*limit/i,                           "rate_limit"],
];

export function classifyError(err, ctx = {}) {
  const stderr = ctx.stderr || "";
  const exit = ctx.exit;
  const text = [
    err?.message || (typeof err === "string" ? err : ""),
    err?.stderr || "",
    stderr,
  ].join(" ");
  for (const [rx, cls] of _CLASS_RX) {
    if (rx.test(text)) return cls;
  }
  if (exit && exit !== 0) return `exit_${exit}`;
  return "unknown";
}

// ── PRE hook: recall + emit ────────────────────────────────────────────────

/**
 * recallAndEmit — fire memory.recall, pretty-print hits to stderr.
 *
 * @param {string} query
 * @param {{
 *   host?: string,           // → tags includes domain-<host>
 *   op?: string,             // → tags includes op-<op>
 *   tags?: string[],         // additional tags
 *   limit?: number,          // default 5
 *   label?: string,          // header label (default "memory")
 * }} opts
 * @returns {Array<hit>}
 */
export function recallAndEmit(query, opts = {}) {
  try {
    const tags = [...(opts.tags || [])];
    if (opts.host) tags.push(`domain-${opts.host.replace(/\./g, "-")}`);
    if (opts.op)   tags.push(`op-${opts.op}`);
    const hits = memory.recall(query, { limit: opts.limit || 5, tags }) || [];
    if (!hits.length || QUIET) return hits;
    const label = opts.label || "memory";
    _stderr(`[${label}] ${hits.length} hit${hits.length === 1 ? "" : "s"} for "${query}"${tags.length ? ` [${tags.join(", ")}]` : ""}:`);
    for (const h of hits) {
      const file = h.file || h.path || h.metadata?.file || "?";
      const score = typeof h.score === "number" ? h.score.toFixed(3) : "";
      const title = h.title || h.metadata?.title || "";
      const snippet = (h.content || h.text || h.body || "").replace(/\s+/g, " ").slice(0, 160);
      _stderr(`  • ${title || file}${score ? ` (${score})` : ""}`);
      if (snippet) _stderr(`    ${snippet}${snippet.length === 160 ? "…" : ""}`);
    }
    return hits;
  } catch { return []; }
}

// ── POST hook: log + stale warn + exit ─────────────────────────────────────

/**
 * failAndExit — log a failure record to failures.jsonl, emit a STALE warning
 * if applicable, and exit non-zero. Never throws.
 */
export function failAndExit(opts) {
  const exit = opts.exit ?? 1;
  const err = opts.err;
  const errMsg = err?.message || (typeof err === "string" ? err : String(err || "failed"));
  const errClass = opts.err_class || classifyError(err, { stderr: opts.stderr, exit });
  const host = opts.host || null;
  const op = opts.op || null;

  try {
    memory.logFailure({
      host, op, exit,
      err_class: errClass,
      err: errMsg.slice(0, 500),
      cmd: opts.cmd,
      args: opts.args,
    });
  } catch {}

  let stale = false;
  try { stale = host && op && memory.isStale(host, op, errClass); } catch {}

  const errorOut = {
    error: errMsg,
    err_class: errClass,
    host, op, exit,
    stale,
  };
  _stderr(`✗ ${op || "op"} failed: ${errMsg}`);
  _stderr(`  err_class=${errClass}${host ? ` host=${host}` : ""}`);
  if (stale) {
    _stderr(`STALE: (${host}, ${op}, ${errClass}) seen ≥2× in last 7d — recall + re-investigate.`);
    _stderr(`       velocirag search "${host} ${errClass}" --db ~/.synaps-cli/memory/web/db -l 5`);
  }
  if (opts.stdout) process.stdout.write(opts.stdout);
  _stderr(`__error_json__ ${JSON.stringify(errorOut)}`);
  process.exit(exit);
}
