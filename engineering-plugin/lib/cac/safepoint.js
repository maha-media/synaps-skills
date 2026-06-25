/*
 * safepoint.js — Checkpoint-Aware Compaction (CAC) safe-point taxonomy.
 * Implements spec §4 "Safe points (the compaction schedule)": the declared
 * boundary event taxonomy and the `isSafePoint` predicate (with §4
 * invalidators). PURE module: no fs / process / network / clock.
 *
 * §4 event taxonomy (a safe point is a *declared boundary*, not any quiet
 * moment):
 *   subagent.finished | commit.landed | phase.transition |
 *   checkpoint.reached | inbox.idle
 *
 * ctx shape for isSafePoint(ctx):
 *   {
 *     event: string | { type: string },  // the boundary event (§4)
 *     tree_clean: boolean,                // false ⇒ dirty tree, invalid
 *     tool_in_flight: boolean,            // true ⇒ tool call in flight, invalid
 *     subagent_running: boolean,          // true ⇒ subagent running, invalid
 *     gate_green: boolean,                // !== true ⇒ gate not asserted, invalid
 *   }
 * isSafePoint returns TRUE only when `event` classifies as a known §4 boundary
 * AND none of the invalidators hold.
 */
"use strict";

// §4 event taxonomy — frozen map of canonical event types.
const EVENT_TYPES = Object.freeze({
  SUBAGENT_FINISHED: "subagent.finished",
  COMMIT_LANDED: "commit.landed",
  PHASE_TRANSITION: "phase.transition",
  CHECKPOINT_REACHED: "checkpoint.reached",
  INBOX_IDLE: "inbox.idle",
});

// Set of the canonical type strings for fast membership checks.
const KNOWN_TYPES = Object.freeze(
  new Set(Object.keys(EVENT_TYPES).map((k) => EVENT_TYPES[k]))
);

/**
 * Extract the event type string from a string or `{type}` object.
 * @param {string|{type:string}} event
 * @returns {string|null} the type string, or null if not extractable
 */
function eventType(event) {
  if (typeof event === "string") return event;
  if (event && typeof event === "object" && typeof event.type === "string") {
    return event.type;
  }
  return null;
}

/**
 * Classify an event against the §4 taxonomy.
 * @param {string|{type:string}} event
 * @returns {string} the matched canonical §4 event type
 * @throws {Error} if the event type is unknown/unparseable
 */
function classify(event) {
  const t = eventType(event);
  if (t === null) {
    throw new Error("cannot classify event: expected a string type or {type} object");
  }
  if (!KNOWN_TYPES.has(t)) {
    throw new Error("unknown safe-point event type: " + JSON.stringify(t));
  }
  return t;
}

/**
 * Non-throwing classification: returns the canonical type or null.
 * @param {string|{type:string}} event
 * @returns {string|null}
 */
function tryClassify(event) {
  const t = eventType(event);
  if (t === null || !KNOWN_TYPES.has(t)) return null;
  return t;
}

/**
 * §4 safe-point predicate. See header for ctx shape.
 * @param {object} ctx
 * @returns {boolean}
 */
function isSafePoint(ctx) {
  ctx = ctx || {};
  // Must be at a declared §4 boundary event.
  if (tryClassify(ctx.event) === null) return false;
  // §4 invalidators — compaction refused while ANY hold.
  if (ctx.tree_clean === false) return false;
  if (ctx.tool_in_flight === true) return false;
  if (ctx.subagent_running === true) return false;
  if (ctx.gate_green !== true) return false;
  return true;
}

module.exports = { EVENT_TYPES, KNOWN_TYPES, classify, tryClassify, isSafePoint };
