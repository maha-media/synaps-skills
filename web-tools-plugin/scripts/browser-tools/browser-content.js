#!/usr/bin/env node
/**
 * Navigate to a URL and extract readable content as markdown.
 * Uses Readability for article extraction and Turndown for HTML→Markdown.
 */
import { connect } from "./lib.js";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const TIMEOUT = 30000;
const timeoutId = setTimeout(() => {
  console.error("✗ Timeout after 30s");
  process.exit(1);
}, TIMEOUT);
timeoutId.unref();

const url = process.argv[2];
if (!url) {
  console.log("Usage: browser-content.js <url>");
  console.log("");
  console.log("  browser-content.js https://example.com");
  process.exit(1);
}

const { browser, page } = await connect();

await Promise.race([
  page.goto(url, { waitUntil: "networkidle" }),
  new Promise((r) => setTimeout(r, 10000)),
]).catch(() => {});

// Get full HTML
const outerHTML = await page.content();
const finalUrl = page.url();

// Extract with Readability
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
  body.querySelectorAll("script, style, noscript, nav, header, footer, aside").forEach((el) => el.remove());
  const main = body.querySelector("main, article, [role='main'], .content, #content") || body.body;
  const fallbackHtml = main?.innerHTML || "";
  content = fallbackHtml.trim().length > 100 ? htmlToMarkdown(fallbackHtml) : "(Could not extract content)";
}

console.log(`URL: ${finalUrl}`);
if (article?.title) console.log(`Title: ${article.title}`);
console.log("");
console.log(content);

await browser.close();
process.exit(0);
