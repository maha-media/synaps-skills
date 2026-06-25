/*
 * config.js — Checkpoint-Aware Compaction (CAC) configuration loader.
 * Implements spec §9 "Configuration": the `cac` config block with documented
 * defaults, merged with an optional config object and CAC_* environment
 * overrides. PURE merge/validate (env is injected; defaults to process.env).
 *
 * Merge precedence (lowest → highest):
 *   DEFAULTS  <  overrides (config object)  <  CAC_* env vars
 *
 * Env mapping:
 *   CAC_HIGH_WATERMARK     → high_watermark      (number, (0,1])
 *   CAC_LOW_WATERMARK      → low_watermark       (number, (0,1])
 *   CAC_RESUME_DEADLINE_S  → resume_deadline_s   (number, > 0)
 *   CAC_REQUIRE_CLEAN_TREE → require_clean_tree  (boolean: true/false/1/0)
 *   CAC_REQUIRE_GATE_GREEN → require_gate_green  (boolean: true/false/1/0)
 *   CAC_SUMMARY_SOURCE     → summary_source      (string)
 *
 * Invariants (validated, §2 hysteresis):
 *   0 < low_watermark <= 1, 0 < high_watermark <= 1, low_watermark < high_watermark,
 *   resume_deadline_s > 0.
 */
"use strict";

// §9 documented defaults.
const DEFAULTS = Object.freeze({
  high_watermark: 0.85, // arm compaction
  low_watermark: 0.60, // re-arm hysteresis
  resume_deadline_s: 120, // watchdog
  require_clean_tree: true,
  require_gate_green: true,
  summary_source: "artifacts-first",
});

// env var name → { key, type }.
const ENV_MAP = {
  CAC_HIGH_WATERMARK: { key: "high_watermark", type: "number" },
  CAC_LOW_WATERMARK: { key: "low_watermark", type: "number" },
  CAC_RESUME_DEADLINE_S: { key: "resume_deadline_s", type: "number" },
  CAC_REQUIRE_CLEAN_TREE: { key: "require_clean_tree", type: "boolean" },
  CAC_REQUIRE_GATE_GREEN: { key: "require_gate_green", type: "boolean" },
  CAC_SUMMARY_SOURCE: { key: "summary_source", type: "string" },
};

function parseBool(raw, name) {
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error(name + " must be a boolean (true/false/1/0), got " + JSON.stringify(raw));
}

function parseNum(raw, name) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(name + " must be a finite number, got " + JSON.stringify(raw));
  return n;
}

/**
 * Load and validate the effective CAC config.
 * @param {object} [overrides] config object overriding defaults.
 * @param {object} [env] environment object (defaults to process.env).
 * @returns {object} validated config.
 */
function load(overrides, env) {
  env = env || process.env;
  const cfg = Object.assign({}, DEFAULTS);

  // Layer 2: config object overrides.
  if (overrides !== undefined && overrides !== null) {
    if (typeof overrides !== "object" || Array.isArray(overrides)) {
      throw new Error("cac config overrides must be an object");
    }
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key] !== undefined) {
        cfg[key] = overrides[key];
      }
    }
  }

  // Layer 3: CAC_* env overrides (highest precedence).
  for (const envName of Object.keys(ENV_MAP)) {
    const raw = env[envName];
    if (raw === undefined || raw === null || raw === "") continue;
    const { key, type } = ENV_MAP[envName];
    if (type === "number") cfg[key] = parseNum(raw, envName);
    else if (type === "boolean") cfg[key] = parseBool(raw, envName);
    else cfg[key] = String(raw);
  }

  validate(cfg);
  return cfg;
}

function validate(cfg) {
  for (const k of ["high_watermark", "low_watermark", "resume_deadline_s"]) {
    if (typeof cfg[k] !== "number" || !Number.isFinite(cfg[k])) {
      throw new Error(k + " must be a finite number");
    }
  }
  for (const k of ["require_clean_tree", "require_gate_green"]) {
    if (typeof cfg[k] !== "boolean") throw new Error(k + " must be a boolean");
  }
  if (typeof cfg.summary_source !== "string" || cfg.summary_source.length === 0) {
    throw new Error("summary_source must be a non-empty string");
  }
  if (!(cfg.high_watermark > 0 && cfg.high_watermark <= 1)) {
    throw new Error("high_watermark must be in (0,1], got " + cfg.high_watermark);
  }
  if (!(cfg.low_watermark > 0 && cfg.low_watermark <= 1)) {
    throw new Error("low_watermark must be in (0,1], got " + cfg.low_watermark);
  }
  if (!(cfg.low_watermark < cfg.high_watermark)) {
    throw new Error(
      "low_watermark (" + cfg.low_watermark + ") must be < high_watermark (" + cfg.high_watermark + ") for hysteresis"
    );
  }
  if (!(cfg.resume_deadline_s > 0)) {
    throw new Error("resume_deadline_s must be > 0, got " + cfg.resume_deadline_s);
  }
  return cfg;
}

module.exports = { DEFAULTS, load, validate };
