/*
 * diff_gate.js — CENTRAL CONTROL (spec §3 rule 2, §6, §8).
 * Rejects any Builder-lineage diff that touches a protected oracle/test path.
 * The wall is enforced at the orchestrator/merge boundary (a diff gate), not a
 * kernel ACL — matching the threat model (an agent optimizing for "tests pass").
 * Path canonicalization defeats rename/symlink/traversal smuggling. Stdlib only.
 */
"use strict";
const path = require("path");

// Paths only the Designer/Architect lineages may author/modify.
const PROTECTED_PREFIXES = [
  ".oracle/",            // all grading content + contract + reveal + verdicts
  "tools/oracle/",       // oracle machinery
  "test/oracle-harness/",// oracle self-tests / scenario runner
];
// Architect may additionally only touch the contract subtree.
const ARCHITECT_ALLOWED = [".oracle/contract/"];

function err(category, message, extra) {
  const e = new Error(message);
  e.category = category;
  if (extra) Object.assign(e, extra);
  return e;
}

/**
 * Canonicalize a repo-relative path: collapse ./ and ../, normalize separators,
 * strip leading slashes, resolve to a repo-rooted posix path. Rejects escape.
 */
function canonicalRel(p) {
  if (typeof p !== "string" || p.length === 0) throw err("bad-request", "path required");
  if (/\0/.test(p)) throw err("path-escape", "illegal NUL in path");
  // normalize windows separators, strip leading slashes
  let s = p.replace(/\\/g, "/").replace(/^\/+/, "");
  // posix-normalize the relative path; leading .. means escape above repo root
  const resolved = path.posix.normalize(s);
  if (resolved === ".." || resolved.startsWith("../")) throw err("path-escape", "path escapes repo root: " + p);
  return resolved.replace(/^\.\//, "");
}

function isProtected(rel) {
  return PROTECTED_PREFIXES.some((pre) => rel === pre.replace(/\/$/, "") || rel.startsWith(pre));
}

function isContractPath(rel) {
  return ARCHITECT_ALLOWED.some((pre) => rel.startsWith(pre));
}

/**
 * Evaluate a diff for a given authoring role.
 * @param {object} diff - { paths: string[], renames?: [{from,to}], symlinks?: [{path,target}] }
 * @param {string} role - authoring lineage role
 * @returns {{accepted:boolean, reason?:string, category?:string, offending?:string[]}}
 */
function evaluateDiff(diff, role) {
  if (!diff || !Array.isArray(diff.paths)) throw err("bad-request", "diff.paths[] required");
  // Gather every effective touched path, including rename sources/targets and symlink targets.
  const touched = new Set();
  for (const p of diff.paths) touched.add(canonicalRel(p));
  for (const r of diff.renames || []) { touched.add(canonicalRel(r.from)); touched.add(canonicalRel(r.to)); }
  for (const s of diff.symlinks || []) {
    touched.add(canonicalRel(s.path));
    // a symlink whose target lands in a protected tree is also smuggling
    try { touched.add(canonicalRel(s.target)); } catch (_) { /* absolute/external targets handled below */
      if (typeof s.target === "string" && PROTECTED_PREFIXES.some((pre) => s.target.replace(/\\/g, "/").includes(pre))) {
        touched.add(s.target.replace(/\\/g, "/").replace(/^\/+/, ""));
      }
    }
  }

  const offending = [...touched].filter(isProtected);

  if (role === "builder") {
    if (offending.length > 0) {
      return { accepted: false, category: "write-segregation", reason: "Builder lineage may not author/edit oracle/test paths (green-by-vandalism prevented)", offending };
    }
    return { accepted: true };
  }
  if (role === "architect") {
    // Architect may only touch the contract subtree of the protected zone.
    const bad = offending.filter((p) => !isContractPath(p));
    if (bad.length > 0) {
      return { accepted: false, category: "write-segregation", reason: "Architect lineage may only modify .oracle/contract/**", offending: bad };
    }
    return { accepted: true };
  }
  if (role === "designer" || role === "orchestrator") {
    // Designer/Orchestrator own the oracle machinery + grading content.
    return { accepted: true };
  }
  // Unknown role: refuse touching protected paths.
  if (offending.length > 0) {
    return { accepted: false, category: "write-segregation", reason: "unknown role may not modify protected paths: " + role, offending };
  }
  return { accepted: true };
}

module.exports = { evaluateDiff, canonicalRel, isProtected, PROTECTED_PREFIXES };
