#!/usr/bin/env node

import { connect } from "./lib.js";

const { browser, context } = await connect();

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
