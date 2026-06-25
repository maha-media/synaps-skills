/*
 * pressure.js — Checkpoint-Aware Compaction (CAC) context-pressure hysteresis.
 * Implements spec §2 "Core principle" → the `context_pressure` signal with a
 * high/low watermark hysteresis band, and the §10 guarantee "Compaction thrash
 * → high/low watermark hysteresis". Test scenario S-CAC-7.
 *
 * §2: context_pressure arms compaction when utilization rises to/above the high
 * watermark (default θ:high ≥ 0.85). Once ARMED it STAYS armed until utilization
 * falls to/below the low watermark (default ≤ 0.60). The band between low and
 * high is the hysteresis zone: while armed, oscillation inside the band does NOT
 * re-flip the state — so compaction can never be triggered repeatedly by a value
 * jittering around a single threshold.
 *
 * PURE/DETERMINISTIC: no fs / process / network / clock. Same call sequence →
 * same result. Watermarks resolve through config.load (§9 defaults + overrides
 * + CAC_* env), so a single source of truth governs the band.
 *
 * API:
 *   const p = createPressure(opts);
 *     opts: { config?, env?, high_watermark?, low_watermark? }
 *   p.update(utilization) -> { armed: boolean, changed: boolean }
 *       changed === true ONLY when the armed state actually flips this call.
 *   p.armed            // current armed boolean (getter)
 *   p.high, p.low      // resolved watermarks (getters)
 *   p.reset()          // back to disarmed
 *
 * Semantics (the hysteresis state machine):
 *   disarmed: util >= high            → ARM   (changed)
 *   disarmed: util <  high            → stay disarmed
 *   armed:    util <= low             → DISARM (changed)
 *   armed:    low < util              → stay armed (NOT changed) ← thrash guard
 */
"use strict";

const config = require("./config.js");

function resolveWatermarks(opts) {
  opts = opts || {};
  // Per-instance overrides take precedence over config block; both flow through
  // config.load so the (0,1] + low<high invariants are validated once (§2/§9).
  const overrides = Object.assign({}, opts.config || {});
  if (opts.high_watermark !== undefined) overrides.high_watermark = opts.high_watermark;
  if (opts.low_watermark !== undefined) overrides.low_watermark = opts.low_watermark;
  const cfg = config.load(overrides, opts.env);
  return { high: cfg.high_watermark, low: cfg.low_watermark };
}

/**
 * Create a stateful context-pressure arming tracker. See header for API.
 * @param {object} [opts]
 * @returns {{update, reset, armed, high, low}}
 */
function createPressure(opts) {
  const { high, low } = resolveWatermarks(opts);

  let armed = false;

  /**
   * Feed a utilization sample (0..1-ish). Returns the post-update armed state
   * and whether it flipped on THIS call.
   * @param {number} utilization
   * @returns {{armed: boolean, changed: boolean}}
   */
  function update(utilization) {
    const u = Number(utilization);
    if (!Number.isFinite(u)) {
      throw new Error("pressure.update: utilization must be a finite number, got " + JSON.stringify(utilization));
    }
    let changed = false;
    if (!armed) {
      // Disarmed → arm only when crossing the HIGH watermark.
      if (u >= high) {
        armed = true;
        changed = true;
      }
    } else {
      // Armed → disarm only when falling to/below the LOW watermark. Anything
      // above low (incl. the whole hysteresis band) keeps it armed: no thrash.
      if (u <= low) {
        armed = false;
        changed = true;
      }
    }
    return { armed: armed, changed: changed };
  }

  function reset() {
    armed = false;
  }

  return {
    update,
    reset,
    get armed() {
      return armed;
    },
    get high() {
      return high;
    },
    get low() {
      return low;
    },
  };
}

module.exports = { createPressure };
