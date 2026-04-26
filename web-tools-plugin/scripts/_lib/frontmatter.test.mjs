#!/usr/bin/env node
/**
 * Tests for _lib/frontmatter.mjs — minimal YAML frontmatter parser
 * + `covers:` tuple matcher used by web-consolidate.
 *
 * Run:  node web-tools-plugin/scripts/_lib/frontmatter.test.mjs
 *
 * Exits 0 on all-pass, 1 on any failure.
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFrontmatter,
  loadCoveredTuples,
  bucketKey,
  isCovered,
} from "./frontmatter.mjs";

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

function truthy(v, msg = "") { if (!v) throw new Error(`${msg} (got ${JSON.stringify(v)})`); }

// ── parseFrontmatter: structural ────────────────────────────────────────────

test("parseFrontmatter: empty input → {fm: {}, body: ''}", () => {
  const r = parseFrontmatter("");
  eq(r.fm, {}); eq(r.body, "");
});

test("parseFrontmatter: no frontmatter → fm empty, body unchanged", () => {
  const r = parseFrontmatter("# Just a heading\n\nbody text\n");
  eq(r.fm, {}); eq(r.body, "# Just a heading\n\nbody text\n");
});

test("parseFrontmatter: well-formed frontmatter splits fm/body", () => {
  const raw = "---\ntitle: Hello\n---\n\nBody here\n";
  const r = parseFrontmatter(raw);
  eq(r.fm.title, "Hello");
  eq(r.body, "\nBody here\n");
});

test("parseFrontmatter: missing closing --- → treats whole thing as body", () => {
  const raw = "---\ntitle: oops\nno closer";
  const r = parseFrontmatter(raw);
  eq(r.fm, {});
  eq(r.body, raw);
});

// ── parseFrontmatter: scalar values ─────────────────────────────────────────

test("parseFrontmatter: scalar string", () => {
  const r = parseFrontmatter("---\nstatus: active\n---\nbody");
  eq(r.fm.status, "active");
});

test("parseFrontmatter: strips matching double quotes", () => {
  const r = parseFrontmatter('---\ntitle: "Hello: world"\n---\n');
  eq(r.fm.title, "Hello: world");
});

test("parseFrontmatter: strips matching single quotes", () => {
  const r = parseFrontmatter("---\ntitle: 'with apostrophe'\n---\n");
  eq(r.fm.title, "with apostrophe");
});

test("parseFrontmatter: handles colon inside quoted value", () => {
  const r = parseFrontmatter('---\nsuperseded_by: "see PR #12: cool fix"\n---\n');
  eq(r.fm.superseded_by, "see PR #12: cool fix");
});

test("parseFrontmatter: ignores comments and blanks", () => {
  const r = parseFrontmatter("---\n# leading comment\n\nstatus: active\n---\n");
  eq(r.fm.status, "active");
});

// ── parseFrontmatter: inline arrays ─────────────────────────────────────────

test("parseFrontmatter: inline array of bare strings", () => {
  const r = parseFrontmatter("---\ntags: [a, b, c]\n---\n");
  eq(r.fm.tags, ["a", "b", "c"]);
});

test("parseFrontmatter: inline array of quoted strings", () => {
  const r = parseFrontmatter('---\ntags: ["kind-fix", "domain-youtube-com"]\n---\n');
  eq(r.fm.tags, ["kind-fix", "domain-youtube-com"]);
});

test("parseFrontmatter: empty inline array", () => {
  const r = parseFrontmatter("---\ntags: []\n---\n");
  eq(r.fm.tags, []);
});

// ── parseFrontmatter: block sequence ────────────────────────────────────────

test("parseFrontmatter: block sequence of bare strings", () => {
  const raw = "---\ncovers:\n  - foo\n  - bar\n---\n";
  const r = parseFrontmatter(raw);
  eq(r.fm.covers, ["foo", "bar"]);
});

test("parseFrontmatter: block sequence of quoted strings", () => {
  const raw = '---\ncovers:\n  - "youtube.com|youtube-transcript|no_transcript"\n  - "youtube.com|transcript|no_transcript"\n---\n';
  const r = parseFrontmatter(raw);
  eq(r.fm.covers, [
    "youtube.com|youtube-transcript|no_transcript",
    "youtube.com|transcript|no_transcript",
  ]);
});

test("parseFrontmatter: block sequence terminates on next key", () => {
  const raw = "---\ncovers:\n  - one\n  - two\nstatus: active\n---\n";
  const r = parseFrontmatter(raw);
  eq(r.fm.covers, ["one", "two"]);
  eq(r.fm.status, "active");
});

// ── bucketKey ──────────────────────────────────────────────────────────────

test("bucketKey: full triple", () => {
  eq(bucketKey({ host: "a.com", op: "fetch", err_class: "http_403" }),
     "a.com|fetch|http_403");
});

test("bucketKey: missing fields become *", () => {
  eq(bucketKey({}), "*|*|*");
});

test("bucketKey: null/undefined fields become *", () => {
  eq(bucketKey({ host: "a.com", op: null, err_class: undefined }),
     "a.com|*|*");
});

// ── isCovered ──────────────────────────────────────────────────────────────

test("isCovered: exact match", () => {
  const set = new Set(["a.com|fetch|http_403"]);
  truthy(isCovered({ host: "a.com", op: "fetch", err_class: "http_403" }, set));
});

test("isCovered: not covered when tuple absent", () => {
  const set = new Set(["a.com|fetch|http_403"]);
  truthy(!isCovered({ host: "b.com", op: "fetch", err_class: "http_403" }, set));
});

test("isCovered: wildcard host (*) matches any host", () => {
  const set = new Set(["*|fetch|http_403"]);
  truthy(isCovered({ host: "any.com", op: "fetch", err_class: "http_403" }, set));
});

test("isCovered: wildcard op matches any op", () => {
  const set = new Set(["a.com|*|http_403"]);
  truthy(isCovered({ host: "a.com", op: "fetch", err_class: "http_403" }, set));
  truthy(isCovered({ host: "a.com", op: "render", err_class: "http_403" }, set));
});

test("isCovered: wildcard err_class matches any err_class", () => {
  const set = new Set(["a.com|fetch|*"]);
  truthy(isCovered({ host: "a.com", op: "fetch", err_class: "anything" }, set));
});

test("isCovered: empty set never matches", () => {
  truthy(!isCovered({ host: "a.com", op: "fetch", err_class: "x" }, new Set()));
});

// ── loadCoveredTuples ──────────────────────────────────────────────────────

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "fm-test-"));
}

test("loadCoveredTuples: nonexistent dir → empty set", () => {
  const got = loadCoveredTuples("/no/such/path/here-xyz");
  eq(got.size, 0);
});

test("loadCoveredTuples: empty dir → empty set", () => {
  const dir = makeTmpDir();
  try {
    const got = loadCoveredTuples(dir);
    eq(got.size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadCoveredTuples: ignores files without covers", () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "no-covers.md"),
      "---\ntitle: just a note\nstatus: active\n---\nbody\n");
    const got = loadCoveredTuples(dir);
    eq(got.size, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadCoveredTuples: collects from inline array form", () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "a.md"),
      '---\ncovers: ["a.com|fetch|x", "b.com|*|y"]\n---\nbody\n');
    const got = loadCoveredTuples(dir);
    eq(got.size, 2);
    truthy(got.has("a.com|fetch|x"));
    truthy(got.has("b.com|*|y"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadCoveredTuples: collects from block sequence form", () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "a.md"),
      '---\ncovers:\n  - "a.com|fetch|x"\n  - "b.com|*|y"\n---\nbody\n');
    const got = loadCoveredTuples(dir);
    eq(got.size, 2);
    truthy(got.has("a.com|fetch|x"));
    truthy(got.has("b.com|*|y"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadCoveredTuples: unions across multiple notes", () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "a.md"), '---\ncovers: ["a|x|y"]\n---\n');
    writeFileSync(join(dir, "b.md"), '---\ncovers: ["b|x|y"]\n---\n');
    const got = loadCoveredTuples(dir);
    eq(got.size, 2);
    truthy(got.has("a|x|y"));
    truthy(got.has("b|x|y"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadCoveredTuples: ignores non-md files", () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "a.md"), '---\ncovers: ["a|x|y"]\n---\n');
    writeFileSync(join(dir, "ignore.txt"), '---\ncovers: ["b|x|y"]\n---\n');
    const got = loadCoveredTuples(dir);
    eq(got.size, 1);
    truthy(got.has("a|x|y"));
    truthy(!got.has("b|x|y"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadCoveredTuples: malformed file is skipped (no throw)", () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "good.md"), '---\ncovers: ["a|x|y"]\n---\n');
    writeFileSync(join(dir, "bad.md"),  "this is not a markdown frontmatter file");
    const got = loadCoveredTuples(dir);
    eq(got.size, 1);
    truthy(got.has("a|x|y"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadCoveredTuples: includes covers regardless of status", () => {
  // A superseded note still suppresses proposals — that's the whole point.
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, "a.md"),
      '---\nstatus: superseded\ncovers: ["a|x|y"]\n---\n');
    const got = loadCoveredTuples(dir);
    truthy(got.has("a|x|y"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── summary ────────────────────────────────────────────────────────────────

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) {
  for (const f of failures) {
    process.stderr.write(`\n  ✗ ${f.name}\n    ${f.err.message}\n`);
  }
  process.exit(1);
}
process.exit(0);
