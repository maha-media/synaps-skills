/*
 * mutate.js — mutation operators tied to the contract (spec §4.4, §9 #2,
 * Assumption 7). Custom, dependency-free operator set. A mutant is a COPY of the
 * build with one deliberate, contract-relevant fault injected. The grading suite
 * must KILL it; survivors indict the suite (mutation gate, O2-4).
 *
 * Operators are PATTERN-based + contract-anchored (status codes, exit codes,
 * comparisons, guards) so they need no knowledge of specific source lines — they
 * are derived from the frozen contract, not from reading product internals.
 * Orchestrator infra. Stdlib only.
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BUILD_ROOT = path.join(__dirname, "..", "..");

// Contract-tied operator catalog. Each operator: where it may apply + the edit.
// `find` is a literal substring; `replace` the faulted form; applied to the
// first matching occurrence in `file`.
const OPERATORS = [
  { id: "status-404-to-200", category: "not-found", file: "extensions/plans_server.js", find: 'send(res, 404, "plan not found")', replace: 'send(res, 200, "plan not found")', label: "unknown plan returns 200 instead of 404" },
  { id: "status-400-to-200-badid", category: "bad-request", file: "extensions/plans_server.js", find: 'send(res, 400, "bad id")', replace: 'send(res, 200, "bad id")', label: "bad plan id returns 200 instead of 400" },
  { id: "sse-cap-disable", category: "too-many-streams", file: "extensions/plans_server.js", find: "if (pool.size >= limits.maxSseConnections) { return send(res, 503", replace: "if (false) { return send(res, 503", label: "SSE connection cap disabled (never 503)" },
  { id: "exit-code-2-to-0", category: "bad-request", file: "bin/plan.js", find: 'console.error("usage: plan new <kind> <slug> [title]"); process.exit(2)', replace: 'console.error("usage: plan new <kind> <slug> [title]"); process.exit(0)', label: "usage error exits 0 instead of 2" },
  { id: "transition-allow-illegal", category: "illegal-transition", file: "assets/engplan.js", find: "incorporated: [],", replace: "incorporated: [\"acknowledged\"],", label: "terminal status gains an illegal outgoing transition" },
  { id: "event-cap-off", category: "cap-exceeded", file: "lib/store.js", find: "if (arr.length >= limits.maxEventsPerPlan) throw new Error(\"event cap exceeded\")", replace: "if (false) throw new Error(\"event cap exceeded\")", label: "event cap guard dropped" },
  { id: "schema-check-drop", category: "schema-mismatch", file: "assets/engplan.js", find: 'if (raw.schema !== SCHEMA) throw ValidationError("unsupported schema: " + JSON.stringify(raw.schema) + " (want " + SCHEMA + ")");', replace: "if (false) throw ValidationError(\"x\");", label: "engplan schema validation dropped" },
  { id: "bind-any-interface", category: "loopback-violation", file: "extensions/plans_server.js", find: 'server.listen(opts.port || 0, "127.0.0.1"', replace: 'server.listen(opts.port || 0, "0.0.0.0"', label: "server binds 0.0.0.0 instead of loopback" },
  // EQUIVALENT MUTANT (proven): `target` = safeRealpath(plansDir, filename), and
  // safeRealpath (lib/paths.js) returns ONLY a safeResolve'd path that is provably
  // inside the root, else it THROWS ("symlink escapes root" / "path escapes root")
  // before returning. Therefore `isInside(plansDir, target)` at this line is a
  // tautology (always true) and the guard is unreachable-false — dropping it has
  // NO observable behavior. A symlink/traversal escape is rejected upstream inside
  // safeRealpath, and every escaping slug is rejected earlier still by slugOk
  // (validId rejects '/'/'\\') + the writable-filename regex. No behavioral grading
  // suite can kill this mutant; excluding it from the kill-rate denominator is the
  // correct mutation-testing treatment (it indicts nothing about the suite).
  { id: "write-confine-drop", category: "write-confinement-violation", file: "lib/store.js", find: 'if (!isInside(plansDir, target)) throw new Error("write escapes .plans/");', replace: "if (false) throw new Error(\"x\");", label: "write-confinement guard dropped", equivalent: true, equivalent_reason: "isInside(plansDir, safeRealpath(...)) is a tautology; safeRealpath returns inside-root or throws, so the guard is unreachable-false — unkillable, not a suite weakness" },
  { id: "actor-validation-drop", category: "validation-error", file: "assets/engplan.js", find: 'if (!actor) throw ValidationError("event.actor invalid: " + raw.actor);', replace: "if (false) throw ValidationError(\"x\");", label: "event.actor validation dropped" },
];

function copyDir(src, dst, skip) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip && skip.includes(ent.name)) continue;
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d, skip);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

/** Which operators actually apply to the current build (find string present). */
function viableOperators(buildRoot) {
  buildRoot = buildRoot || BUILD_ROOT;
  return OPERATORS.filter((op) => {
    try { return fs.readFileSync(path.join(buildRoot, op.file), "utf8").includes(op.find); }
    catch (_) { return false; }
  });
}

/**
 * Materialize a mutant build dir for one operator. Returns { dir, applied, op }.
 * Caller must clean up `dir`.
 */
function makeMutant(op, opts) {
  opts = opts || {};
  const buildRoot = opts.buildRoot || BUILD_ROOT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-mutant-"));
  // copy only the directories that matter for grading (keep it light + offline)
  for (const sub of ["assets", "lib", "extensions", "bin"]) {
    const src = path.join(buildRoot, sub);
    if (fs.existsSync(src)) copyDir(src, path.join(dir, sub), ["node_modules"]);
  }
  // copy package.json for module resolution
  try { fs.copyFileSync(path.join(buildRoot, "package.json"), path.join(dir, "package.json")); } catch (_) {}
  const target = path.join(dir, op.file);
  let applied = false;
  try {
    const txt = fs.readFileSync(target, "utf8");
    if (txt.includes(op.find)) { fs.writeFileSync(target, txt.replace(op.find, op.replace)); applied = true; }
  } catch (_) {}
  return { dir, applied, op };
}

module.exports = { OPERATORS, viableOperators, makeMutant, copyDir, BUILD_ROOT };
