#!/usr/bin/env node
/**
 * web-consolidate — Propose memory notes from recurring failures.
 *
 * The flow:
 *   1. Scan failures.jsonl for recurring (host, op, err_class) tuples.
 *   2. For each above the threshold (default ≥2), gather sample failures.
 *   3. Draft a markdown note (frontmatter + body template).
 *   4. By default: print to stdout (dry-run). Caller decides what to do.
 *      --commit  → write to notes/ and reindex
 *      --draft DIR → save .md files for human review
 *
 * This is the "review-gated" consolidator: scripts auto-log raw failures,
 * but curated notes only land via this command (agent-driven or human-driven).
 *
 * Flags:
 *   --threshold N      Minimum recurrence count (default 2)
 *   --since DURATION   Only consider failures within window (default 30d)
 *   --host HOST        Limit to one host
 *   --op OP            Limit to one op
 *   --err CLASS        Limit to one err_class
 *   --commit           Actually write notes (default dry-run)
 *   --draft DIR        Write drafts to DIR/ instead of committing
 *   --json             Output proposals as JSON
 */

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const _require = createRequire(import.meta.url);
const memory = _require("../_lib/memory.js");

// ── arg parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.flags.help = true;
    else if (a === "--threshold") out.flags.threshold = parseInt(argv[++i], 10);
    else if (a === "--since") out.flags.since = argv[++i];
    else if (a === "--host") out.flags.host = argv[++i];
    else if (a === "--op") out.flags.op = argv[++i];
    else if (a === "--err") out.flags.err = argv[++i];
    else if (a === "--commit") out.flags.commit = true;
    else if (a === "--draft") out.flags.draft = argv[++i];
    else if (a === "--json") out.flags.json = true;
  }
  return out;
}

function parseDuration(s) {
  if (!s) return 30 * 86400000; // default 30d
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([smhdw])?$/i);
  if (!m) return 30 * 86400000;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "h").toLowerCase();
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit];
  return n * mult;
}

function help() {
  console.log(`Usage: web-consolidate [options]

Propose memory notes from recurring failures. Default mode is dry-run —
prints proposed notes to stdout for review. Use --commit to actually write.

Options:
  --threshold N        Minimum recurrence (default 2)
  --since DURATION     Time window (default 30d)
  --host HOST          Filter to one host
  --op OP              Filter to one op
  --err CLASS          Filter to one err_class
  --commit             Write notes to ${memory.NOTES} and reindex
  --draft DIR          Save drafts to DIR/ for human review
  --json               Output as JSON

Examples:
  web-consolidate                              # dry-run all recurring patterns
  web-consolidate --host github.com --op fetch # focus on one tuple
  web-consolidate --commit                     # auto-write all proposals
  web-consolidate --draft ./drafts             # save .md files for review
`);
}

// ── load + bucket failures ─────────────────────────────────────────────────

