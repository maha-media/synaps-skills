/*
 * state.js — Checkpoint-Aware Compaction (CAC) state machine.
 * Implements spec §5 "The resume contract" state diagram:
 *   RUNNING → ARMED → CHECKPOINT_REACHED → SUSPENDED → COMPACTING → RESUMING → RUNNING
 *
 * PURE module: no fs / process / network / clock. Same input → same output.
 *
 * Contract:
 *   transition(currentState, event, ctx) → { state, reason }
 *     - On a legal transition (and any guard conditions in `ctx` satisfied),
 *       returns { state: <nextState>, reason: <human-readable why> }.
 *     - On an illegal transition (unknown state/event, wrong edge, or a guard
 *       condition not met) THROWS an Error whose message explains the rejection.
 *       The thrown Error also carries `.reason` for programmatic inspection.
 *
 * Guards (spec §5 CHECKPOINT_REACHED → SUSPENDED preconditions, §8):
 *   The token_persisted & tree_clean & gate_green event requires ctx to assert
 *   token_persisted === true, tree_clean === true, gate_green === true.
 */
"use strict";

// §5 states.
const STATES = Object.freeze({
  RUNNING: "RUNNING",
  ARMED: "ARMED",
  CHECKPOINT_REACHED: "CHECKPOINT_REACHED",
  SUSPENDED: "SUSPENDED",
  COMPACTING: "COMPACTING",
  RESUMING: "RESUMING",
});

// §5 events (edge labels in the diagram).
const EVENTS = Object.freeze({
  CONTEXT_PRESSURE: "context_pressure",
  SAFE_POINT_REACHED: "safe_point_reached",
  CHECKPOINT_COMMITTED: "token_persisted_tree_clean_gate_green",
  PRE_COMPACT_OK: "pre_compact_ok",
  SUMMARY_BUILT: "summary_built",
  CONTINUITY_VERIFIED: "continuity_verified",
});

// Edge table: state -> event -> { to, guard?(ctx) -> null | reason-string }.
// A guard returns null when satisfied, or a string describing the failure.
const EDGES = {
  [STATES.RUNNING]: {
    [EVENTS.CONTEXT_PRESSURE]: {
      to: STATES.ARMED,
      reason: "context_pressure crossed high watermark; arming compaction",
    },
  },
  [STATES.ARMED]: {
    [EVENTS.SAFE_POINT_REACHED]: {
      to: STATES.CHECKPOINT_REACHED,
      reason: "next safe point reached while armed",
    },
  },
  [STATES.CHECKPOINT_REACHED]: {
    [EVENTS.CHECKPOINT_COMMITTED]: {
      to: STATES.SUSPENDED,
      guard(ctx) {
        ctx = ctx || {};
        if (ctx.token_persisted !== true) return "resume token not persisted";
        if (ctx.tree_clean !== true) return "working tree not clean";
        if (ctx.gate_green !== true) return "checkpoint gate not green";
        return null;
      },
      reason: "resume token persisted, tree clean, gate green; suspending",
    },
  },
  [STATES.SUSPENDED]: {
    [EVENTS.PRE_COMPACT_OK]: {
      to: STATES.COMPACTING,
      reason: "pre-compact hook allowed; compacting",
    },
  },
  [STATES.COMPACTING]: {
    [EVENTS.SUMMARY_BUILT]: {
      to: STATES.RESUMING,
      reason: "artifact-anchored summary built; resuming",
    },
  },
  [STATES.RESUMING]: {
    [EVENTS.CONTINUITY_VERIFIED]: {
      to: STATES.RUNNING,
      reason: "post-compact continuity verified; running next task",
    },
  },
};

/**
 * Guarded transition. See header for the contract.
 * @param {string} currentState one of STATES
 * @param {string} event one of EVENTS
 * @param {object} [ctx] guard context (e.g. { token_persisted, tree_clean, gate_green })
 * @returns {{state: string, reason: string}}
 */
function transition(currentState, event, ctx) {
  if (!Object.prototype.hasOwnProperty.call(EDGES, currentState) && !STATES[currentState]) {
    throw mkErr("unknown state: " + String(currentState));
  }
  const fromEdges = EDGES[currentState];
  if (!fromEdges) {
    // Valid terminal-ish state with no outgoing edges (none in this machine),
    // but treat as illegal transition for any event.
    throw mkErr("no transitions defined from state " + currentState);
  }
  const edge = fromEdges[event];
  if (!edge) {
    throw mkErr(
      "illegal transition: " + currentState + " --" + String(event) + "--> (no such edge)"
    );
  }
  if (typeof edge.guard === "function") {
    const failure = edge.guard(ctx);
    if (failure !== null) {
      throw mkErr(
        "guard rejected " + currentState + " --" + event + "--> " + edge.to + ": " + failure
      );
    }
  }
  return { state: edge.to, reason: edge.reason };
}

function mkErr(message) {
  const e = new Error(message);
  e.reason = message;
  return e;
}

module.exports = { STATES, EVENTS, transition };
