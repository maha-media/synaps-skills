#!/usr/bin/env node

import { connect, recallAndEmit, failAndExit } from "./lib.js";

const OP = "browser-cookies";

recallAndEmit("cookies dump", { op: OP });

let browserHandle;
try {
  const { browser, context } = await connect();
  browserHandle = browser;

  const cookies = await context.cookies();

  for (const cookie of cookies) {
    console.log(`${cookie.name}: ${cookie.value}`);
    console.log(`  domain: ${cookie.domain}`);
    console.log(`  path: ${cookie.path}`);
    console.log(`  httpOnly: ${cookie.httpOnly}`);
    console.log(`  secure: ${cookie.secure}`);
    console.log("");
  }

  await browser.close();
} catch (e) {
  try { await browserHandle?.close(); } catch {}
  failAndExit({
    host: null, op: OP,
    err: e,
    cmd: "browser-cookies.js",
  });
}
