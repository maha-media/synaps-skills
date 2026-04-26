#!/usr/bin/env node

import { connect, extractHost, recallAndEmit, failAndExit } from "./lib.js";

const args = process.argv.slice(2);
const newTab = args.includes("--new");
const url = args.find((a) => !a.startsWith("--"));

if (!url) {
  console.log("Usage: browser-nav.js <url> [--new]");
  console.log("");
  console.log("  browser-nav.js https://example.com        Navigate current tab");
  console.log("  browser-nav.js https://example.com --new  Open in new tab");
  process.exit(1);
}

const HOST = extractHost(url);
const OP = "browser-nav";

recallAndEmit(`${HOST || url} navigate`, { host: HOST, op: OP });

let browserHandle;
try {
  const { browser, context, page } = await connect();
  browserHandle = browser;

  if (newTab) {
    const p = await context.newPage();
    await p.goto(url, { waitUntil: "domcontentloaded" });
    console.log("✓ Opened:", url);
  } else {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    console.log("✓ Navigated to:", url);
  }

  await browser.close();
} catch (e) {
  try { await browserHandle?.close(); } catch {}
  failAndExit({
    host: HOST, op: OP,
    err: e,
    cmd: `browser-nav.js ${url}${newTab ? " --new" : ""}`,
    args: { url, newTab },
  });
}
