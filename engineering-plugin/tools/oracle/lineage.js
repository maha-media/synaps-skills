/*
 * lineage.js — dispatch ledger. Records every role dispatch and enforces the
 * siblings-not-nested rule (spec §3 rule 1) + subagent doctrine (parent §9.1/§9.2).
 * Append-only, auditable. Node stdlib only.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROLES = ["orchestrator", "architect", "designer", "builder", "tester", "judge"];
const SESSION_MODEL = "claude-opus-4-8"; // session model; used when dispatch omits model

function err(category, message) {
  const e = new Error(message);
  e.category = category;
  return e;
}

class LineageLedger {
  constructor(opts) {
    opts = opts || {};
    this.entries = [];
    this.file = opts.file || null;
    this.clock = opts.clock || { now: () => new Date().toISOString() };
    if (this.file && fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, "utf8").split("\n")) {
        if (line.trim()) this.entries.push(JSON.parse(line));
      }
    }
  }

  _byId(id) { return this.entries.find((e) => e.lineage_id === id); }

  /** Is `ancestorId` an ancestor of `id` (walking parent links)? */
  isAncestor(ancestorId, id) {
    let cur = this._byId(id);
    const seen = new Set();
    while (cur && cur.parent_id) {
      if (seen.has(cur.lineage_id)) break;
      seen.add(cur.lineage_id);
      if (cur.parent_id === ancestorId) return true;
      cur = this._byId(cur.parent_id);
    }
    return false;
  }

  /**
   * Record a dispatch. Enforces:
   *  - agent OR system_prompt present (never neither) — parent §9.1
   *  - model resolves to session model when unspecified — parent §9.2
   *  - role is known
   * Returns the recorded entry.
   */
  dispatch(d) {
    d = d || {};
    if (!ROLES.includes(d.role)) throw err("validation-error", "unknown role: " + d.role);
    const hasAgent = typeof d.agent === "string" && d.agent.length > 0;
    const hasPrompt = typeof d.system_prompt === "string" && d.system_prompt.length > 0;
    if (!hasAgent && !hasPrompt) throw err("dispatch-doctrine", "dispatch must set agent OR system_prompt (never neither)");
    const model = d.model && typeof d.model === "string" ? d.model : SESSION_MODEL;
    const lineage_id = d.lineage_id || (d.role + "_" + crypto.randomBytes(5).toString("hex"));
    if (this._byId(lineage_id)) throw err("validation-error", "duplicate lineage_id: " + lineage_id);
    const parent_id = d.parent_id || null;
    if (parent_id && !this._byId(parent_id)) throw err("validation-error", "unknown parent_id: " + parent_id);
    const entry = {
      lineage_id, role: d.role, parent_id,
      agent: hasAgent ? d.agent : null,
      has_system_prompt: hasPrompt,
      model,
      ts: this.clock.now(),
    };
    this.entries.push(entry);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(entry) + "\n");
    }
    return entry;
  }

  /**
   * Assert Designer and Builder are siblings under a neutral orchestrator:
   * neither is an ancestor/descendant of the other, and a grader never parents
   * the graded party. Throws categorized error otherwise.
   */
  assertSiblings(designerId, builderId) {
    if (!this._byId(designerId)) throw err("validation-error", "unknown designer lineage: " + designerId);
    if (!this._byId(builderId)) throw err("validation-error", "unknown builder lineage: " + builderId);
    if (designerId === builderId) throw err("lineage-violation", "designer and builder must be distinct lineages");
    if (this.isAncestor(designerId, builderId)) throw err("lineage-violation", "designer must not be an ancestor of builder (grader cannot parent graded)");
    if (this.isAncestor(builderId, designerId)) throw err("lineage-violation", "builder must not be an ancestor of designer (graded cannot parent grader)");
    const d = this._byId(designerId), b = this._byId(builderId);
    if (!d.parent_id || !b.parent_id) throw err("lineage-violation", "designer and builder must each have a neutral parent (orchestrator)");
    return true;
  }

  roleOf(id) { const e = this._byId(id); return e ? e.role : null; }
}

module.exports = { LineageLedger, ROLES, SESSION_MODEL };
