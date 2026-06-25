/*
 * pregate.js — Checkpoint-Aware Compaction (CAC) pre-compact wall.
 * Implements spec §7 "Hook contracts" → the `pre-compact` gate, and the §10
 * guarantee "Compact mid-write/tool-call → allow:false off a safe point —
 * physically blocked". Test scenario S-CAC-1.
 *
 * preCompact(ctx) -> { allow: boolean, reason: string }
 *   `allow` is true ONLY when at_safe_point && tree_clean && gate_green (§7).
 *   The safe-point determination uses safepoint.isSafePoint (§4), so a tool
 *   call in flight / subagent running / dirty tree / gate-not-green all force
 *   allow:false — making mid-operation compaction impossible.
 *
 * ctx shape (primary, pure flag form):
 *   {
 *     event: string | { type: string },  // the §4 boundary event
 *     tree_clean: boolean,
 *     gate_green: boolean,
 *     tool_in_flight?: boolean,
 *     subagent_running?: boolean,
 *   }
 *
 * Optional live probing (kept hermetic): if `ctx.tree_clean` is undefined and
 * `ctx.repoRoot` is provided, the working-tree cleanliness is probed via
 * lib/cac/git.js. The git runner is injectable through `ctx.git` (the same
 * `{run}` opts contract as git.js), so unit tests stay pure. The primary
 * contract is the ctx-flag form; live probing is a convenience.
 */
"use strict";

const safepoint = require("./safepoint.js");
const git = require("./git.js");

/**
 * Resolve tree_clean: prefer the explicit flag; optionally probe live.
 * @returns {{ value: boolean|undefined, note: string }}
 */
function resolveTreeClean(ctx) {
  if (typeof ctx.tree_clean === "boolean") {
    return { value: ctx.tree_clean, note: "" };
  }
  if (ctx.tree_clean === undefined && typeof ctx.repoRoot === "string" && ctx.repoRoot.length > 0) {
    const clean = git.treeClean(ctx.repoRoot, ctx.git);
    return { value: clean, note: " (probed via git)" };
  }
  return { value: ctx.tree_clean, note: "" };
}

/**
 * The pre-compact wall. See header for ctx shape and contract.
 * @param {object} ctx
 * @returns {{allow: boolean, reason: string}}
 */
function preCompact(ctx) {
  ctx = ctx || {};

  // Resolve tree cleanliness (explicit flag or optional live probe).
  const tc = resolveTreeClean(ctx);
  const treeClean = tc.value === true;

  // Build the context the safe-point predicate sees (with resolved tree state).
  const spCtx = {
    event: ctx.event,
    tree_clean: tc.value,
    tool_in_flight: ctx.tool_in_flight,
    subagent_running: ctx.subagent_running,
    gate_green: ctx.gate_green,
  };
  const atSafePoint = safepoint.isSafePoint(spCtx);
  const gateGreen = ctx.gate_green === true;

  // §7: allow ONLY when at_safe_point && tree_clean && gate_green.
  if (atSafePoint && treeClean && gateGreen) {
    return {
      allow: true,
      reason:
        "at safe point (" +
        String(safepoint.tryClassify(ctx.event)) +
        "), tree clean" +
        tc.note +
        ", gate green — compaction permitted",
    };
  }

  // Denied — explain the first/most specific blocking condition.
  const blockers = [];
  if (!treeClean) blockers.push("dirty tree (uncommitted work pending its commit)" + tc.note);
  if (ctx.tool_in_flight === true) blockers.push("tool call in flight");
  if (ctx.subagent_running === true) blockers.push("subagent still running");
  if (!gateGreen) blockers.push("checkpoint gate not asserted green");
  if (safepoint.tryClassify(ctx.event) === null) {
    blockers.push("not at a recognized §4 safe-point boundary");
  }
  if (blockers.length === 0) {
    // Defensive: should not happen, but never allow without the full triad.
    blockers.push("not at safe point");
  }

  return {
    allow: false,
    reason: "compaction blocked: " + blockers.join("; "),
  };
}

module.exports = { preCompact };
