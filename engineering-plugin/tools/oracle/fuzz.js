/*
 * fuzz.js — adversarial fuzz harness (spec §4.7 input source, §2.5). Feeds
 * bounded malformed/extreme inputs to a contract entry point; asserts a safe
 * categorized error, never a crash. A crash is captured + minimized and (in O5)
 * becomes a new property. Resource-bounded. Orchestrator infra. Stdlib only.
 */
"use strict";
const { makeGen, shrink } = require("./gen.js");

/**
 * Fuzz a single target function with generated inputs.
 * @param {(input)=>void} target throws on rejection (expected), must NOT crash-as-in-hang
 * @param {(g)=>*} genInput input generator
 * @param {object} opts { runs, seed, isCrash(err)->bool }
 * A "crash" = an error the target should have handled safely. By default any
 * thrown value whose .name !== 'ValidationError' and lacking a .category is a crash.
 */
function fuzzTarget(target, genInput, opts) {
  opts = opts || {};
  const runs = Math.min(opts.runs || 500, opts.maxRuns || 5000); // bound (spec §8)
  const seed = opts.seed || 0xF0F0;
  const isCrash = opts.isCrash || ((err) => {
    if (!err) return false;
    if (err.name === "ValidationError") return false;     // safe, expected rejection
    if (err.category) return false;                        // categorized = handled
    return true;                                            // anything else = crash
  });
  for (let i = 0; i < runs; i++) {
    const g = makeGen(seed + i);
    let input;
    try { input = genInput(g); } catch (_) { continue; }
    try {
      target(input);
    } catch (err) {
      if (isCrash(err)) {
        const stillCrashes = (x) => { try { target(x); return false; } catch (e) { return isCrash(e); } };
        const minimal = shrink(input, stillCrashes, { maxSteps: opts.maxShrink || 150 });
        let size = -1; try { size = JSON.stringify(minimal).length; } catch (_) {}
        return { ok: false, crashed: true, run: i + 1, category: "crash", counterexampleSize: size };
      }
    }
  }
  return { ok: true, crashed: false, runs };
}

module.exports = { fuzzTarget };
