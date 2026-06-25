/*
 * contract.js — oracle/1 contract boundary validator + content addressing.
 * Authored by the Orchestrator/Architect lineage (neutral infra). The contract
 * is the shared ground truth bound by both Designer and Builder. Node stdlib only.
 */
"use strict";
const crypto = require("crypto");

const REQUIRED_GROUPS = [
  "data_schemas", "endpoints", "exit_codes", "lifecycle", "error_taxonomy",
];

function err(category, message) {
  const e = new Error(message);
  e.category = category;
  return e;
}

/** Stable stringify (sorted keys) for content addressing. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

function contentHash(contract) {
  return "sha256:" + crypto.createHash("sha256").update(canonical(contract)).digest("hex");
}

/**
 * Parse + validate a contract. Never throws on malformed input shape — returns
 * a categorized error instead of crashing (mirrors the build's boundary discipline).
 */
function parseContract(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch (e) { throw err("validation-error", "contract is not valid JSON: " + e.message); }
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw err("validation-error", "contract must be an object");
  }
  if (obj.schema !== "oracle/1") throw err("schema-mismatch", "unsupported contract schema: " + JSON.stringify(obj.schema));
  if (obj.kind !== "contract") throw err("schema-mismatch", "contract.kind must be 'contract'");
  if (typeof obj.version !== "string" || !obj.version) throw err("validation-error", "contract.version required");
  if (typeof obj.frozen_at !== "string" || !obj.frozen_at) throw err("validation-error", "contract.frozen_at required");
  for (const g of REQUIRED_GROUPS) {
    if (!(g in obj)) throw err("validation-error", "contract missing required group: " + g);
  }
  if (!obj.data_schemas["engplan/1"]) throw err("validation-error", "contract must describe engplan/1 data schema");
  if (!Array.isArray(obj.endpoints) || obj.endpoints.length === 0) throw err("validation-error", "contract.endpoints must be a non-empty array");
  for (const ep of obj.endpoints) {
    if (!ep.method || !ep.path || typeof ep.ok !== "number") throw err("validation-error", "endpoint requires method,path,ok: " + JSON.stringify(ep));
  }
  if (!obj.lifecycle || !obj.lifecycle.transitions) throw err("validation-error", "contract.lifecycle.transitions required");
  if (!Array.isArray(obj.error_taxonomy) || obj.error_taxonomy.length === 0) throw err("validation-error", "contract.error_taxonomy must be a non-empty array");

  const parsed = Object.freeze(Object.assign({}, obj));
  return { contract: parsed, hash: contentHash(parsed) };
}

module.exports = { parseContract, contentHash, canonical, REQUIRED_GROUPS };
