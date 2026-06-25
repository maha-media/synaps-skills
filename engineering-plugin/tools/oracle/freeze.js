/*
 * freeze.js — Architect contract freeze + controlled re-freeze (spec §4.1, §9 #6).
 * Freeze writes an immutable hashed artifact + appends to the audit trail.
 * Re-freeze is only permitted through this controlled procedure. Stdlib only.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { parseContract, contentHash } = require("./contract.js");

function err(category, message) { const e = new Error(message); e.category = category; return e; }

class ContractFreezer {
  constructor(opts) {
    opts = opts || {};
    this.dir = opts.dir; // .oracle/contract
    this.revealDir = opts.revealDir; // .oracle/reveal
    this.clock = opts.clock || { now: () => new Date().toISOString() };
    this.ledger = opts.ledger || null;
  }

  _auditFile() { return path.join(this.revealDir, "freeze.log"); }

  /** Freeze a contract. role must be 'architect'. Records hash + audit entry. */
  freeze(contractRaw, opts) {
    opts = opts || {};
    if (opts.role && opts.role !== "architect") throw err("lineage-violation", "only the Architect lineage may freeze the contract");
    const { contract, hash } = parseContract(contractRaw);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.revealDir, { recursive: true });
    const frozenPath = path.join(this.dir, "frozen.json");
    if (fs.existsSync(frozenPath) && !opts.refreeze) {
      throw err("freeze-violation", "contract already frozen; re-freeze requires the controlled procedure (opts.refreeze + new commit-reveal)");
    }
    const artifact = Object.assign({}, contract, { _hash: hash, _frozen_at: this.clock.now() });
    fs.writeFileSync(frozenPath, JSON.stringify(artifact, null, 2));
    const entry = {
      event: opts.refreeze ? "refreeze" : "freeze",
      hash, ts: this.clock.now(),
      lineage: opts.lineage_id || "architect",
    };
    fs.appendFileSync(this._auditFile(), JSON.stringify(entry) + "\n");
    return { hash, path: frozenPath, entry };
  }

  /** Read the current frozen contract + verify its recorded hash. */
  current() {
    const frozenPath = path.join(this.dir, "frozen.json");
    if (!fs.existsSync(frozenPath)) throw err("not-found", "no frozen contract");
    const artifact = JSON.parse(fs.readFileSync(frozenPath, "utf8"));
    const recorded = artifact._hash;
    const copy = Object.assign({}, artifact); delete copy._hash; delete copy._frozen_at;
    const { hash } = parseContract(copy);
    if (hash !== recorded) throw err("integrity-violation", "frozen contract hash mismatch (tampered)");
    return { contract: copy, hash };
  }

  history() {
    if (!fs.existsSync(this._auditFile())) return [];
    return fs.readFileSync(this._auditFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
}

module.exports = { ContractFreezer };
