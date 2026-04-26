/**
 * _lib/frontmatter.mjs — minimal YAML frontmatter parser + `covers:` matcher.
 *
 * Just enough YAML to support the shapes we actually use in note frontmatter:
 *   - scalar:  `key: value`
 *   - quoted:  `key: "value with: colon"`  /  `key: 'value'`
 *   - inline:  `key: ["a", "b", "c"]`  /  `key: [a, b]`
 *   - block:   `key:\n  - "value1"\n  - "value2"`
 *
 * NOT supported (and we don't need): nested maps, anchors, multi-line scalars,
 * literal/folded blocks, type tags. If you need those, swap in a real YAML
 * library (e.g. `yaml` from npm) — the parser is intentionally local to keep
 * the consolidator dependency-free.
 *
 * The `covers:` field uses the same encoding as the consolidator's bucket key:
 *   "host|op|err_class"  with `*` as wildcard for any field.
 *
 * Example:
 *   covers:
 *     - "youtube.com|youtube-transcript|no_transcript"
 *     - "youtube.com|transcript|no_transcript"
 */

import fs from "node:fs";
import path from "node:path";

// ── parseFrontmatter ───────────────────────────────────────────────────────

/**
 * Split a markdown document into `{fm, body}`.
 *
 * Frontmatter must be a `---` delimited YAML block at the very top of the
 * file (line 1). Anything else: `fm` is `{}` and `body` is the input.
 *
 * @param {string} raw
 * @returns {{fm: Record<string, any>, body: string}}
 */
export function parseFrontmatter(raw) {
  if (!raw || typeof raw !== "string") return { fm: {}, body: raw || "" };
  if (!raw.startsWith("---")) return { fm: {}, body: raw };

  const lines = raw.split("\n");
  // Line 0 is the opening "---". Find the closing one.
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "...") { close = i; break; }
  }
  if (close < 0) return { fm: {}, body: raw };

  const fmLines = lines.slice(1, close);
  const body = lines.slice(close + 1).join("\n");
  const fm = parseYamlBlock(fmLines);
  return { fm, body };
}

/**
 * Parse a YAML block (already split into lines, without the --- delimiters).
 * Supports scalars, quoted scalars, inline arrays, and block sequences.
 *
 * @param {string[]} lines
 * @returns {Record<string, any>}
 */
function parseYamlBlock(lines) {
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // skip comments and blanks
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }

    // top-level key only (no leading whitespace on the key line)
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }

    const key = m[1];
    const rest = m[2];

    if (rest === "") {
      // possible block sequence on following lines
      const seq = [];
      let j = i + 1;
      while (j < lines.length) {
        const sub = lines[j];
        if (!sub.trim() || sub.trim().startsWith("#")) { j++; continue; }
        const sm = sub.match(/^\s+-\s+(.*)$/);
        if (!sm) break;
        seq.push(parseScalar(sm[1]));
        j++;
      }
      out[key] = seq;
      i = j;
      continue;
    }

    // inline array: [a, b, c]
    if (rest.startsWith("[") && rest.endsWith("]")) {
      out[key] = parseInlineArray(rest);
      i++;
      continue;
    }

    // plain or quoted scalar
    out[key] = parseScalar(rest);
    i++;
  }
  return out;
}

function parseScalar(s) {
  if (s == null) return s;
  let v = s.trim();
  // strip trailing comments only when not inside quotes
  if (!(v.startsWith('"') || v.startsWith("'"))) {
    const hash = v.indexOf(" #");
    if (hash >= 0) v = v.slice(0, hash).trim();
  }
  if (v.length >= 2) {
    const first = v[0], last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

function parseInlineArray(s) {
  // strip [ ]
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  // split on commas not inside quotes
  const items = [];
  let buf = "";
  let q = null; // current quote char
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) {
      buf += c;
      if (c === q && inner[i - 1] !== "\\") q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; buf += c; continue; }
    if (c === ",") { items.push(buf.trim()); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) items.push(buf.trim());
  return items.map(parseScalar);
}

// ── covers helpers ─────────────────────────────────────────────────────────

/**
 * Build the canonical bucket key for a failure tuple.
 * Missing/null fields become `*`.
 *
 * @param {{host?: string|null, op?: string|null, err_class?: string|null}} t
 * @returns {string}
 */
export function bucketKey(t = {}) {
  const h = t.host ?? "*";
  const o = t.op ?? "*";
  const e = t.err_class ?? "*";
  return `${h || "*"}|${o || "*"}|${e || "*"}`;
}

/**
 * Test if a failure tuple is matched by a covered-tuple set.
 * Each entry in the set is a bucketKey-format string, with `*` as wildcard
 * for any field.
 *
 * @param {{host, op, err_class}} t
 * @param {Set<string>} covers
 * @returns {boolean}
 */
export function isCovered(t, covers) {
  if (!covers || covers.size === 0) return false;
  const h = t.host ?? "*", o = t.op ?? "*", e = t.err_class ?? "*";
  // exact triple
  if (covers.has(`${h}|${o}|${e}`)) return true;
  // each axis can be wildcarded individually
  const candidates = [
    `*|${o}|${e}`,
    `${h}|*|${e}`,
    `${h}|${o}|*`,
    `*|*|${e}`,
    `*|${o}|*`,
    `${h}|*|*`,
    `*|*|*`,
  ];
  for (const c of candidates) if (covers.has(c)) return true;
  return false;
}

/**
 * Walk a notes directory, parse the frontmatter of each `*.md` file,
 * and return the union of all `covers:` arrays as a Set.
 *
 * Errors (missing dir, malformed file, unreadable) are swallowed — this is
 * advisory infrastructure that must never break the consolidator.
 *
 * @param {string} notesDir
 * @returns {Set<string>}
 */
export function loadCoveredTuples(notesDir) {
  const out = new Set();
  let entries;
  try {
    entries = fs.readdirSync(notesDir, { withFileTypes: true });
  } catch { return out; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith(".md")) continue;
    const full = path.join(notesDir, ent.name);
    let raw;
    try { raw = fs.readFileSync(full, "utf8"); } catch { continue; }
    let fm;
    try { ({ fm } = parseFrontmatter(raw)); } catch { continue; }
    const c = fm?.covers;
    if (!Array.isArray(c)) continue;
    for (const item of c) {
      if (typeof item === "string" && item.includes("|")) out.add(item);
    }
  }
  return out;
}
