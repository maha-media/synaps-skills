/*
 * orchestratorsim.js — OrchestratorSim (Addendum A.6 H-6, spec §3.7, §9.1/§9.2).
 * Reference reactive-coder orchestration loop: dispatch reactive coders, POLL
 * status (never long-sleep), steer via the Plan Inbox (actor:orchestrator
 * events), collect results. Enforces dispatch invariants:
 *   role = (agent | system_prompt)   — never neither
 *   model = explicit ?? session_model — never a silent weaker default
 */
"use strict";
const { ActorSim } = require("./actorsim.js");

const DISPATCH_ERROR = "Must provide either 'agent' (name) or 'system_prompt' (inline). Got neither.";

class OrchestratorSim {
  constructor(ctx, opts) {
    opts = opts || {};
    this.ctx = ctx;
    this.slug = opts.slug;
    this.sessionModel = opts.sessionModel || "claude-opus-4-8";
    this.audit = [];          // dispatch packets recorded
    this.pollCount = 0;
    this.maxSleepMs = 0;      // longest blocking sleep observed (must stay ~0)
    this.steerActor = new ActorSim(ctx, { slug: this.slug, mode: "orchestrator", author: opts.author || "orchestrator" });
  }

  // §9.1 + §9.2 dispatch invariants. Returns a resolved dispatch packet.
  dispatch(packet, coder) {
    packet = packet || {};
    const role = packet.role || {};
    const hasAgent = typeof role.agent === "string" && role.agent.length > 0;
    const hasPrompt = typeof role.system_prompt === "string" && role.system_prompt.length > 0;
    if (!hasAgent && !hasPrompt) { const e = new Error(DISPATCH_ERROR); e.code = "NO_ROLE"; throw e; }
    const model = packet.model != null && packet.model !== "" ? packet.model : this.sessionModel;
    const resolved = {
      role: hasAgent ? { agent: role.agent } : { system_prompt: role.system_prompt },
      model,
      model_inherited: !(packet.model != null && packet.model !== ""),
      reactive: packet.reactive !== false,
      coder,
      status: "running",
    };
    this.audit.push({ role: resolved.role, model: resolved.model, model_inherited: resolved.model_inherited, reactive: resolved.reactive });
    return resolved;
  }

  // Poll a handle's status — cheap, non-blocking. Never inserts a long sleep.
  poll(handle) { this.pollCount++; return handle.status; }

  // Steer a RUNNING coder via the inbox (durable, explicit artifact). The coder
  // picks it up at its next reconcile checkpoint — no restart, no hidden context.
  async steer(sectionId, type, text) {
    return this.steerActor.act(type, sectionId, text);
  }

  // The supervision loop: dispatch → poll → on idle/needs-steering write inbox
  // event → coder reconciles → repeat until done. Uses an injectable `sleep`
  // that records duration so an idle-sleep regression is caught (§3.7, H-6).
  async runLoop(handle, opts) {
    opts = opts || {};
    const steps = opts.steps || [];
    const sleepFn = opts.sleep || (async (ms) => { this.maxSleepMs = Math.max(this.maxSleepMs, ms); });
    let i = 0;
    let guard = 0;
    while (handle.status === "running" && guard++ < 1000) {
      const st = this.poll(handle);
      if (st === "running") {
        if (i < steps.length) {
          const step = steps[i++];
          await this.steer(step.section_id, step.type, step.text);
          // nudge coder to reconcile (lightweight); content lives in inbox.
          if (handle.coder && handle.coder.reconcile) await handle.coder.reconcile(step.evaluate);
        } else {
          handle.status = "done";
        }
        // poll cadence — must be a SHORT yield, not a long blocking sleep.
        await sleepFn(opts.pollMs || 0);
      }
    }
    handle.status = "done";
    return { audit: this.audit, pollCount: this.pollCount, maxSleepMs: this.maxSleepMs };
  }
}

module.exports = { OrchestratorSim, DISPATCH_ERROR };
