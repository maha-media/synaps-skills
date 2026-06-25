/*
 * config.test.js — tests for lib/cac/config.js (spec §9).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULTS, load } = require("../../lib/cac/config.js");

test("defaults present and correct (watermark hysteresis 0.85 / 0.60)", () => {
  const cfg = load(undefined, {});
  assert.equal(cfg.high_watermark, 0.85);
  assert.equal(cfg.low_watermark, 0.60);
  assert.equal(cfg.resume_deadline_s, 120);
  assert.equal(cfg.require_clean_tree, true);
  assert.equal(cfg.require_gate_green, true);
  assert.equal(cfg.summary_source, "artifacts-first");
});

test("DEFAULTS export matches §9", () => {
  assert.equal(DEFAULTS.high_watermark, 0.85);
  assert.equal(DEFAULTS.low_watermark, 0.60);
});

test("config object override wins over defaults", () => {
  const cfg = load({ high_watermark: 0.9, low_watermark: 0.5, summary_source: "transcript-first" }, {});
  assert.equal(cfg.high_watermark, 0.9);
  assert.equal(cfg.low_watermark, 0.5);
  assert.equal(cfg.summary_source, "transcript-first");
  // untouched keys keep defaults
  assert.equal(cfg.resume_deadline_s, 120);
});

test("CAC_* env override wins over config object; numeric + boolean parsing", () => {
  const cfg = load(
    { high_watermark: 0.9, low_watermark: 0.5, require_clean_tree: true },
    {
      CAC_HIGH_WATERMARK: "0.95",
      CAC_LOW_WATERMARK: "0.4",
      CAC_RESUME_DEADLINE_S: "60",
      CAC_REQUIRE_CLEAN_TREE: "false",
      CAC_REQUIRE_GATE_GREEN: "0",
      CAC_SUMMARY_SOURCE: "artifacts-only",
    }
  );
  assert.equal(cfg.high_watermark, 0.95);
  assert.equal(cfg.low_watermark, 0.4);
  assert.equal(cfg.resume_deadline_s, 60);
  assert.equal(cfg.require_clean_tree, false);
  assert.equal(cfg.require_gate_green, false);
  assert.equal(cfg.summary_source, "artifacts-only");
});

test("boolean env parsing accepts true/1", () => {
  const cfg = load({ require_clean_tree: false, require_gate_green: false }, {
    CAC_REQUIRE_CLEAN_TREE: "true",
    CAC_REQUIRE_GATE_GREEN: "1",
  });
  assert.equal(cfg.require_clean_tree, true);
  assert.equal(cfg.require_gate_green, true);
});

test("invalid: low >= high rejected (hysteresis)", () => {
  assert.throws(() => load({ low_watermark: 0.85, high_watermark: 0.85 }, {}), /hysteresis|must be </);
  assert.throws(() => load({ low_watermark: 0.9, high_watermark: 0.8 }, {}), /hysteresis|must be </);
});

test("invalid: watermark out of (0,1] rejected", () => {
  assert.throws(() => load({ high_watermark: 1.5 }, {}), /high_watermark must be in/);
  assert.throws(() => load({ low_watermark: 0 }, {}), /low_watermark must be in/);
  assert.throws(() => load({ low_watermark: -0.1 }, {}), /low_watermark must be in/);
});

test("invalid: resume_deadline_s <= 0 rejected", () => {
  assert.throws(() => load({ resume_deadline_s: 0 }, {}), /resume_deadline_s must be > 0/);
  assert.throws(() => load({ resume_deadline_s: -5 }, {}), /resume_deadline_s must be > 0/);
});

test("invalid env value rejected with clear error", () => {
  assert.throws(() => load({}, { CAC_HIGH_WATERMARK: "notanumber" }), /finite number/);
  assert.throws(() => load({}, { CAC_REQUIRE_CLEAN_TREE: "maybe" }), /boolean/);
});
