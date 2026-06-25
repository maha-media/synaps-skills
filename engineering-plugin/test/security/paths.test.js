/*
 * paths.test.js — P4-SEC-3: lib/paths.js confines resolution to a root.
 * Rejects traversal and symlink escape; confines absolute paths; allows
 * legitimate in-root paths.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { safeResolve, safeRealpath, isInside } = require("../../lib/paths.js");

function mkroot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "engplan-paths-"));
  const root = path.join(base, "root");
  fs.mkdirSync(root, { recursive: true });
  return { base, root };
}

test("traversal '../../etc/passwd' is rejected", () => {
  const { base, root } = mkroot();
  try {
    assert.throws(() => safeResolve(root, "../../etc/passwd"), /escapes root/);
    assert.throws(() => safeRealpath(root, "../../../etc/passwd"), /escapes root/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("absolute path is confined (treated as root-relative, never escapes)", () => {
  const { base, root } = mkroot();
  try {
    const resolved = safeResolve(root, "/etc/passwd");
    assert.ok(isInside(root, resolved), "absolute path confined inside root");
    assert.ok(!resolved.startsWith(path.sep + "etc"), "not the real /etc/passwd");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("symlink escaping root is rejected", () => {
  const { base, root } = mkroot();
  try {
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
    // create a symlink inside root pointing outside root
    const link = path.join(root, "escape");
    fs.symlinkSync(outside, link, "dir");

    assert.throws(() => safeRealpath(root, "escape/secret.txt"), /symlink escapes root/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("legitimate in-root path is allowed", () => {
  const { base, root } = mkroot();
  try {
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "ok.txt"), "fine");
    const r1 = safeResolve(root, "sub/ok.txt");
    assert.ok(isInside(root, r1));
    const r2 = safeRealpath(root, "sub/ok.txt");
    assert.ok(isInside(root, r2));
    assert.equal(path.basename(r2), "ok.txt");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
