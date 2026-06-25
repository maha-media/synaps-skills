/*
 * agentsim.js — AgentSim driver (Addendum A.2, H-3). Deterministic stand-in for
 * the real agent: streams plan sections (live-write), runs the reconcile loop
 * (§3.5), writes agent responses (P3-3), flips task states, attaches verification
 * evidence, and honors blocking semantics (§3.4) + force_verification (S5).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const EngPlan = require("../../assets/engplan.js");
const inbox = require("../../lib/inbox.js");
const { extractPlanJson } = require("../../lib/discovery.js");
const { planArtifact } = require("./runner.js");

class AgentSim {
  constructor(ctx, opts) {
    opts = opts || {};
    this.ctx = ctx;
    this.client = ctx.client;
    this.repoRoot = ctx.repoRoot;
    this.slug = opts.slug;
    this.kind = opts.kind || "plan";
    this.author = opts.author || "builder";
  }

  _file() { return path.join(this.repoRoot, ".plans", this.slug + "." + this.kind + ".html"); }

  _readPlan() {
    const txt = fs.readFileSync(this._file(), "utf8");
    const json = extractPlanJson(txt);
    return EngPlan.parseEngPlan(json);
  }
  _writePlan(plan) {
    fs.writeFileSync(this._file(), planArtifact(plan));
  }

  // Create the initial artifact (empty sections) — start of live writing.
  init(meta) {
    const plan = Object.assign({
      schema: "engplan/1", kind: this.kind, slug: this.slug,
      title: meta && meta.title || this.slug, status: "drafting", convergence: "none", sections: [],
    }, meta || {});
    plan.slug = this.slug; plan.kind = this.kind; plan.schema = "engplan/1";
    plan.sections = plan.sections || [];
    this._writePlan(plan);
    return plan;
  }

  // Append a single section (live-write path → watcher → SSE).
  streamSection(section) {
    const plan = this._readPlan();
    const idx = plan.sections.findIndex((s) => s.id === section.id);
    if (idx === -1) plan.sections.push(section); else plan.sections[idx] = section;
    this._writePlan(plan);
    return section;
  }

  // Flip a task's state (todo→doing→done).
  setState(sectionId, state) {
    const plan = this._readPlan();
    const s = plan.sections.find((x) => x.id === sectionId);
    if (!s) throw new Error("no section " + sectionId);
    s.state = state;
    this._writePlan(plan);
    return s;
  }

  // Attach a verification evidence section (P0/verification-before-completion).
  attachEvidence(id, heading, md, verification) {
    return this.streamSection({ id, heading, type: "evidence", md: md || "", verification: verification || [] });
  }

  // Is a task eligible to start? Honors blocking semantics.
  async canStart(sectionId) {
    const plan = this._readPlan();
    const { events } = (await this.client.get("/api/notes?plan=" + this.slug)).json;
    return inbox.canStart(plan, events, sectionId);
  }

  // Attempt to advance a task; refuses (throws) if halted by an open block.
  async attemptTask(sectionId) {
    if (!(await this.canStart(sectionId))) {
      const e = new Error("halted: " + sectionId + " blocked by open block event");
      e.code = "HALTED";
      throw e;
    }
    return this.setState(sectionId, "doing");
  }

  // Reconcile loop (§3.5): read open events ordered by created_at; for each,
  // respond via the respond endpoint with a decision from `evaluate`.
  // evaluate(ev, plan) -> { decision, response, changed_sections } or null to skip.
  async reconcile(evaluate) {
    evaluate = evaluate || ((ev) => inbox.defaultEvaluate(ev));
    const plan = this._readPlan();
    const { events } = (await this.client.get("/api/notes?plan=" + this.slug)).json;
    const open = events.filter((e) => e.status === "open" || e.status === "acknowledged")
      .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
    const responses = [];
    for (const ev of open) {
      const verdict = evaluate(ev, plan) || inbox.defaultEvaluate(ev, plan);
      const res = await this.client.post("/api/events/" + encodeURIComponent(ev.id) + "/respond", {
        plan_id: this.slug,
        agent_status: verdict.decision,
        agent_response: verdict.response,
        changed_sections: verdict.changed_sections || [ev.section_id],
      });
      if (res.status !== 200) throw new Error("respond failed: " + res.status + " " + res.text);
      responses.push(res.json);
    }
    return responses;
  }

  // Claim completion only if no open force_verification without fresh evidence.
  async claimCompletion(taskId, evidenceId) {
    const { events } = (await this.client.get("/api/notes?plan=" + this.slug)).json;
    const fv = events.filter((e) => e.type === "force_verification" && e.section_id === taskId && (e.status === "open" || e.status === "acknowledged"));
    const plan = this._readPlan();
    const hasEvidence = plan.sections.some((s) => s.id === evidenceId && s.type === "evidence");
    if (fv.length && !hasEvidence) {
      const e = new Error("cannot claim completion: force_verification open without evidence");
      e.code = "NEED_EVIDENCE";
      throw e;
    }
    return this.setState(taskId, "done");
  }
}

module.exports = { AgentSim };
