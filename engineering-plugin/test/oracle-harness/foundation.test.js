"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

test("foundation: .oracle layout matches spec §6", () => {
  for (const d of ["contract", "public", "hidden", "properties", "mutants", "fuzz", "reveal", "verdicts"]) {
    assert.ok(fs.existsSync(path.join(ROOT, ".oracle", d)), "missing .oracle/" + d);
  }
});

test("foundation: tools/oracle + test/oracle-harness exist", () => {
  assert.ok(fs.existsSync(path.join(ROOT, "tools", "oracle")));
  assert.ok(fs.existsSync(path.join(ROOT, "test", "oracle-harness")));
});

test("foundation: frozen contract is present and content-addressable", () => {
  const { parseContract } = require(path.join(ROOT, "tools/oracle/contract.js"));
  const raw = fs.readFileSync(path.join(ROOT, ".oracle/contract/contract.json"), "utf8");
  const { contract, hash } = parseContract(raw);
  assert.equal(contract.schema, "oracle/1");
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
});

test("foundation: no third-party deps (node_modules absent / empty)", () => {
  const nm = path.join(ROOT, "node_modules");
  if (fs.existsSync(nm)) {
    const entries = fs.readdirSync(nm).filter((e) => !e.startsWith("."));
    assert.equal(entries.length, 0, "expected zero third-party packages, found: " + entries.join(","));
  }
});
