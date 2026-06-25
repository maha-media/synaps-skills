/*
 * suite_runner.js — runs a directory of grading-suite files against a SUT and
 * produces an oracle/1 verdict (counts + failure categories only). Suite files
 * are authored by the DESIGNER lineage and export:
 *     module.exports = { id, label, category, async run(sut, t) }
 * where `t` is a recorder:  t.check(cond, category, msg)  /  t.fail(category,msg)
 * The runner converts results to a verdict; suite source / asserted values never
 * leave this process except as category codes. Orchestrator infra. Stdlib only.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createSut } = require("./sut.js");
const { makeVerdict } = require("./verdict.js");

function makeRecorder() {
  const fails = [];
  let checks = 0;
  return {
    _fails: fails,
    get checks() { return checks; },
    check(cond, category, _msg) { checks++; if (!cond) fails.push(category || "missing-behavior"); return !!cond; },
    fail(category, _msg) { checks++; fails.push(category || "missing-behavior"); },
  };
}

function loadSuites(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".suite.js"))
    .sort()
    .map((f) => {
      const full = path.join(dir, f);
      delete require.cache[require.resolve(full)];
      const s = require(full);
      s._file = f;
      return s;
    });
}

/**
 * Run all suites in `dir` against a SUT bound to `targetDir`.
 * Returns { verdict, raw } where raw has detail for in-process callers only.
 */
async function runSuites(dir, opts) {
  opts = opts || {};
  const suites = loadSuites(dir);
  const sutFactory = opts.sutFactory || ((targetDir) => createSut({ targetDir }));
  let pass = 0, fail = 0;
  const catCounts = {};
  const perSuite = [];
  for (const s of suites) {
    const sut = sutFactory(opts.targetDir);
    const t = makeRecorder();
    let crashed = null;
    try {
      await s.run(sut, t);
    } catch (e) {
      crashed = e && e.category ? e.category : "crash";
    } finally {
      try { sut.cleanup(); } catch (_) {}
    }
    const suiteFails = t._fails.slice();
    if (crashed) suiteFails.push(crashed);
    if (suiteFails.length === 0) { pass++; }
    else { fail++; for (const c of suiteFails) catCounts[c] = (catCounts[c] || 0) + 1; }
    perSuite.push({ id: s.id || s._file, ok: suiteFails.length === 0, categories: suiteFails });
  }
  const categories = Object.keys(catCounts).map((c) => ({ category: c, count: catCounts[c] }));
  const verdict = makeVerdict({
    round: opts.round || 0, pass, fail, categories,
    audit_id: opts.audit_id, nonce: opts.nonce, lineage: opts.lineage, ts: opts.ts,
  });
  return { verdict, raw: { perSuite } };
}

module.exports = { runSuites, loadSuites, makeRecorder };
