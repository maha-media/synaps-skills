/*
 * actorsim.js — ActorSim driver (spec §3.6, Addendum A.2, H-2).
 * Scripted actor with two modes: 'human' and 'orchestrator'. Emits all 14
 * section actions over the Plans Server HTTP API, stamping the correct `actor`.
 * This is also the orchestrator-in-the-loop reference implementation: the same
 * code a real supervising agent uses to steer a fresh Builder via the inbox.
 */
"use strict";
const EngPlan = require("../../assets/engplan.js");

class ActorSim {
  constructor(ctx, opts) {
    opts = opts || {};
    this.client = ctx.client;
    this.slug = opts.slug;
    this.mode = opts.mode === "orchestrator" ? "orchestrator" : "human";
    this.author = opts.author || (this.mode === "orchestrator" ? "orchestrator-1" : "operator");
  }
  get actor() { return this.mode; }

  async act(type, sectionId, text, extra) {
    if (EngPlan.EVENT_TYPES.indexOf(type) === -1) throw new Error("unknown action: " + type);
    const body = Object.assign({
      plan_id: this.slug, section_id: sectionId, type,
      actor: this.actor, author: this.author, text: text || "",
    }, extra || {});
    const res = await this.client.post("/api/notes", body);
    if (res.status !== 200) throw new Error("act " + type + " failed: " + res.status + " " + res.text);
    return res.json;
  }

  // Convenience methods for each of the 14 actions.
  comment(s, t) { return this.act("comment", s, t); }
  requestChange(s, t) { return this.act("request_change", s, t); }
  block(s, t) { return this.act("block", s, t); }
  approve(s, t) { return this.act("approve", s, t); }
  reprioritize(s, t) { return this.act("reprioritize", s, t); }
  markRisky(s, t) { return this.act("mark_risky", s, t); }
  addAcceptanceCriterion(s, t) { return this.act("add_acceptance_criterion", s, t); }
  clarify(s, t) { return this.act("clarify", s, t); }
  forceVerification(s, t) { return this.act("force_verification", s, t); }
  defer(s, t) { return this.act("defer", s, t); }
  splitTask(s, t) { return this.act("split_task", s, t); }
  mergeTask(s, t) { return this.act("merge_task", s, t); }
  escalateConvergence(s, t) { return this.act("escalate_convergence", s, t); }
  requireSecurityReview(s, t) { return this.act("require_security_review", s, t); }
  doNotTouch(s, t) { return this.act("do_not_touch", s, t); }

  async readInbox() {
    const res = await this.client.get("/api/notes?plan=" + encodeURIComponent(this.slug));
    return res.json;
  }
  async plans() { return (await this.client.get("/api/plans")).json; }
}

module.exports = { ActorSim };
