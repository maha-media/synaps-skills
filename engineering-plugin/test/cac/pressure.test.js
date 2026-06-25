/*
 * pressure.test.js — CAC §2 context-pressure hysteresis proofs for
 * lib/cac/pressure.js. Test scenario S-CAC-7: pressure oscillates around the
 * watermark → hysteresis prevents repeated compaction. Pure/hermetic.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createPressure } = require("../../lib/cac/pressure.js");

test("S-CAC-7: rises to >= high → armed exactly once (changed)", () => {
  const p = createPressure();
  assert.equal(p.armed, false);
  assert.deepEqual(p.update(0.50), { armed: false, changed: false });
  assert.deepEqual(p.update(0.84), { armed: false, changed: false }); // below high
  assert.deepEqual(p.update(0.85), { armed: true, changed: true }); // crosses high
});

test("S-CAC-7: oscillation 0.62↔0.84 after arming stays armed, NO further flips", () => {
  const p = createPressure();
  p.update(0.90); // arm (one flip)

  let flips = 0;
  // Oscillate inside the hysteresis band [low=0.60, high=0.85) many times.
  const wave = [0.62, 0.84, 0.62, 0.84, 0.70, 0.83, 0.61, 0.84, 0.62, 0.84];
  for (const u of wave) {
    const r = p.update(u);
    if (r.changed) flips++;
    assert.equal(r.armed, true, "stays armed across band oscillation at u=" + u);
  }
  assert.equal(flips, 0, "hysteresis band oscillation must NOT re-flip → no repeated compaction");
  assert.equal(p.armed, true);
});

test("S-CAC-7: exactly ONE arm during an oscillation window, not N", () => {
  const p = createPressure();
  let arms = 0;
  // A long noisy sequence that crosses high once, then jitters in the band.
  const samples = [0.55, 0.70, 0.88, 0.84, 0.62, 0.84, 0.61, 0.83, 0.84, 0.70];
  for (const u of samples) {
    const r = p.update(u);
    if (r.changed && r.armed) arms++;
  }
  assert.equal(arms, 1, "armed precisely once despite repeated band crossings");
});

test("S-CAC-7: drops <= low → disarmed; re-rises >= high → re-armed", () => {
  const p = createPressure();
  assert.deepEqual(p.update(0.86), { armed: true, changed: true }); // arm
  assert.deepEqual(p.update(0.61), { armed: true, changed: false }); // band, stay
  assert.deepEqual(p.update(0.60), { armed: false, changed: true }); // <= low → disarm
  assert.deepEqual(p.update(0.84), { armed: false, changed: false }); // band, stay disarmed
  assert.deepEqual(p.update(0.85), { armed: true, changed: true }); // re-arm
});

test("custom watermarks via config are honored", () => {
  const p = createPressure({ config: { high_watermark: 0.95, low_watermark: 0.40 } });
  assert.equal(p.high, 0.95);
  assert.equal(p.low, 0.40);
  assert.deepEqual(p.update(0.90), { armed: false, changed: false }); // below custom high
  assert.deepEqual(p.update(0.95), { armed: true, changed: true }); // hits custom high
  assert.deepEqual(p.update(0.50), { armed: true, changed: false }); // above custom low → stay armed
  assert.deepEqual(p.update(0.40), { armed: false, changed: true }); // <= custom low → disarm
});

test("custom watermarks via env (CAC_*) are honored", () => {
  const p = createPressure({ env: { CAC_HIGH_WATERMARK: "0.7", CAC_LOW_WATERMARK: "0.3" } });
  assert.equal(p.high, 0.7);
  assert.equal(p.low, 0.3);
  assert.deepEqual(p.update(0.70), { armed: true, changed: true });
  assert.deepEqual(p.update(0.30), { armed: false, changed: true });
});

test("reset() returns to disarmed", () => {
  const p = createPressure();
  p.update(0.9);
  assert.equal(p.armed, true);
  p.reset();
  assert.equal(p.armed, false);
});

test("non-finite utilization throws", () => {
  const p = createPressure();
  assert.throws(() => p.update("nope"), /finite number/);
  assert.throws(() => p.update(NaN), /finite number/);
});
