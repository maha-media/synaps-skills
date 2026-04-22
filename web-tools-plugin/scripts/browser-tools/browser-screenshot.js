#!/usr/bin/env node

import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./lib.js";

const args = process.argv.slice(2);
const fullPage = args.includes("--full");
const outPath = args.find((a) => !a.startsWith("--"));

const { browser, page } = await connect();

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const filename = `screenshot-${timestamp}.png`;
const filepath = outPath || join(tmpdir(), filename);

await page.screenshot({ path: filepath, fullPage });

console.log(filepath);

await browser.close();
