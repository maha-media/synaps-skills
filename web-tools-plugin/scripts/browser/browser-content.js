#!/usr/bin/env node
/**
 * Navigate to a URL and extract readable content as markdown.
 * Uses Readability for article extraction and Turndown for HTML→Markdown.
 */
import {
  connect, extractHost, recallAndEmit, failAndExit,
} from "./lib.js";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const TIMEOUT = 30000;
const url = process.argv[2];
if (!url) {
  console.log("Usage: browser-content.js <url>");
  console.log("");
  console.log("  browser-content.js https://example.com");
  process.exit(1);
}

const HOST = extractHost(url);
const OP = "browser-content";

// PRE — recall any prior fixes for this host
recallAndEmit(`${HOST || url} content extraction`, { host: HOST, op: OP });

// Hard timeout — log as failure if we hit it
const timeoutId = setTimeout(() => {
  failAndExit({
    host: HOST, op: OP,
    err: new Error("Timeout after 30s"),
    err_class: "timeout",
    cmd: `browser-content.js ${url}`,
    args: { url },
  });
}, TIMEOUT);
timeoutId.unref();

let browserHandle;
try {
  const { browser, page } = await connect();
  browserHandle = browser;

  await Promise.race([
    page.goto(url, { waitUntil: "networkidle" }),
    new Promise((r) => setTimeout(r, 10000)),
  ]).catch(() => {});

  const outerHTML = await page.content();
  const finalUrl = page.url();

  const doc = new JSDOM(outerHTML, { url: finalUrl });
  const reader = new Readability(doc.window.document);
  const article = reader.parse();

  function htmlToMarkdown(html) {
    const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    turndown.use(gfm);
    turndown.addRule("removeEmptyLinks", {
      filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
      replacement: () => "",
    });
    return turndown
      .turndown(html)
      .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
      .replace(/ +/g, " ")
      .replace(/\s+,/g, ",")
      .replace(/\s+\./g, ".")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  let content;
  if (article?.content) {
    content = htmlToMarkdown(article.content);
  } else {
    const fallbackDoc = new JSDOM(outerHTML, { url: finalUrl });
    const body = fallbackDoc.window.document;
    body.querySelectorAll("script, style, noscript, nav, header, footer, aside")
      .forEach((el) => el.remove());
    const main =
      body.querySelector("main, article, [role='main'], .content, #content") ||
      body.body;
    const fallbackHtml = main?.innerHTML || "";
    content = fallbackHtml.trim().length > 100
      ? htmlToMarkdown(fallbackHtml)
      : "(Could not extract content)";
  }

  console.log(`URL: ${finalUrl}`);
  if (article?.title) console.log(`Title: ${article.title}`);
  console.log("");
  console.log(content);

  await browser.close();
  process.exit(0);
} catch (e) {
  try { await browserHandle?.close(); } catch {}
  failAndExit({
    host: HOST, op: OP,
    err: e,
    cmd: `browser-content.js ${url}`,
    args: { url },
  });
}
