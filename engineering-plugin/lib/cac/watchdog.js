/*
 * watchdog.js — Checkpoint-Aware Compaction (CAC) resume watchdog.
 * Implements spec §5.3 "Watchdog" and the §10 guarantee "Loop dies silently
 * (fire-and-forget) → watchdog re-issues on stall". Test scenario S-CAC-5.
 *
 * A timer covers the SUSPENDED→RUNNING window. If RESUMING does not reach
 * RUNNING within `resume_deadline_s` (config §9, default 120 s), the watchdog
 * re-issues from the resume token — calling the injected re-issue callback with
 * the next task derived from token.next_action. Compaction can never leave the
 * loop parked.
 *
 * Scheduler is INJECTABLE so unit tests are deterministic (NO real timers):
 *   - ctx.setTimeout / ctx.clearTimeout (default: global setTimeout/clearTimeout)
 *   - the scheduled callback can be captured + invoked by the test to fire the
 *     deadline without any real waiting.
 *
 * Re-issue is INJECTABLE and fires AT MOST ONCE:
 *   - ctx.reissue(task) (preferred) or ctx.dispatch(task).
 *
 * API:
 *   const wd = createWatchdog(ctx);
 *   wd.arm();             // start the timer (idempotent: re-arm cancels prior)
 *   wd.reachedRunning();  // RUNNING reached in time → CANCEL (no re-issue)
 *   wd.expire();          // (for fake-clock tests) force the deadline callback
 *   wd.disarm();          // cancel without re-issuing
 *   wd.state;             // "idle" | "armed" | "reissued" | "cancelled"
 *
 * ctx shape:
 *   {
 *     token: object,                 // resume/1 token (RT.validate'd)
 *     resume_deadline_s?: number,    // override; else from config (cfg/env)
 *     config?: object,               // forwarded to config.load(overrides)
 *     env?: object,                  // forwarded to config.load(_, env)
 *     setTimeout?: Function,         // injectable scheduler (default global)
 *     clearTimeout?: Function,
 *     reissue?: Function,            // reissue(task) — preferred
 *     dispatch?: Function,           // dispatch(task) — alias
 *     onReissue?: Function,          // optional observer onReissue(task, info)
 *   }
 */
"use strict";

const RT = require("./resume_token.js");
const config = require("./config.js");
const postgate = require("./postgate.js");

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function reissuerOf(ctx) {
  if (typeof ctx.reissue === "function") return ctx.reissue;
  if (typeof ctx.dispatch === "function") return ctx.dispatch;
  return null;
}

function resolveDeadlineS(ctx) {
  if (ctx.resume_deadline_s !== undefined && ctx.resume_deadline_s !== null) {
    const n = Number(ctx.resume_deadline_s);
    if (!Number.isFinite(n) || !(n > 0)) {
      throw new Error("ctx.resume_deadline_s must be a number > 0");
    }
    return n;
  }
  const cfg = config.load(ctx.config, ctx.env);
  return cfg.resume_deadline_s;
}

/**
 * Create a resume watchdog. See header for ctx + API.
 * @param {object} ctx
 * @returns {{arm, reachedRunning, expire, disarm, state, deadline_ms}}
 */
function createWatchdog(ctx) {
  ctx = ctx || {};
  if (!isObj(ctx)) throw new Error("createWatchdog(ctx): ctx must be an object");
  if (ctx.token === undefined || ctx.token === null) {
    throw new Error("createWatchdog: ctx.token (resume/1) is required");
  }
  const token = RT.validate(ctx.token);

  const setT = typeof ctx.setTimeout === "function" ? ctx.setTimeout : setTimeout;
  const clearT = typeof ctx.clearTimeout === "function" ? ctx.clearTimeout : clearTimeout;
  const reissue = reissuerOf(ctx);
  const onReissue = typeof ctx.onReissue === "function" ? ctx.onReissue : null;

  const deadlineS = resolveDeadlineS(ctx);
  const deadlineMs = deadlineS * 1000;

  // Internal mutable state.
  let timer = null;
  let state = "idle"; // idle | armed | reissued | cancelled
  let fired = false; // guards the at-most-once re-issue

  function clearTimer() {
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
  }

  /**
   * Fire the deadline: re-issue from the token exactly once. Idempotent — a
   * second call (double timer, manual expire after auto-fire) is a no-op.
   */
  function fire() {
    if (fired) return null;
    // Only an armed watchdog can fire; a cancelled one never re-issues.
    if (state !== "armed") return null;
    fired = true;
    clearTimer();
    state = "reissued";
    const task = postgate.nextTaskFromToken(token);
    const info = { reason: "resume stalled past " + deadlineS + "s deadline", deadline_s: deadlineS };
    if (reissue) reissue(task);
    if (onReissue) onReissue(task, info);
    return task;
  }

  /**
   * Arm the watchdog: start the deadline timer. Re-arming cancels any prior
   * timer and resets the fired guard (a fresh SUSPENDED→RUNNING window).
   */
  function arm() {
    clearTimer();
    fired = false;
    state = "armed";
    timer = setT(fire, deadlineMs);
    return timer;
  }

  /**
   * Signal RUNNING was reached in time → cancel the watchdog. No re-issue.
   */
  function reachedRunning() {
    if (state === "reissued") return false; // already re-issued; too late
    clearTimer();
    fired = true; // prevent any late timer callback from re-issuing
    state = "cancelled";
    return true;
  }

  /**
   * Cancel the watchdog without re-issuing (e.g. abort the resume window).
   */
  function disarm() {
    clearTimer();
    fired = true;
    if (state !== "reissued") state = "cancelled";
    return true;
  }

  /**
   * Test/clock hook: force the deadline callback now (deterministic expiry).
   * Returns the re-issued task or null if it did not fire.
   */
  function expire() {
    return fire();
  }

  return {
    arm,
    reachedRunning,
    disarm,
    expire,
    deadline_ms: deadlineMs,
    deadline_s: deadlineS,
    get state() {
      return state;
    },
  };
}

module.exports = { createWatchdog };
