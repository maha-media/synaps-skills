/*
 * twins_diff.js — differential comparator (spec §4.6). Runs both twins on
 * generated inputs; on any input where outputs DISAGREE, at least one is wrong →
 * surface a divergence record to the Judge. Divergence records carry a probe id
 * + category + audit id only — NOT raw asserted oracle values. Bounded by an
 * input budget (spec §8). Orchestrator infra. Stdlib only.
 */
"use strict";
const crypto = require("node:crypto");
const { makeGen } = require("./gen.js");
const { createSut } = require("./sut.js");

// Contract-derived probes. Each: { id, category, gen(g)->input, async observe(sut,input)->string }
// `observe` returns a NORMALIZED, comparable token (no secrets); divergence is
// reported by probe id + category, never by raw token content.
const PROBES = [
  {
    id: "parse-engplan-safety", category: "validation-error",
    gen: (g) => g.anyValue(0),
    observe(sut, input) {
      try { sut.parsePlan(input); return "accepted"; }
      catch (e) { return e.name === "ValidationError" ? "rejected" : "crash"; }
    },
  },
  {
    id: "lifecycle-legality", category: "illegal-transition",
    gen: (g) => ({ from: g.pick(["open", "acknowledged", "blocked", "incorporated", "rejected", "deferred"]), to: g.pick(["acknowledged", "incorporated", "rejected", "deferred", "blocked", "open"]) }),
    observe(sut, input) { try { return sut.canTransition(input.from, input.to) ? "allow" : "deny"; } catch (_) { return "crash"; } },
  },
  {
    id: "unknown-plan-status", category: "not-found",
    gen: (g) => "missing-" + g.string(6).replace(/[^A-Za-z0-9]/g, "x"),
    async observe(sut, input) {
      const { request } = await sut.startServer({});
      const r = await request("GET", "/plan/" + encodeURIComponent(input || "x"));
      return String(r.status);
    },
  },
];

/**
 * Compare two twin artifacts across generated inputs for each probe.
 * @param {object} twinA { targetDir, lineage_id }
 * @param {object} twinB { targetDir, lineage_id }
 * Returns { divergences: [{probe, category, audit_id}], comparisons }
 */
async function differential(twinA, twinB, opts) {
  opts = opts || {};
  const inputBudget = Math.min(opts.inputBudget || 40, opts.maxInputs || 500); // bounded
  const seed = opts.seed || 0xD1FF;
  const probes = opts.probes || PROBES;
  const divergences = [];
  let comparisons = 0;
  for (const probe of probes) {
    for (let i = 0; i < inputBudget; i++) {
      const g = makeGen(seed + i);
      const input = probe.gen(g);
      const sa = createSut({ targetDir: twinA.targetDir });
      const sb = createSut({ targetDir: twinB.targetDir });
      let oa, ob;
      try { oa = await probe.observe(sa, input); } catch (_) { oa = "crash"; }
      try { ob = await probe.observe(sb, input); } catch (_) { ob = "crash"; }
      try { sa.cleanup(); } catch (_) {} try { sb.cleanup(); } catch (_) {}
      comparisons++;
      if (oa !== ob) {
        divergences.push({ probe: probe.id, category: probe.category, audit_id: "div_" + crypto.randomBytes(4).toString("hex") });
        break; // one divergence per probe is enough to flag for the Judge
      }
    }
  }
  return { divergences, comparisons };
}

module.exports = { differential, PROBES };
