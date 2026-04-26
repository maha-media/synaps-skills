#!/usr/bin/env node
/**
 * wiki — Wikipedia REST API wrapper.
 *
 * Subcommands:
 *   summary <title>           One-paragraph summary + key facts
 *   article <title>           Full article extract (markdown-ish plain text)
 *   search  <query> [-n N]    Search by query (default 5 results)
 *   random                    Random article summary
 *
 * Options:
 *   --lang CODE       Wiki language (default: en)
 *
 * No auth required. The Wikimedia REST API has no published rate limit
 * for normal use but ~200 req/s is a sensible ceiling.
 *
 * Exit codes:
 *   0  success
 *   1  network / parse failure
 *   2  HTTP non-2xx
 *   3  bad args / not found
 */
import { recallAndEmit, failAndExit } from "../_lib/hooks.mjs";

const HOST_TPL = (lang) => `${lang}.wikipedia.org`;
const OP = "wiki";
const USER_AGENT = "Mozilla/5.0 (compatible; web-tools/0.3 wiki; +https://github.com/maha-media/synaps-skills) operator-contact: jr@maha.media";
const TIMEOUT_MS = 20_000;

function popValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

const args = process.argv.slice(2);
const command = args.shift();
const lang = popValue(args, "--lang") || "en";
const HOST = HOST_TPL(lang);

if (!command || command === "--help" || command === "-h") {
  printHelp();
  process.exit(command ? 0 : 1);
}

recallAndEmit(`wiki ${command}: ${args.join(" ").slice(0, 60)}`, { host: HOST, op: OP });

try {
  switch (command) {
    case "summary": await cmdSummary(args); break;
    case "article": await cmdArticle(args); break;
    case "search":  await cmdSearch(args); break;
    case "random":  await cmdRandom(); break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(3);
  }
} catch (e) {
  failAndExit({
    host: HOST, op: OP, err: e,
    cmd: `wiki ${command} ${args.join(" ")}`.slice(0, 200),
    args: { command, args: args.slice(0, 5), lang },
  });
}

// ── core ───────────────────────────────────────────────────────────────────

async function wp(path, opts = {}) {
  const url = `https://${HOST}${path}`;
  const headers = {
    "Accept": opts.accept || "application/json",
    "User-Agent": USER_AGENT,
  };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let extra = "";
    try { extra = JSON.parse(text).detail || JSON.parse(text).title || ""; } catch {}
    const e = new Error(`HTTP ${resp.status} ${resp.statusText} — ${extra || text.slice(0, 200)}`);
    e.statusCode = resp.status;
    throw e;
  }
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  if (opts.raw) return await resp.text();
  if (ct.includes("json")) return await resp.json();
  return await resp.text();
}

function encodeTitle(t) {
  // Wikipedia uses underscores in URLs and percent-encodes other chars
  return encodeURIComponent(t.replace(/\s+/g, "_"));
}

// ── commands ───────────────────────────────────────────────────────────────

async function cmdSummary(a) {
  const title = a.join(" ");
  if (!title) {
    failAndExit({ host: HOST, op: OP,
      err: new Error("Missing TITLE"), err_class: "bad_args", exit: 3 });
  }
  const r = await wp(`/api/rest_v1/page/summary/${encodeTitle(title)}`);
  if (r.type === "disambiguation") {
    console.error(`[wiki] '${r.title}' is a disambiguation page — pick a more specific title.`);
  }
  console.log(`Title: ${r.title}`);
  if (r.description) console.log(`Description: ${r.description}`);
  if (r.extract) {
    console.log("");
    console.log(r.extract);
  }
  if (r.content_urls?.desktop?.page) console.log(`\nURL: ${r.content_urls.desktop.page}`);
  if (r.thumbnail?.source) console.log(`Thumbnail: ${r.thumbnail.source}`);
}

async function cmdArticle(a) {
  const title = a.join(" ");
  if (!title) {
    failAndExit({ host: HOST, op: OP,
      err: new Error("Missing TITLE"), err_class: "bad_args", exit: 3 });
  }
  // The text-extract action API gives us plain-text article body
  const params = new URLSearchParams({
    action: "query",
    prop: "extracts|info",
    inprop: "url",
    explaintext: "1",
    redirects: "1",
    titles: title,
    format: "json",
    formatversion: "2",
  });
  const r = await wp(`/w/api.php?${params}`);
  const pages = r?.query?.pages || [];
  if (!pages.length || pages[0].missing) {
    failAndExit({ host: HOST, op: OP,
      err: new Error(`Article not found: '${title}'`),
      err_class: "not_found", exit: 3,
      cmd: `wiki article ${title}` });
  }
  const p = pages[0];
  console.log(`Title: ${p.title}`);
  if (p.fullurl) console.log(`URL: ${p.fullurl}`);
  console.log("");
  console.log(p.extract || "(no extract)");
}

async function cmdSearch(a) {
  const limit = parseInt(popValue(a, "-n") || popValue(a, "--limit") || "5", 10);
  const q = a.join(" ");
  if (!q) {
    failAndExit({ host: HOST, op: OP,
      err: new Error("Missing search query"), err_class: "bad_args", exit: 3 });
  }
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: q,
    srlimit: String(Math.min(limit, 50)),
    format: "json",
    formatversion: "2",
  });
  const r = await wp(`/w/api.php?${params}`);
  const hits = r?.query?.search || [];
  if (!hits.length) {
    console.error(`No results for: ${q}`);
    return;
  }
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    console.log(`[${i + 1}] ${h.title}`);
    if (h.snippet) {
      const snippet = h.snippet.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      console.log(`    ${snippet}`);
    }
    console.log(`    https://${HOST}/wiki/${encodeTitle(h.title)}`);
    if (i < hits.length - 1) console.log("");
  }
}

async function cmdRandom() {
  const r = await wp(`/api/rest_v1/page/random/summary`);
  console.log(`Title: ${r.title}`);
  if (r.description) console.log(`Description: ${r.description}`);
  if (r.extract) {
    console.log("");
    console.log(r.extract);
  }
  if (r.content_urls?.desktop?.page) console.log(`\nURL: ${r.content_urls.desktop.page}`);
}

function printHelp() {
  console.log("Usage: wiki.js <command> [args] [--lang CODE]");
  console.log("");
  console.log("Commands:");
  console.log("  summary <title>           One-paragraph summary + facts");
  console.log("  article <title>           Full article extract (plain text)");
  console.log("  search  <query> [-n N]    Search (default 5 results)");
  console.log("  random                    Random article summary");
  console.log("");
  console.log("Options:");
  console.log("  --lang CODE               Wiki language (default: en)");
  console.log("");
  console.log("Examples:");
  console.log("  wiki.js summary 'Erlang (programming language)'");
  console.log("  wiki.js article 'Kubernetes'");
  console.log("  wiki.js search 'distributed consensus' -n 10");
  console.log("  wiki.js summary --lang fr 'Marie Curie'");
}
