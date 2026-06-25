/*
 * properties.js — property/generative engine (spec §4.3). A property is an
 * invariant authored by the DESIGNER lineage:
 *     module.exports = { id, label, category, gen(g)->input, holds(sut, input)->bool }
 * The engine fires N seeded cases; on the first failure it shrinks to a minimal
 * counterexample. Counterexample VALUES never cross the sandbox boundary — only
 * the category + a minimal-size signal. Orchestrator infra. Stdlib only.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { makeGen, shrink } = require("./gen.js");
const { createSut } = require("./sut.js");

function loadProperties(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".prop.js"))
    .sort()
    .map((f) => { const full = path.join(dir, f); delete require.cache[require.resolve(full)]; const p = require(full); p._file = f; return p; });
}

/**
 * Check one property against a SUT over N generated cases.
 * Returns { ok, category, cases, counterexampleSize? } — never the raw value.
 */
function checkProperty(prop, sutFactory, opts) {
  opts = opts || {};
  const N = opts.cases || 1000;
  const seed = opts.seed || 0xC0FFEE;
  for (let i = 0; i < N; i++) {
    const g = makeGen(seed + i);
    let input;
    try { input = prop.gen(g); } catch (_) { continue; }
    const sut = sutFactory(opts.targetDir);
    let failed = false;
    try { failed = !prop.holds(sut, input); }
    catch (e) { failed = true; }
    finally { try { sut.cleanup && sut.cleanup(); } catch (_) {} }
    if (failed) {
      // shrink — re-evaluate with fresh SUTs
      const stillFails = (x) => {
        const s = sutFactory(opts.targetDir);
        try { return !prop.holds(s, x); } catch (_) { return true; } finally { try { s.cleanup && s.cleanup(); } catch (_) {} }
      };
      const minimal = shrink(input, stillFails, { maxSteps: opts.maxShrink || 200 });
      const size = (() => { try { return JSON.stringify(minimal).length; } catch (_) { return -1; } })();
      return { ok: false, id: prop.id, category: prop.category || "property-violation", cases: i + 1, counterexampleSize: size };
    }
  }
  return { ok: true, id: prop.id, category: prop.category || "property-violation", cases: N };
}

function checkAll(dir, opts) {
  opts = opts || {};
  const props = loadProperties(dir);
  const sutFactory = opts.sutFactory || ((targetDir) => createSut({ targetDir }));
  const results = props.map((p) => checkProperty(p, sutFactory, opts));
  return { results, failed: results.filter((r) => !r.ok), passed: results.filter((r) => r.ok) };
}

module.exports = { loadProperties, checkProperty, checkAll };
