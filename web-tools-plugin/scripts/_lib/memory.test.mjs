#!/usr/bin/env node
/**
 * Tests for _lib/memory.js's root: WEB_MEMORY_ROOT, else $SYNAPS_BASE_DIR/memory/web,
 * else ~/.synaps-cli/memory/web. Loads memory.js in a child node per case (ROOT is
 * fixed at load time). Writes nothing.
 *
 * Run:  node web-tools-plugin/scripts/_lib/memory.test.mjs
 *
 * Exits 0 on all-pass, 1 on any failure.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MEMORY_JS = join(dirname(fileURLToPath(import.meta.url)), "memory.js");

let pass = 0, fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    fail++;
    failures.push({ name, err: e });
    process.stdout.write(`  ✗ ${name}\n    ${e.message}\n`);
  }
}

function eq(a, b, msg = "") {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg}\n    expected: ${B}\n    actual:   ${A}`);
}

function rootWith(extra) {
  const env = { ...process.env };
  delete env.SYNAPS_BASE_DIR;
  delete env.WEB_MEMORY_ROOT;
  Object.assign(env, extra);
  const r = spawnSync(process.execPath,
    ["-e", "process.stdout.write(require(process.argv[1]).ROOT)", MEMORY_JS],
    { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return r.stdout;
}

test("default root is ~/.synaps-cli/memory/web", () => {
  eq(rootWith({}), join(homedir(), ".synaps-cli", "memory", "web"));
});

test("SYNAPS_BASE_DIR moves the root", () => {
  eq(rootWith({ SYNAPS_BASE_DIR: "/srv/synaps" }), join("/srv/synaps", "memory", "web"));
});

test("WEB_MEMORY_ROOT wins over SYNAPS_BASE_DIR", () => {
  eq(rootWith({ SYNAPS_BASE_DIR: "/srv/synaps", WEB_MEMORY_ROOT: "/srv/mem" }), "/srv/mem");
});

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log(`\nFailures:`);
  for (const { name, err } of failures) {
    console.log(`  ✗ ${name}: ${err.stack || err.message}`);
  }
  process.exit(1);
}
process.exit(0);
