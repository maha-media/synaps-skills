/*
 * commit_reveal.js — commit-reveal protocol (spec §4.5, Assumption 10).
 * Designer commits a salted SHA-256 over a canonicalized bundle of the hidden
 * suite + mutants + generators BEFORE the Builder freezes its implementation;
 * reveals after freeze. Enforces ordering commit < freeze < reveal, and that a
 * post-freeze-weakened bundle fails to verify. Records to .oracle/reveal/.
 * Node stdlib only.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function err(category, message) { const e = new Error(message); e.category = category; return e; }

/** Canonical hash over a directory bundle: sorted (relpath, sha256(content)). */
function bundleHash(dirs, salt) {
  const entries = [];
  function walk(base, rel) {
    for (const ent of fs.readdirSync(path.join(base, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = path.posix.join(rel, ent.name);
      if (ent.isDirectory()) walk(base, r);
      else if (ent.isFile()) {
        const buf = fs.readFileSync(path.join(base, r));
        entries.push(r + ":" + crypto.createHash("sha256").update(buf).digest("hex"));
      }
    }
  }
  for (const d of dirs) {
    if (!fs.existsSync(d.path)) continue;
    const tagged = [];
    (function collect(rel) {
      for (const ent of fs.readdirSync(path.join(d.path, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const r = path.posix.join(rel, ent.name);
        if (ent.isDirectory()) collect(r);
        else if (ent.isFile()) tagged.push(d.tag + "/" + r + ":" + crypto.createHash("sha256").update(fs.readFileSync(path.join(d.path, r))).digest("hex"));
      }
    })("");
    entries.push(...tagged);
  }
  entries.sort();
  const h = crypto.createHash("sha256");
  h.update(salt || "");
  for (const e of entries) h.update("\n" + e);
  return "sha256:" + h.digest("hex");
}

class CommitReveal {
  constructor(opts) {
    opts = opts || {};
    this.revealDir = opts.revealDir;
    this.clock = opts.clock || { now: () => new Date().toISOString() };
    this.recFile = path.join(this.revealDir, "commit_reveal.log");
  }

  _append(rec) {
    fs.mkdirSync(this.revealDir, { recursive: true });
    fs.appendFileSync(this.recFile, JSON.stringify(rec) + "\n");
  }
  records() { return fs.existsSync(this.recFile) ? fs.readFileSync(this.recFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; }
  _last(event, round) { return this.records().filter((r) => r.event === event && r.round === round).slice(-1)[0]; }

  /** COMMIT: publish hash of the bundle before the Builder freezes. */
  commit(bundleDirs, opts) {
    opts = opts || {};
    const round = opts.round || 0;
    if (this._last("freeze", round)) throw err("ordering-violation", "cannot commit after Builder freeze (round " + round + ")");
    const nonce = opts.nonce || crypto.randomBytes(8).toString("hex");
    const hash = bundleHash(bundleDirs, nonce);
    const rec = { event: "commit", round, hash, nonce, ts: this.clock.now(), lineage: opts.lineage || "designer" };
    this._append(rec);
    return rec; // hash only; bundle content NOT revealed
  }

  /** FREEZE: record Builder implementation freeze (must come after commit). */
  freeze(implHash, opts) {
    opts = opts || {};
    const round = opts.round || 0;
    if (!this._last("commit", round)) throw err("ordering-violation", "Builder freeze rejected: no prior commit (round " + round + ")");
    const rec = { event: "freeze", round, impl_hash: implHash, ts: this.clock.now(), lineage: opts.lineage || "builder" };
    this._append(rec);
    return rec;
  }

  /** REVEAL: re-hash the bundle + verify against the commit. Must come after freeze. */
  reveal(bundleDirs, opts) {
    opts = opts || {};
    const round = opts.round || 0;
    const commit = this._last("commit", round);
    if (!commit) throw err("ordering-violation", "reveal rejected: no commit (round " + round + ")");
    if (!this._last("freeze", round)) throw err("ordering-violation", "reveal rejected: Builder has not frozen (round " + round + ")");
    const rehash = bundleHash(bundleDirs, commit.nonce);
    const verified = rehash === commit.hash;
    const rec = { event: "reveal", round, verified, expected: commit.hash, actual: rehash, ts: this.clock.now(), lineage: opts.lineage || "designer" };
    this._append(rec);
    if (!verified) throw err("reveal-mismatch", "revealed bundle does not match commit (post-hoc adaptation detected)");
    return rec;
  }
}

module.exports = { CommitReveal, bundleHash };
