"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { evaluateDiff, canonicalRel } = require(path.join(__dirname, "..", "..", "tools/oracle/diff_gate.js"));

const GUARD = path.join(__dirname, "..", "..", "tools/oracle/git_guard.sh");

test("write_segregation: builder diff touching .oracle/** is REJECTED", () => {
  const r = evaluateDiff({ paths: [".oracle/hidden/secret.test.js"] }, "builder");
  assert.equal(r.accepted, false);
  assert.equal(r.category, "write-segregation");
  assert.deepEqual(r.offending, [".oracle/hidden/secret.test.js"]);
});

test("write_segregation: builder diff touching only product code is ACCEPTED", () => {
  const r = evaluateDiff({ paths: ["lib/store.js", "assets/engplan.js", "extensions/plans_server.js"] }, "builder");
  assert.equal(r.accepted, true);
});

test("write_segregation: builder edit of tools/oracle or test/oracle-harness rejected", () => {
  assert.equal(evaluateDiff({ paths: ["tools/oracle/mutate.js"] }, "builder").accepted, false);
  assert.equal(evaluateDiff({ paths: ["test/oracle-harness/sandbox_runner.test.js"] }, "builder").accepted, false);
});

test("write_segregation: designer edit of .oracle/** accepted; architect contract accepted", () => {
  assert.equal(evaluateDiff({ paths: [".oracle/hidden/x.js", ".oracle/properties/p.js"] }, "designer").accepted, true);
  assert.equal(evaluateDiff({ paths: [".oracle/contract/contract.json"] }, "architect").accepted, true);
});

test("write_segregation: architect may NOT touch non-contract oracle paths", () => {
  const r = evaluateDiff({ paths: [".oracle/hidden/x.js"] }, "architect");
  assert.equal(r.accepted, false);
});

test("write_segregation: rename smuggle into .oracle is caught", () => {
  const r = evaluateDiff({ paths: ["lib/x.js"], renames: [{ from: "lib/x.js", to: ".oracle/hidden/x.js" }] }, "builder");
  assert.equal(r.accepted, false);
  assert.ok(r.offending.includes(".oracle/hidden/x.js"));
});

test("write_segregation: traversal/normalization smuggle is caught", () => {
  const r = evaluateDiff({ paths: ["lib/../.oracle/mutants/m.js"] }, "builder");
  assert.equal(r.accepted, false);
  assert.equal(canonicalRel("lib/../.oracle/mutants/m.js"), ".oracle/mutants/m.js");
});

test("write_segregation: symlink into protected tree is caught", () => {
  const r = evaluateDiff({ paths: ["lib/link"], symlinks: [{ path: "lib/link", target: ".oracle/hidden" }] }, "builder");
  assert.equal(r.accepted, false);
});

test("write_segregation: path escaping repo root is rejected", () => {
  assert.throws(() => canonicalRel("../../etc/passwd"), (e) => e.category === "path-escape");
});

test("git_guard: independently blocks committed builder oracle edit", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-guard-"));
  cp.execSync("git init -q", { cwd: repo });
  cp.execSync("git config user.email t@t && git config user.name t", { cwd: repo, shell: "/bin/bash" });
  fs.mkdirSync(path.join(repo, ".oracle/hidden"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".oracle/hidden/h.js"), "// hidden");
  cp.execSync("git add .oracle/hidden/h.js", { cwd: repo });
  // builder blocked
  let blocked = false;
  try { cp.execSync(`bash ${GUARD}`, { cwd: repo, env: { ...process.env, ORACLE_LINEAGE_ROLE: "builder" } }); }
  catch (_) { blocked = true; }
  assert.ok(blocked, "git guard must block builder oracle edit");
  // designer passes
  cp.execSync(`bash ${GUARD}`, { cwd: repo, env: { ...process.env, ORACLE_LINEAGE_ROLE: "designer" } });
});

test("git_guard: builder editing only product code passes", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-guard2-"));
  cp.execSync("git init -q", { cwd: repo });
  cp.execSync("git config user.email t@t && git config user.name t", { cwd: repo, shell: "/bin/bash" });
  fs.mkdirSync(path.join(repo, "lib"), { recursive: true });
  fs.writeFileSync(path.join(repo, "lib/store.js"), "// code");
  cp.execSync("git add lib/store.js", { cwd: repo });
  cp.execSync(`bash ${GUARD}`, { cwd: repo, env: { ...process.env, ORACLE_LINEAGE_ROLE: "builder" } });
});
