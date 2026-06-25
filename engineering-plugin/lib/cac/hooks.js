/*
 * hooks.js — Checkpoint-Aware Compaction (CAC) §7 hook producer/handlers.
 * Implements spec §7 "Hook contracts (Synaps)": the three plugin-registered
 * hooks `checkpoint.reached` (producer), `pre-compact` (gate), `post-compact`
 * (resume). The producer payload is the §4 safe-point boundary event
 * `checkpoint.reached(Cn)` carrying {slug, phase, checkpoint, head_commit}.
 *
 * This module is PURE/INJECTABLE: the SSE surface is reached only through an
 * injected `broadcast` (the server's broadcastPlan), and the gate/resume hooks
 * are thin wrappers delegating to pregate.js / postgate.js. No fs / network /
 * clock side effects of its own.
 */
"use strict";

// §7 hook manifest — the three hooks registered by the engineering plugin.
const HOOK_NAMES = Object.freeze(["checkpoint.reached", "pre-compact", "post-compact"]);

/**
 * Build the §4 safe-point producer payload for `checkpoint.reached`.
 * Validates the required fields (§7 contract carries slug/phase/checkpoint;
 * head_commit is the ground-truth anchor §5/§6).
 * @param {{slug:string, phase:string, checkpoint:string, head_commit?:string}} args
 * @returns {{type:string, slug:string, phase:string, checkpoint:string, head_commit:(string|null)}}
 * @throws {Error} if slug / phase / checkpoint are missing
 */
function checkpointReachedEvent(args) {
  args = args || {};
  const { slug, phase, checkpoint } = args;
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("checkpointReachedEvent: missing required field 'slug'");
  }
  if (typeof phase !== "string" || phase.length === 0) {
    throw new Error("checkpointReachedEvent: missing required field 'phase'");
  }
  if (typeof checkpoint !== "string" || checkpoint.length === 0) {
    throw new Error("checkpointReachedEvent: missing required field 'checkpoint'");
  }
  return {
    type: "checkpoint.reached",
    slug,
    phase,
    checkpoint,
    head_commit: typeof args.head_commit === "string" ? args.head_commit : null,
  };
}

/**
 * Emit the §4 `checkpoint.reached` safe-point event onto the SSE bus, reusing
 * the injected broadcastPlan producer (broadcast(slug, payload)).
 * @param {function(string, object): void} broadcast  the injected broadcastPlan
 * @param {object} args  see checkpointReachedEvent
 * @returns {object} the emitted event
 */
function emitCheckpointReached(broadcast, args) {
  if (typeof broadcast !== "function") {
    throw new Error("emitCheckpointReached: 'broadcast' must be a function");
  }
  const event = checkpointReachedEvent(args);
  broadcast(event.slug, event);
  return event;
}

/**
 * §7 `pre-compact` gate — thin wrapper delegating to pregate.preCompact.
 * @param {object} ctx
 * @returns {{allow:boolean, reason:string}}
 */
function preCompactHook(ctx) {
  return require("./pregate.js").preCompact(ctx);
}

/**
 * §7 `post-compact` resume hook — thin wrapper delegating to postgate.postCompact.
 * @param {object} ctx
 * @returns {object}
 */
function postCompactHook(ctx) {
  return require("./postgate.js").postCompact(ctx);
}

module.exports = {
  HOOK_NAMES,
  checkpointReachedEvent,
  emitCheckpointReached,
  preCompactHook,
  postCompactHook,
};
