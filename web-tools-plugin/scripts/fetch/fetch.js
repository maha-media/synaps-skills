#!/usr/bin/env node
/**
 * fetch — lightweight HTTP→markdown.
 *
 * Pure Node (native fetch + Readability + Turndown). No browser launch.
 * Use this for static HTML, JSON APIs, and plain-text URLs.
 * For JS-rendered pages, use --render to escalate to browser-content.js,
 * or call browser-content.js directly.
 *
 * Usage:
 *   fetch.js <url> [options]
 *
 * Options:
 *   --render           Delegate to browser-content.js (Playwright)
 *   --raw              Print raw response body, no transformations
 *   --json             Pretty-print JSON (default for application/json)
 *   --headers          Include response headers in output
 *   --max-bytes N      Limit response size in bytes (default: 5MB)
 *   --timeout SEC      Request timeout (default: 30)
 *   --user-agent UA    Override User-Agent header
 *   --no-redirect      Disable redirect following
 *   --header "K: V"    Additional request header (repeatable)
 *
 * Exit codes:
 *   0   success
 *   1   network / parse failure (auto-logged)
 *   2   HTTP non-2xx (auto-logged)
 *   3   needs-render (auto-logged so memory can suggest --render next time)
 */
import {
  extractHost, recallAndEmit, failAndExit,
} from "../_lib/hooks.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);