function loadFailures() {
  if (!fs.existsSync(memory.FAILURES)) return [];
  return fs.readFileSync(memory.FAILURES, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function bucket(failures, opts) {
  const sinceMs = parseDuration(opts.since);
  const cutoff = Date.now() - sinceMs;
  const buckets = new Map();
  for (const r of failures) {
    if (new Date(r.ts).getTime() < cutoff) continue;
    if (opts.host && r.host !== opts.host) continue;
    if (opts.op && r.op !== opts.op) continue;
    if (opts.err && r.err_class !== opts.err) continue;
    const key = `${r.host || "-"}\t${r.op || "-"}\t${r.err_class || "unknown"}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  return buckets;
}

// ── proposal generator ─────────────────────────────────────────────────────

function proposeNote(host, op, errClass, samples) {
  const tags = [
    "kind-fix",
    `op-${op || "any"}`,
    `err-${errClass}`,
  ];
  if (host) tags.push(`domain-${host.replace(/\./g, "-")}`);

  const title = `${host || "any"} · ${op || "any"} · ${errClass}`;
  const dates = samples.map(s => s.ts).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const sampleErrs = [...new Set(samples.map(s => s.err).filter(Boolean))].slice(0, 3);
  const sampleCmds = [...new Set(samples.map(s => s.cmd).filter(Boolean))].slice(0, 3);

  const body = [
    `# ${title}`,
    "",
    `**Pattern:** \`${errClass}\` from \`${host || "any"}\` during \`${op || "any"}\`.`,
    `**Seen:** ${samples.length}× between ${first.slice(0, 10)} and ${last.slice(0, 10)}.`,
    "",
    "## Symptoms",
    sampleErrs.map(e => `- \`${String(e).slice(0, 200)}\``).join("\n") || "- (no err message captured)",
    "",
    "## Reproducers",
    sampleCmds.map(c => `- \`${c}\``).join("\n") || "- (no cmd captured)",
    "",
    "## Probable cause",
    causeHint(errClass, host),
    "",
    "## Workaround",
    workaroundHint(errClass, op),
    "",
    "## Verified fix",
    "_TODO: agent or human fills this in once a fix is confirmed._",
    "",
    "## Notes",
    "_TODO: anything else worth remembering._",
    "",
  ].join("\n");

  return { title, tags, body, samples_count: samples.length };
}

function causeHint(errClass, host) {
  const hints = {
    http_403:       `Server is rejecting requests. Likely missing/bad auth, blocked UA, or geo/IP filter.`,
    http_401:       `Auth required. Provide a token via the appropriate env var.`,
    http_404:       `Resource doesn't exist at that URL/path. Verify spelling.`,
    http_429:       `Rate-limited. Either too many requests/min or daily quota hit.`,
    http_5xx:       `Upstream server error. Usually transient — retry with backoff.`,
    timeout:        `Request didn't complete in time. Slow upstream, large payload, or SPA needing JS.`,
    dns:            `Hostname doesn't resolve. Could be typo, dead domain, or DNS issue locally.`,
    conn_refused:   `Nothing listening on that port. Service down or wrong endpoint.`,
    conn_reset:     `Server cut the connection. Often anti-bot, firewall, or protocol mismatch.`,
    tls:            `TLS/SSL handshake failed. Cert issue, version mismatch, or self-signed.`,
    captcha:        `Site is gating with a captcha. Static fetch can't solve it.`,
    consent_banner: `Cookie/consent banner blocking content extraction.`,
    selector_stale: `DOM changed since selector was captured. Site redesigned or A/B variant.`,
    no_browser:     `Browser not running. Start it with browser-start.`,
    oom:            `Process ran out of memory. Common with large whisper models on small GPUs.`,
    no_transcript:  `YouTube has no captions for this video (or yt-dlp couldn't fetch them).`,
    age_gate:       `YouTube age-restriction blocks anonymous fetch.`,
    rate_limit:     `API quota hit. Either back off or upgrade tier.`,
    bad_json:       `Endpoint returned HTML/empty/garbage instead of expected JSON.`,
    not_found:      `Resource not found at the API. Check ID/title format.`,
  };
  return hints[errClass] || `Unknown failure class. Inspect raw failure log: \`web-status --json-failures\`.`;
}

function workaroundHint(errClass, op) {
  const hints = {
    http_403:       `- Set a User-Agent header (most APIs require it).\n- For browser content, use \`browser-start\` + \`browser-content\`.\n- Check if the host needs auth (env var token).`,
    http_429:       `- Add a delay between requests.\n- Cache results to disk.\n- For GitHub, set GITHUB_TOKEN (5000 req/h instead of 60).`,
    http_5xx:       `- Retry with exponential backoff (1s, 2s, 4s, 8s).\n- Check the host's status page.`,
    timeout:        `- Increase --timeout flag.\n- For SPA pages: \`fetch --render\` or use \`browser\`.\n- Filter response with selector to reduce payload.`,
    dns:            `- Verify hostname spelling.\n- Check if the domain still exists.\n- Try a different DNS resolver.`,
    captcha:        `- Use \`browser-start\` with persistent profile (cookies persist).\n- Solve once manually, then automate against the warm session.`,
    consent_banner: `- \`browser-pick\` the dismiss button, save selector.\n- Or: load the page in browser, accept once, reuse cookies.`,
    selector_stale: `- Re-pick selectors with \`browser-pick\`.\n- Update any saved selectors in scripts.`,
    oom:            `- Use a smaller whisper model: \`--model tiny\` or \`base\` instead of \`medium\`/\`large\`.\n- Process audio in chunks.`,
    no_transcript:  `- Try \`youtube --lang LANG\` for non-English captions.\n- Fall back to \`transcribe\` (whisper on the audio).`,
    age_gate:       `- Use \`browser-start\` with a logged-in YouTube profile.\n- Or: pass cookies via yt-dlp.`,
    bad_json:       `- Inspect with \`fetch --raw URL\`.\n- The endpoint may have changed format or returned an error page.`,
  };
  return hints[errClass] || `- (none recorded yet — agent should fill in once fix is found.)`;
}

// ── output / commit ────────────────────────────────────────────────────────

function renderMarkdownProposal(p) {
  const fmLines = ["---"];
  fmLines.push(`tags: [${p.tags.map(t => JSON.stringify(t)).join(", ")}]`);
  fmLines.push(`status: proposed`);
  fmLines.push(`title: ${JSON.stringify(p.title)}`);
  fmLines.push(`samples_count: ${p.samples_count}`);
  fmLines.push(`created: ${new Date().toISOString().slice(0, 10)}`);
  fmLines.push("---", "");
  return fmLines.join("\n") + p.body;
}

function commitProposal(p) {
  // Use memory.commit so reindex is handled
  const r = memory.commit(p.body, {
    tags: p.tags,
    title: p.title,
    status: "active",
    kind: "fix",
    reindex: false, // we'll reindex once at the end
  });
  return r;
}

function writeDraft(p, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const file = path.join(dir, `${slug}.md`);
  fs.writeFileSync(file, renderMarkdownProposal(p));
  return file;
}

// ── main ───────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
if (args.flags.help) { help(); process.exit(0); }

const threshold = args.flags.threshold || 2;
const failures = loadFailures();
const buckets = bucket(failures, {
  since: args.flags.since,
  host: args.flags.host,
  op: args.flags.op,
  err: args.flags.err,
});

const proposals = [];
for (const [key, samples] of buckets.entries()) {
  if (samples.length < threshold) continue;
  const [host, op, errClass] = key.split("\t").map(s => s === "-" ? null : s);
  proposals.push(proposeNote(host, op, errClass, samples));
}

proposals.sort((a, b) => b.samples_count - a.samples_count);

if (args.flags.json) {
  process.stdout.write(JSON.stringify(proposals.map(p => ({
    ...p,
    rendered: renderMarkdownProposal(p),
  })), null, 2) + "\n");
  process.exit(0);
}

if (!proposals.length) {
  console.log(`No recurring failures meet threshold (≥${threshold}) in window.`);
  process.exit(0);
}

if (args.flags.commit) {
  let written = 0;
  for (const p of proposals) {
    const r = commitProposal(p);
    if (r.path) {
      written++;
      console.log(`✓ committed ${path.basename(r.path)}  (${p.samples_count}× pattern)`);
    } else {
      console.log(`✗ failed to commit "${p.title}"`);
    }
  }
  // single reindex at the end
  if (written) {
    const ok = memory.reindex();
    console.log(`reindex: ${ok ? "ok" : "failed"}`);
  }
  console.log(`\nDone. Wrote ${written}/${proposals.length} proposals to ${memory.NOTES}`);
  process.exit(0);
}

if (args.flags.draft) {
  for (const p of proposals) {
    const file = writeDraft(p, args.flags.draft);
    console.log(`drafted ${file}  (${p.samples_count}× pattern)`);
  }
  console.log(`\nDone. Wrote ${proposals.length} drafts to ${args.flags.draft}/`);
  console.log(`Review, edit, then either:`);
  console.log(`  - copy approved files to ${memory.NOTES} + run: velocirag index ${memory.NOTES} --db ${memory.INDEX} -s web`);
  console.log(`  - or re-run \`web-consolidate --commit\` to skip the review.`);
  process.exit(0);
}

// default: dry-run, print to stdout
console.error(`# ${proposals.length} proposal${proposals.length === 1 ? "" : "s"} (dry-run; threshold=${threshold})`);
console.error(`# Use --commit to write, --draft DIR to save drafts, --json for machine output.`);
console.error("");
for (const p of proposals) {
  console.log(`# ─── ${p.title} (${p.samples_count}× pattern) ───`);
  console.log(renderMarkdownProposal(p));
  console.log("");
}
