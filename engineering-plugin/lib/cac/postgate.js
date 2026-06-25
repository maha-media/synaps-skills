/*
 * postgate.js — Checkpoint-Aware Compaction (CAC) post-compact hook.
 * Implements spec §5.2 "Continuity verification (post-compact)" and the §7
 * `post-compact` hook contract. Test scenarios S-CAC-3 / S-CAC-4.
 *
 * After RESUMING, before declaring RUNNING, postCompact(ctx) asserts continuity
 * (in order):
 *   1. git HEAD === token.head_commit (no work lost or silently added).
 *   2. working tree clean (or matches a recorded dirty intent — default clean).
 *   3. the rehydrated summary references active_phase, next_action AND the
 *      outstanding items — FAIL CLOSED if any absent.
 *   4. loop.continue === true → dispatch the next task (anti-fire-and-forget);
 *      loop.continue === false → halt and wait for a human (no dispatch).
 *
 * If ANY of 1–3 fail the loop does NOT proceed blindly: postCompact raises a
 * `continuity-violation` via the injected emitter (ctx.emit / ctx.raiseViolation)
 * — the ONLY sanctioned human re-entry point (§5.2) — and returns not-ok WITHOUT
 * dispatching the next task.
 *
 * PURE/DETERMINISTIC given injected deps. No real fs/git/clock side effects in
 * the unit path: the git HEAD check uses an injectable runner (ctx.git.run);
 * the violation emit + next-task dispatch are injected callbacks.
 *
 * ctx shape:
 *   {
 *     repoRoot: string,                  // for the git HEAD probe (injectable runner)
 *     git?: { run?: Function },          // injectable git runner ({run}(args,cwd)->{stdout,status})
 *     token: object,                     // resume/1 token (RT.validate'd here)
 *     summary?: object,                  // summary.buildSummary(...).object, OR
 *     summaryInput?: object,             //   inputs to build it via summary.buildSummary
 *     require_clean_tree?: boolean,      // default true (config §9)
 *     emit?: Function,                   // emit(note) — continuity-violation sink
 *     raiseViolation?: Function,         //   alias accepted for emit
 *     dispatch?: Function,               // dispatch(task) — next-task issuer
 *     reissue?: Function,                //   alias accepted for dispatch
 *   }
 *
 * result shape:
 *   {
 *     ok: boolean,                       // continuity verified (checks 1–3 passed)
 *     dispatched: boolean,               // next task auto-issued (ok && loop.continue)
 *     halted: boolean,                   // ok but loop.continue:false (await human)
 *     violation: object | null,          // the continuity-violation note when !ok
 *     reason: string,                    // human-readable summary
 *     task: object | null,               // the dispatched task (when dispatched)
 *     head_commit: string | null,        // observed git HEAD (when probed)
 *   }
 */
"use strict";

const RT = require("./resume_token.js");
const git = require("./git.js");
const summary = require("./summary.js");

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function emitterOf(ctx) {
  if (typeof ctx.emit === "function") return ctx.emit;
  if (typeof ctx.raiseViolation === "function") return ctx.raiseViolation;
  return null;
}

function dispatcherOf(ctx) {
  if (typeof ctx.dispatch === "function") return ctx.dispatch;
  if (typeof ctx.reissue === "function") return ctx.reissue;
  return null;
}

/**
 * Resolve the rehydrated summary object: prefer ctx.summary (already an object,
 * or a {object} wrapper from summary.buildSummary), else build it from
 * ctx.summaryInput via summary.buildSummary. Returns the summary object or null.
 */
function resolveSummary(ctx) {
  if (ctx.summary !== undefined && ctx.summary !== null) {
    // Accept either the bare object or the {object, markdown} wrapper.
    if (isObj(ctx.summary) && isObj(ctx.summary.object) &&
        ctx.summary.object.active_phase !== undefined) {
      return ctx.summary.object;
    }
    if (isObj(ctx.summary)) return ctx.summary;
    throw new Error("ctx.summary must be an object (summary object or {object})");
  }
  if (ctx.summaryInput !== undefined && ctx.summaryInput !== null) {
    return summary.buildSummary(ctx.summaryInput).object;
  }
  return null;
}

/**
 * Verify the rehydrated summary references active_phase, next_action AND the
 * outstanding items from the token (fail closed). Returns null when satisfied,
 * or a reason string describing the first missing reference.
 */
function summaryGapReason(summaryObj, token) {
  if (!isObj(summaryObj)) {
    return "rehydrated summary missing or not an object (cannot verify continuity)";
  }
  if (typeof summaryObj.active_phase !== "string" || summaryObj.active_phase.length === 0) {
    return "rehydrated summary missing active_phase";
  }
  if (summaryObj.active_phase !== token.active_phase) {
    return "rehydrated summary active_phase " + JSON.stringify(summaryObj.active_phase) +
      " does not match token active_phase " + JSON.stringify(token.active_phase);
  }
  if (typeof summaryObj.next_action !== "string" || summaryObj.next_action.length === 0) {
    return "rehydrated summary missing next_action";
  }
  // Outstanding items: every token-recorded outstanding item must be referenced.
  const have = isStringArray(summaryObj.outstanding) ? summaryObj.outstanding : null;
  if (have === null) {
    return "rehydrated summary missing outstanding items";
  }
  const haveSet = new Set(have);
  for (const item of token.outstanding) {
    if (!haveSet.has(item)) {
      return "rehydrated summary missing outstanding item: " + JSON.stringify(item);
    }
  }
  return null;
}

