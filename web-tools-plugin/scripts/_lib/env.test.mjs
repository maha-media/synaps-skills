#!/usr/bin/env node
/**
 * Tests for _lib/env.mjs — env-file loader.
 *
 * Run:  node web-tools-plugin/scripts/_lib/env.test.mjs
 *
 * Exits 0 on all-pass, 1 on any failure.
 */

import { mkdtempSync, writeFileSync, rmSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, parseEnvFile } from "./env.mjs";

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

// ── parseEnvFile ───────────────────────────────────────────────────────────

test("parseEnvFile: empty string → {}", () => {
  eq(parseEnvFile(""), {});
});

test("parseEnvFile: single KEY=VALUE", () => {
  eq(parseEnvFile("FOO=bar"), { FOO: "bar" });
});

test("parseEnvFile: multiple lines", () => {
  eq(parseEnvFile("FOO=bar\nBAZ=qux"), { FOO: "bar", BAZ: "qux" });
});

test("parseEnvFile: ignores comments and blank lines", () => {
  eq(parseEnvFile("# comment\n\nFOO=bar\n# another\nBAZ=qux\n"), { FOO: "bar", BAZ: "qux" });
});

test("parseEnvFile: tolerates 'export FOO=bar' shell syntax", () => {
  eq(parseEnvFile("export FOO=bar"), { FOO: "bar" });
});

test("parseEnvFile: strips matching surrounding quotes (double)", () => {
  eq(parseEnvFile('FOO="hello world"'), { FOO: "hello world" });
});

test("parseEnvFile: strips matching surrounding quotes (single)", () => {
  eq(parseEnvFile("FOO='hello world'"), { FOO: "hello world" });
});

test("parseEnvFile: keeps quotes when mismatched", () => {
  eq(parseEnvFile(`FOO="unclosed`), { FOO: '"unclosed' });
});

test("parseEnvFile: tolerates whitespace around = (key trimmed)", () => {
  eq(parseEnvFile("  FOO  =bar"), { FOO: "bar" });
});

test("parseEnvFile: value with embedded =", () => {
  eq(parseEnvFile("URL=https://x.com?a=b&c=d"), { URL: "https://x.com?a=b&c=d" });
});

test("parseEnvFile: skips lines without = ", () => {
  eq(parseEnvFile("FOO=bar\nINVALID_LINE\nBAZ=qux"), { FOO: "bar", BAZ: "qux" });
});

test("parseEnvFile: skips lines with empty key", () => {
  eq(parseEnvFile("=novalue\nFOO=bar"), { FOO: "bar" });
});

test("parseEnvFile: empty value is allowed (key set to empty string)", () => {
  eq(parseEnvFile("FOO="), { FOO: "" });
});

// ── loadEnvFile ────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "envtest-"));
process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

test("loadEnvFile: missing file returns {} (no throw)", () => {
  const result = loadEnvFile(join(tmp, "nonexistent.env"));
  eq(result, {});
});

test("loadEnvFile: reads and parses a real file", () => {
  const p = join(tmp, "good.env");
  writeFileSync(p, "EXA_API_KEY=abc123\n# comment\nOTHER=foo\n");
  const result = loadEnvFile(p);
  eq(result, { EXA_API_KEY: "abc123", OTHER: "foo" });
});

test("loadEnvFile: injects into process.env when injected=true", () => {
  delete process.env.TEST_ENV_INJECT;
  const p = join(tmp, "inject.env");
  writeFileSync(p, "TEST_ENV_INJECT=hello\n");
  loadEnvFile(p, { injectInto: process.env });
  eq(process.env.TEST_ENV_INJECT, "hello", "should inject into process.env");
  delete process.env.TEST_ENV_INJECT;
});

test("loadEnvFile: does NOT clobber pre-set env vars", () => {
  process.env.TEST_ENV_PRESET = "preset_value";
  const p = join(tmp, "noclobber.env");
  writeFileSync(p, "TEST_ENV_PRESET=file_value\n");
  loadEnvFile(p, { injectInto: process.env });
  eq(process.env.TEST_ENV_PRESET, "preset_value", "existing env wins over file");
  delete process.env.TEST_ENV_PRESET;
});

test("loadEnvFile: corrupt file does not throw", () => {
  const p = join(tmp, "binary.env");
  writeFileSync(p, Buffer.from([0x00, 0xff, 0xfe, 0x00]));
  // Should not throw — best effort
  const result = loadEnvFile(p);
  // Whatever it returns is fine; key requirement is "no throw"
  if (typeof result !== "object") throw new Error("expected object result");
});

test("loadEnvFile: warns about loose perms (mode 644) but still loads", () => {
  if (process.platform === "win32") return; // skip on Windows
  const p = join(tmp, "loose.env");
  writeFileSync(p, "FOO=bar\n");
  chmodSync(p, 0o644);
  // Capture stderr by replacing console.error temporarily
  let warned = false;
  const orig = console.error;
  console.error = (...args) => { if (args.join(" ").match(/permission|mode|0644/i)) warned = true; };
  try {
    const result = loadEnvFile(p, { warnOnLoosePerms: true });
    eq(result, { FOO: "bar" }, "still parses despite loose perms");
    if (!warned) throw new Error("expected stderr warning about loose perms");
  } finally {
    console.error = orig;
  }
});

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log(`\nFailures:`);
  for (const { name, err } of failures) {
    console.log(`  ✗ ${name}: ${err.stack || err.message}`);
  }
  process.exit(1);
}
process.exit(0);
