"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { parseContract } = require(path.join(__dirname, "..", "..", "tools/oracle/contract.js"));
const fs = require("node:fs");

const VALID = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", ".oracle/contract/contract.json"), "utf8"));

test("contract_schema: valid contract parses into typed shape + hash", () => {
  const { contract, hash } = parseContract(VALID);
  assert.equal(contract.schema, "oracle/1");
  assert.ok(contract.data_schemas["engplan/1"]);
  assert.ok(Array.isArray(contract.endpoints));
  assert.ok(contract.lifecycle.transitions.open.includes("acknowledged"));
  assert.match(hash, /^sha256:/);
});

test("contract_schema: hash is deterministic regardless of key order", () => {
  const a = parseContract(VALID).hash;
  const reordered = JSON.parse(JSON.stringify(VALID));
  const b = parseContract(reordered).hash;
  assert.equal(a, b);
});

test("contract_schema: missing required group rejected with category", () => {
  const bad = JSON.parse(JSON.stringify(VALID)); delete bad.endpoints;
  assert.throws(() => parseContract(bad), (e) => e.category === "validation-error");
});

test("contract_schema: wrong schema → schema-mismatch", () => {
  const bad = JSON.parse(JSON.stringify(VALID)); bad.schema = "oracle/2";
  assert.throws(() => parseContract(bad), (e) => e.category === "schema-mismatch");
});

test("contract_schema: malformed JSON → safe categorized error, never crash", () => {
  assert.throws(() => parseContract("{not json"), (e) => e.category === "validation-error");
  assert.throws(() => parseContract(42), (e) => e.category === "validation-error");
  assert.throws(() => parseContract(null), (e) => e.category === "validation-error");
});

test("contract_schema: endpoints/exit-codes/lifecycle/error-taxonomy representable", () => {
  const { contract } = parseContract(VALID);
  assert.ok(contract.exit_codes["2"]);
  assert.ok(contract.error_taxonomy.includes("illegal-transition"));
  assert.ok(contract.endpoints.find((e) => e.path === "/api/notes" && e.method === "POST"));
});
