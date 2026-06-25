/*
 * gen.js — vendored tiny seeded generator + shrinker (spec §4.3, Assumption 8).
 * Dependency-free, deterministic by seed. Designer authors invariants; this
 * engine fires thousands of randomized cases the Builder cannot enumerate.
 * Node stdlib only.
 */
"use strict";

const version = "1.0.0";

/** Mulberry32 — small deterministic PRNG. */
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGen(seed) {
  const r = prng(seed == null ? 0x1234 : seed);
  const g = {
    rng: r,
    int(min, max) { return Math.floor(r() * (max - min + 1)) + min; },
    bool() { return r() < 0.5; },
    pick(arr) { return arr[Math.floor(r() * arr.length)]; },
    string(maxLen) {
      const len = g.int(0, maxLen == null ? 12 : maxLen);
      const alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.- /\\\0\n\t\"'<>{}";
      let s = "";
      for (let i = 0; i < len; i++) s += alpha[Math.floor(r() * alpha.length)];
      return s;
    },
    // a value of an arbitrary JSON-ish type (for malformed-input fuzzing)
    anyValue(depth) {
      depth = depth || 0;
      const kind = g.int(0, depth > 2 ? 4 : 6);
      switch (kind) {
        case 0: return null;
        case 1: return g.bool();
        case 2: return g.int(-1e6, 1e6);
        case 3: return g.string(20);
        case 4: return undefined;
        case 5: { const n = g.int(0, 3); const a = []; for (let i = 0; i < n; i++) a.push(g.anyValue(depth + 1)); return a; }
        default: { const n = g.int(0, 3); const o = {}; for (let i = 0; i < n; i++) o[g.string(6)] = g.anyValue(depth + 1); return o; }
      }
    },
  };
  return g;
}

/**
 * Shrink a failing input toward a minimal counterexample.
 * @param {*} input failing input
 * @param {(x)=>boolean} stillFails returns true if x still triggers the failure
 */
function shrink(input, stillFails, opts) {
  opts = opts || {};
  const maxSteps = opts.maxSteps || 200;
  let best = input, steps = 0;
  function candidates(x) {
    const out = [];
    if (typeof x === "number" && x !== 0) { out.push(0); out.push(Math.trunc(x / 2)); if (x > 0) out.push(x - 1); else out.push(x + 1); }
    if (typeof x === "string" && x.length > 0) { out.push(""); out.push(x.slice(0, Math.floor(x.length / 2))); out.push(x.slice(1)); }
    if (Array.isArray(x) && x.length > 0) { out.push([]); out.push(x.slice(0, Math.floor(x.length / 2))); out.push(x.slice(1)); }
    if (x && typeof x === "object" && !Array.isArray(x)) {
      const keys = Object.keys(x);
      if (keys.length > 0) { const c = Object.assign({}, x); delete c[keys[0]]; out.push(c); }
    }
    return out;
  }
  let improved = true;
  while (improved && steps < maxSteps) {
    improved = false;
    for (const c of candidates(best)) {
      steps++;
      if (steps > maxSteps) break;
      try { if (stillFails(c)) { best = c; improved = true; break; } } catch (_) { /* ignore */ }
    }
  }
  return best;
}

module.exports = { version, prng, makeGen, shrink };
