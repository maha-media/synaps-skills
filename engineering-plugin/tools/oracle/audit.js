/*
 * audit.js — durable, replayable audit trail (spec §6, §8) + Plan Inbox
 * surfacing (Ambiguity D). Every freeze/commit/reveal/verdict/mutation/lineage
 * record is appended immutably with lineage + time. Status (counts/categories/
 * verdict state) is surfaced to the Plan Inbox as `oracle-status` — NEVER raw
 * hidden test source. Node stdlib only.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { parseVerdict, looksLikeLeak } = require("./verdict.js");

function err(category, message) { const e = new Error(message); e.category = category; return e; }

class AuditTrail {
  constructor(opts) {
    opts = opts || {};
    this.dir = opts.dir; // .oracle/verdicts
    this.plansDir = opts.plansDir || null; // .plans (optional, for inbox surfacing)
    this.clock = opts.clock || { now: () => new Date().toISOString() };
    this.file = path.join(this.dir, "audit-trail.jsonl");
  }

  append(kind, payload, lineage) {
    fs.mkdirSync(this.dir, { recursive: true });
    // Guard: nothing leaky enters the trail's surfaced fields.
    if (looksLikeLeak(payload)) throw err("egress-leak", "audit payload appears to leak test source");
    const rec = { kind, ts: this.clock.now(), lineage: lineage || "orchestrator", payload };
    fs.appendFileSync(this.file, JSON.stringify(rec) + "\n");
    return rec;
  }

  /** Surface a minimized oracle-status to the Plan Inbox (no hidden source). */
  surface(slug, status) {
    if (!this.plansDir) return null;
    // Only counts/categories/state may be surfaced.
    const minimal = {
      kind: "oracle-status",
      round: status.round,
      state: status.state,
      counts: status.counts ? { pass: status.counts.pass, fail: status.counts.fail } : undefined,
      categories: (status.categories || []).map((c) => (typeof c === "string" ? c : c.category)),
      score: status.score,
      ts: this.clock.now(),
    };
    if (looksLikeLeak(minimal)) throw err("egress-leak", "oracle-status would leak");
    fs.mkdirSync(this.plansDir, { recursive: true });
    const f = path.join(this.plansDir, slug + ".oracle.jsonl");
    fs.appendFileSync(f, JSON.stringify(minimal) + "\n");
    return minimal;
  }

  records() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  /** Replay the trail to reconstruct a round's history (audit reconstruction). */
  replay(round) {
    return this.records().filter((r) => r.payload && (r.payload.round === round || round == null));
  }
}

module.exports = { AuditTrail };