function popFlag(name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function popValue(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function popValues(name) {
  const out = [];
  while (true) {
    const i = args.indexOf(name);
    if (i === -1) break;
    if (i + 1 < args.length) {
      out.push(args[i + 1]);
      args.splice(i, 2);
    } else {
      args.splice(i, 1);
    }
  }
  return out;
}

const useRender   = popFlag("--render");
const raw         = popFlag("--raw");
const forceJson   = popFlag("--json");
const showHeaders = popFlag("--headers");
const noRedirect  = popFlag("--no-redirect");
const maxBytes    = parseInt(popValue("--max-bytes") || "5242880", 10); // 5 MB
const timeoutSec  = parseFloat(popValue("--timeout") || "30");
const userAgent   = popValue("--user-agent")
  || "Mozilla/5.0 (compatible; web-tools/0.2; +https://github.com/maha-media/synaps-skills)";
const extraHeaders = popValues("--header");

const url = args[0];

if (!url || url === "--help" || url === "-h") {
  console.log("Usage: fetch.js <url> [options]");
  console.log("");
  console.log("Options:");
  console.log("  --render           Delegate to browser-content.js (Playwright)");
  console.log("  --raw              Print raw response body, no transformations");
  console.log("  --json             Pretty-print JSON");
  console.log("  --headers          Include response headers in output");
  console.log("  --max-bytes N      Response size limit (default: 5242880)");
  console.log("  --timeout SEC      Request timeout (default: 30)");
  console.log("  --user-agent UA    Override User-Agent");
  console.log("  --no-redirect      Disable redirect following");
  console.log("  --header 'K: V'    Additional request header (repeatable)");
  console.log("");
  console.log("Examples:");
  console.log("  fetch.js https://example.com");
  console.log("  fetch.js https://api.github.com/repos/anthropics/anthropic-sdk-python --json");
  console.log("  fetch.js https://news.ycombinator.com --render");
  console.log("  fetch.js https://api.x.com/2/tweets --header 'Authorization: Bearer $TOKEN'");
  process.exit(url ? 0 : 1);
}

const HOST = extractHost(url);
const OP = "fetch";

// PRE — recall any prior fixes for this host
recallAndEmit(`${HOST || url} fetch`, { host: HOST, op: OP });

// ── --render escalation: shell out to browser-content.js ───────────────────

if (useRender) {
  const here = dirname(fileURLToPath(import.meta.url));
  const browserContent = join(here, "..", "browser", "browser-content.js");
  const r = spawnSync("node", [browserContent, url], {
    stdio: "inherit",
    timeout: (timeoutSec + 5) * 1000,
  });
  process.exit(r.status ?? 1);
}

// ── parse extra headers ────────────────────────────────────────────────────

const headers = { "User-Agent": userAgent };
for (const h of extraHeaders) {
  const idx = h.indexOf(":");
  if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
}

// ── fetch with timeout ─────────────────────────────────────────────────────

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

let response;
try {
  response = await fetch(url, {
    headers,
    redirect: noRedirect ? "manual" : "follow",
    signal: controller.signal,
  });
} catch (e) {
  clearTimeout(timer);
  failAndExit({
    host: HOST, op: OP,
    err: e,
    err_class: e.name === "AbortError" ? "timeout" : undefined,
    cmd: `fetch.js ${url}`,
    args: { url, timeoutSec },
  });
} finally {
  clearTimeout(timer);
}

// ── HTTP error branch ──────────────────────────────────────────────────────

if (!response.ok && !noRedirect) {
  failAndExit({
    host: HOST, op: OP,
    err: new Error(`HTTP ${response.status} ${response.statusText} (${url})`),
    exit: 2,
    cmd: `fetch.js ${url}`,
    args: { url, status: response.status, finalUrl: response.url },
  });
}

// ── read body (capped) ─────────────────────────────────────────────────────

const buf = Buffer.from(await response.arrayBuffer());
const truncated = buf.length >= maxBytes;
const body = buf.length > maxBytes ? buf.slice(0, maxBytes) : buf;

// ── headers section ────────────────────────────────────────────────────────

if (showHeaders) {
  console.log(`HTTP ${response.status} ${response.statusText}`);
  console.log(`URL: ${response.url}`);
  for (const [k, v] of response.headers) console.log(`${k}: ${v}`);
  console.log("");
}

// ── output by content-type ─────────────────────────────────────────────────

const ct = (response.headers.get("content-type") || "").toLowerCase();
const isJson = forceJson || /(application|text)\/(json|.*\+json)/.test(ct);
const isHtml = !forceJson && /(text\/html|application\/xhtml)/.test(ct);
const isText = /^text\//.test(ct);

if (raw) {
  process.stdout.write(body);
  if (truncated) console.error(`\n[truncated at ${maxBytes} bytes]`);
  process.exit(0);
}

const text = body.toString("utf8");

if (isJson) {
  try {
    const obj = JSON.parse(text);
    console.log(JSON.stringify(obj, null, 2));
  } catch {
    console.log(text);
  }
  if (truncated) console.error(`[truncated at ${maxBytes} bytes]`);
  process.exit(0);
}

if (isHtml) {
  // Lazy-load the heavy deps only on the HTML path
  let Readability, JSDOM, TurndownService, gfm;
  try {
    ({ Readability } = await import("@mozilla/readability"));
    ({ JSDOM } = await import("jsdom"));
    ({ default: TurndownService } = await import("turndown"));
    ({ gfm } = await import("turndown-plugin-gfm"));
  } catch (e) {
    console.error("⚠ HTML→markdown deps not installed in scripts/fetch/");
    console.error("  cd " + dirname(fileURLToPath(import.meta.url)) + " && npm install");
    console.error("  Falling back to raw HTML below.");
    console.log(text);
    process.exit(0);
  }

  const doc = new JSDOM(text, { url: response.url });
  const reader = new Readability(doc.window.document);
  const article = reader.parse();

  function htmlToMarkdown(html) {
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    td.use(gfm);
    td.addRule("removeEmptyLinks", {
      filter: (n) => n.nodeName === "A" && !n.textContent?.trim(),
      replacement: () => "",
    });
    return td.turndown(html)
      .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
      .replace(/ +/g, " ")
      .replace(/\s+,/g, ",")
      .replace(/\s+\./g, ".")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  let md;
  if (article?.content) {
    md = htmlToMarkdown(article.content);
  } else {
    const fbDoc = new JSDOM(text, { url: response.url });
    const b = fbDoc.window.document;
    b.querySelectorAll("script, style, noscript, nav, header, footer, aside")
      .forEach((el) => el.remove());
    const main = b.querySelector("main, article, [role='main'], .content, #content") || b.body;
    md = htmlToMarkdown(main?.innerHTML || "");
  }

  // Heuristic: did we actually get any content? If not, suggest --render
  const trimmed = md.replace(/\s+/g, " ").trim();
  const looksEmpty = trimmed.length < 100;
  const looksLikeJSPage = /(enable javascript|please enable js|noscript)/i.test(text)
    || /<body[^>]*>\s*(<script|<\/body>)/i.test(text);

  console.log(`URL: ${response.url}`);
  if (article?.title) console.log(`Title: ${article.title}`);
  console.log("");
  console.log(md || "(no extractable content)");

  if (truncated) console.error(`[truncated at ${maxBytes} bytes]`);

  if (looksEmpty || looksLikeJSPage) {
    // POST: log a needs-render failure so memory can warn next time
    failAndExit({
      host: HOST, op: OP,
      err: new Error(
        `Page appears to require JS rendering — extracted ${trimmed.length} chars. Retry with --render.`
      ),
      exit: 3,
      err_class: "needs_render",
      cmd: `fetch.js ${url}`,
      args: { url, extracted_chars: trimmed.length },
    });
  }
  process.exit(0);
}

// Plain text or unknown → echo
if (isText || !ct) {
  console.log(text);
  if (truncated) console.error(`[truncated at ${maxBytes} bytes]`);
  process.exit(0);
}

// Binary → save and report
import("node:fs").then(async (fs) => {
  const tmp = await import("node:os").then(o => o.tmpdir());
  const path = await import("node:path");
  const ext = (ct.split(";")[0].trim().split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "");
  const fname = path.default.join(tmp, `fetch-${Date.now()}.${ext}`);
  fs.default.writeFileSync(fname, body);
  console.log(`Binary content (${ct}, ${body.length} bytes) saved to: ${fname}`);
  if (truncated) console.error(`[truncated at ${maxBytes} bytes]`);
  process.exit(0);
});
