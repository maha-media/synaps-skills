/*
 * paths.js — path canonicalization and confinement (spec §7.2, P4-SEC-3).
 * Rejects traversal, absolute surprises, and symlink escape. Serves only
 * within an allowed root.
 */
"use strict";
const fs = require("fs");
const path = require("path");

function isInside(root, p) {
  const r = path.resolve(root);
  const t = path.resolve(p);
  return t === r || t.startsWith(r + path.sep);
}

/**
 * Resolve `rel` against `root`, rejecting traversal/absolute escape.
 * Returns absolute path or throws.
 */
function safeResolve(root, rel) {
  if (typeof rel !== "string" || rel.length === 0) throw new Error("path required");
  // reject NUL and control chars
  if (/\0/.test(rel)) throw new Error("illegal path");
  // Normalize and join. Leading slash is treated as repo-relative, not absolute.
  const cleaned = rel.replace(/^[\\/]+/, "");
  const joined = path.resolve(root, cleaned);
  if (!isInside(root, joined)) throw new Error("path escapes root: " + rel);
  return joined;
}

/**
 * Like safeResolve but also rejects symlink escape by resolving realpath of
 * the deepest existing ancestor. Use for reads/writes that must stay inside.
 */
function safeRealpath(root, rel) {
  const abs = safeResolve(root, rel);
  // Walk up to the nearest existing ancestor and realpath it.
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch (_) { realRoot = path.resolve(root); }
  let realProbe;
  try { realProbe = fs.realpathSync(probe); } catch (_) { realProbe = probe; }
  if (!isInside(realRoot, realProbe)) throw new Error("symlink escapes root: " + rel);
  // also confirm full target maps inside real root
  const tail = path.relative(probe, abs);
  const realTarget = tail ? path.join(realProbe, tail) : realProbe;
  if (!isInside(realRoot, realTarget)) throw new Error("symlink escapes root: " + rel);
  return abs;
}

module.exports = { isInside, safeResolve, safeRealpath };
