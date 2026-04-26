#!/usr/bin/env node

import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, recallAndEmit, failAndExit } from "./lib.js";

const args = process.argv.slice(2);
const fullPage = args.includes("--full");
const outPath = args.find((a) => !a.startsWith("--"));

const OP = "browser-screenshot";

recallAndEmit("screenshot", { op: OP });

let browserHandle;
try {
  const { browser, page } = await connect();
  browserHandle = browser;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `screenshot-${timestamp}.png`;
  const filepath = outPath || join(tmpdir(), filename);

  await page.screenshot({ path: filepath, fullPage });

  console.log(filepath);

  await browser.close();
} catch (e) {
  try { await browserHandle?.close(); } catch {}
  failAndExit({
    host: null, op: OP,
    err: e,
    cmd: `browser-screenshot.js${fullPage ? " --full" : ""}${outPath ? " " + outPath : ""}`,
    args: { fullPage, outPath },
  });
}
