/*
 * verdict.js — oracle/1 verdict egress contract (spec §4.2, §8 "verdict
 * minimization"). The sandbox's ONLY output channel. A verdict carries
 * pass/fail counts + failure CATEGORY codes + audit ids + nonce, and NOTHING
 * that could reconstruct the hidden suite: no test source, asserted values,
 * raw inputs, or hidden file paths. The validator rejects leaks on both ends.
 * Node stdlib only.
 */
"use strict";

// Failure categories are tied to the contract's error taxonomy + oracle gates.
const CATEGORY_TAXONOMY = [
  "validation-error", "schema-mismatch", "illegal-transition", "path-escape",
  "write-confinement-violation", "cap-exceeded", "not-found", "bad-request",
  "forbidden", "too-many-streams", "internal-error", "crash",
  // oracle gate categories
  "property-violation", "mutant-survived", "fuzz-crash", "twin-divergence",
  "append-only-violation", "loopback-violation", "missing-behavior",
];

function err(category, message) { const e = new Error(message); e.category = category; return e; }

// Heuristics that detect leaked secrets in a verdict (defense in depth).
const LEAK_SIGNATURES = [
  /assert/i, /expect\(/i, /toEqual/i, /\bit\(/, /\btest\(/,
  /\.hidden\//, /\/hidden\//, /require\(/, /=>/, /function\s*\(/,
  /\bexpected\b\s*[:=]/i, /actual\s*[:=]/i,
];

function looksLikeLeak(value, depth) {
  depth = depth || 0;
  if (depth > 6) return false;
  if (typeof value === "string") {
    if (value.length > 2000) return true; // verdicts are tiny; large strings smell like source
    return LEAK_SIGNATURES.some((re) => re.test(value));
  }
  if (Array.isArray(value)) return value.some((v) => looksLikeLeak(v, depth + 1));
  if (value && typeof value === "object") return Object.values(value).some((v) => looksLikeLeak(v, depth + 1));
  return false;
}

const ALLOWED_TOP_KEYS = new Set([
  "schema", "kind", "round", "counts", "categories", "audit_id", "nonce", "lineage", "ts", "adversary",
]);

/**
 * Validate a verdict object. Returns the verdict on success; throws categorized
 * error on malformed shape OR a detected leak.
 */
function parseVerdict(raw) {
  let v = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch (e) { throw err("validation-error", "verdict not valid JSON"); }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw err("validation-error", "verdict must be an object");
  if (v.schema !== "oracle/1") throw err("schema-mismatch", "verdict schema must be oracle/1");
  if (v.kind !== "verdict") throw err("schema-mismatch", "verdict.kind must be 'verdict'");

  // No unexpected top-level keys (prevents smuggling source under arbitrary keys).
  for (const k of Object.keys(v)) {
    if (!ALLOWED_TOP_KEYS.has(k)) throw err("egress-leak", "verdict carries forbidden key: " + k);
  }

  if (!v.counts || typeof v.counts.pass !== "number" || typeof v.counts.fail !== "number") {
    throw err("validation-error", "verdict.counts {pass,fail} required");
  }
  if (!Array.isArray(v.categories)) throw err("validation-error", "verdict.categories[] required");
  for (const c of v.categories) {
    const code = typeof c === "string" ? c : c && c.category;
    if (!CATEGORY_TAXONOMY.includes(code)) throw err("egress-leak", "verdict category not in taxonomy: " + JSON.stringify(c));
    // category entries may carry a count only — no free-form payloads
    if (c && typeof c === "object") {
      for (const k of Object.keys(c)) {
        if (k !== "category" && k !== "count") throw err("egress-leak", "category entry carries forbidden field: " + k);
      }
    }
  }
  if (typeof v.audit_id !== "string" || !v.audit_id) throw err("validation-error", "verdict.audit_id required");
  if (typeof v.nonce !== "string" || !v.nonce) throw err("validation-error", "verdict.nonce required");

  // Final leak sweep across the whole object.
  if (looksLikeLeak(v)) throw err("egress-leak", "verdict appears to leak test source / asserted values");
  return v;
}

/** Build a minimal, valid verdict from raw counts + category codes. */
function makeVerdict(opts) {
  opts = opts || {};
  const categories = (opts.categories || []).map((c) => (typeof c === "string" ? { category: c, count: 1 } : c));
  const v = {
    schema: "oracle/1", kind: "verdict",
    round: opts.round != null ? opts.round : 0,
    counts: { pass: opts.pass || 0, fail: opts.fail || 0 },
    categories,
    audit_id: opts.audit_id || ("aud_" + Math.random().toString(16).slice(2, 10)),
    nonce: opts.nonce || Math.random().toString(16).slice(2, 18),
  };
  if (opts.lineage) v.lineage = opts.lineage;
  if (opts.ts) v.ts = opts.ts;
  return parseVerdict(v);
}

module.exports = { parseVerdict, makeVerdict, CATEGORY_TAXONOMY, looksLikeLeak };