/**
 * Build the structured continuity-violation note (§5.2). The single sanctioned
 * human re-entry point.
 */
function violationNote(reason, token, extra) {
  return Object.assign(
    {
      kind: "continuity-violation",
      reason: reason,
      slug: token && typeof token.slug === "string" ? token.slug : null,
      active_phase: token && typeof token.active_phase === "string" ? token.active_phase : null,
      next_action: token && typeof token.next_action === "string" ? token.next_action : null,
    },
    extra || {}
  );
}

/**
 * Derive the next task object to dispatch from the resume token's next_action
 * (the anti-fire-and-forget step). Pure.
 */
function nextTaskFromToken(token) {
  return {
    kind: "next-task",
    slug: token.slug,
    branch: token.branch,
    worktree: token.worktree,
    active_phase: token.active_phase,
    last_checkpoint: token.last_checkpoint,
    action: token.next_action,
    outstanding: token.outstanding.slice(),
    loop: { kind: token.loop.kind, continue: token.loop.continue },
  };
}

/**
 * The post-compact continuity hook. See header for ctx + result shapes.
 * @param {object} ctx
 * @returns {object} result
 */
function postCompact(ctx) {
  ctx = ctx || {};
  if (!isObj(ctx)) throw new Error("postCompact(ctx): ctx must be an object");

  // Normalize/validate the resume token up front (also applies loop.continue
  // default). A structurally-invalid token is a hard programmer error, not a
  // continuity violation.
  if (ctx.token === undefined || ctx.token === null) {
    throw new Error("postCompact: ctx.token (resume/1) is required");
  }
  const token = RT.validate(ctx.token);

  const emit = emitterOf(ctx);
  const dispatch = dispatcherOf(ctx);

  function raise(reason, extra) {
    const note = violationNote(reason, token, extra);
    if (emit) emit(note);
    return {
      ok: false,
      dispatched: false,
      halted: false,
      violation: note,
      reason: reason,
      task: null,
      head_commit: extra && extra.head_commit !== undefined ? extra.head_commit : null,
    };
  }

  // ── Check 1: git HEAD === token.head_commit ────────────────────────────────
  let head = null;
  if (typeof ctx.repoRoot === "string" && ctx.repoRoot.length > 0) {
    head = git.headCommit(ctx.repoRoot, ctx.git);
  } else if (typeof ctx.head_commit === "string" && ctx.head_commit.length > 0) {
    // Convenience: caller may pass the observed HEAD directly (still hermetic).
    head = ctx.head_commit;
  } else {
    throw new Error("postCompact: ctx.repoRoot (for git HEAD probe) or ctx.head_commit required");
  }
  if (head !== token.head_commit) {
    return raise(
      "git HEAD " + JSON.stringify(head) + " !== resume token head_commit " +
        JSON.stringify(token.head_commit) + " (work lost or silently added since token write)",
      { head_commit: head, expected_head: token.head_commit }
    );
  }

  // ── Check 2: working tree clean (or recorded dirty intent) ──────────────────
  const requireClean = ctx.require_clean_tree === undefined ? true : ctx.require_clean_tree === true;
  // A recorded dirty intent lets a token explicitly opt out of the clean check.
  const dirtyIntent = isObj(ctx.token.dirty_intent) || ctx.dirty_intent === true ||
    (isObj(ctx.token) && ctx.token.dirty_intent === true);
  if (requireClean && !dirtyIntent) {
    let clean;
    if (typeof ctx.tree_clean === "boolean") {
      clean = ctx.tree_clean;
    } else if (typeof ctx.repoRoot === "string" && ctx.repoRoot.length > 0) {
      clean = git.treeClean(ctx.repoRoot, ctx.git);
    } else {
      throw new Error("postCompact: cannot determine tree cleanliness (ctx.tree_clean or ctx.repoRoot required)");
    }
    if (!clean) {
      return raise(
        "working tree is dirty at resume but no dirty intent recorded (fail closed)",
        { head_commit: head }
      );
    }
  }

  // ── Check 3: rehydrated summary references phase + next_action + outstanding ─
  let summaryObj;
  try {
    summaryObj = resolveSummary(ctx);
  } catch (e) {
    // buildSummary fails closed (e.g. missing next_action). That IS a continuity
    // violation, not a crash — surface it as such.
    return raise("rehydrated summary could not be built: " + e.message, { head_commit: head });
  }
  const gap = summaryGapReason(summaryObj, token);
  if (gap !== null) {
    return raise(gap, { head_commit: head });
  }

  // ── Check 4: loop.continue → dispatch the next task; else halt ──────────────
  if (token.loop.continue === true) {
    const task = nextTaskFromToken(token);
    if (dispatch) dispatch(task);
    return {
      ok: true,
      dispatched: true,
      halted: false,
      violation: null,
      reason: "continuity verified; loop.continue:true — next task auto-issued (" +
        token.next_action + ")",
      task: task,
      head_commit: head,
    };
  }

  // loop.continue:false → halt, wait for a human. No dispatch.
  return {
    ok: true,
    dispatched: false,
    halted: true,
    violation: null,
    reason: "continuity verified; loop.continue:false — halting, awaiting human re-entry",
    task: null,
    head_commit: head,
  };
}

module.exports = { postCompact, nextTaskFromToken };
