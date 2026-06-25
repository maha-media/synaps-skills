/*
 * resume_token.js — Checkpoint-Aware Compaction (CAC) resume token I/O.
 * Implements spec §5.1 "Resume token" (schema "resume/1") read/write of
 * .plans/<slug>.resume.json. Atomic write (temp + rename), mirrors the
 * atomic-write style of lib/store.js. The token is persisted BEFORE the
 * SUSPENDED transition so it survives compaction and a crash.
 *
 * Schema (resume/1):
 *   schema:"resume/1", slug, branch, worktree, active_phase, last_checkpoint,
 *   next_action (REQUIRED), head_commit, outstanding[], pending_subagents[],
 *   loop:{kind, continue}, issued_at.
 *   loop.continue DEFAULTS to true (anti-fire-and-forget flag, §5.1).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SCHEMA = "resume/1";
// engplan id regex (assets/engplan.js): max 200 chars.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function validSlug(slug) {
  return typeof slug === "string" && slug.length > 0 && slug.length <= 200 && ID_RE.test(slug);
}

function plansDirOf(repoRoot) {
  return path.join(repoRoot, ".plans");
}

function tokenFile(slug) {
  return slug + ".resume.json";
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validate and normalize a resume token. Returns a normalized copy (loop.continue
 * defaulted to true when absent). Throws Error on any schema violation.
 */
function validate(token) {
  if (token === null || typeof token !== "object" || Array.isArray(token)) {
    throw new Error("resume token must be an object");
  }
  if (token.schema !== SCHEMA) {
    throw new Error("resume token schema must be " + JSON.stringify(SCHEMA) + ", got " + JSON.stringify(token.schema));
  }
  if (!validSlug(token.slug)) {
    throw new Error("resume token slug invalid: " + JSON.stringify(token.slug));
  }
  // Required string fields.
  for (const field of ["branch", "worktree", "active_phase", "last_checkpoint", "head_commit", "issued_at"]) {
    if (typeof token[field] !== "string" || token[field].length === 0) {
      throw new Error("resume token field required: " + field);
    }
  }
  // next_action is REQUIRED (§5.1) — fail closed if missing.
  if (typeof token.next_action !== "string" || token.next_action.length === 0) {
    throw new Error("resume token missing required field: next_action");
  }
  if (!isStringArray(token.outstanding)) {
    throw new Error("resume token outstanding must be an array of strings");
  }
  if (!isStringArray(token.pending_subagents)) {
    throw new Error("resume token pending_subagents must be an array of strings");
  }
  if (token.loop === null || typeof token.loop !== "object" || Array.isArray(token.loop)) {
    throw new Error("resume token loop must be an object");
  }
  if (typeof token.loop.kind !== "string" || token.loop.kind.length === 0) {
    throw new Error("resume token loop.kind required");
  }
  // loop.continue defaults to true when absent.
  let loopContinue;
  if (token.loop.continue === undefined) {
    loopContinue = true;
  } else if (typeof token.loop.continue === "boolean") {
    loopContinue = token.loop.continue;
  } else {
    throw new Error("resume token loop.continue must be a boolean");
  }

  return {
    schema: SCHEMA,
    slug: token.slug,
    branch: token.branch,
    worktree: token.worktree,
    active_phase: token.active_phase,
    last_checkpoint: token.last_checkpoint,
    next_action: token.next_action,
    head_commit: token.head_commit,
    outstanding: token.outstanding.slice(),
    pending_subagents: token.pending_subagents.slice(),
    loop: { kind: token.loop.kind, continue: loopContinue },
    issued_at: token.issued_at,
  };
}

/**
 * Atomically write the resume token to .plans/<slug>.resume.json.
 * Validates the token (and slug) first. Uses a temp file matching the
 * `.plans/*.tmp-*` gitignore glob + rename. Leaves NO partial target file if
 * the write/rename fails (the rename is atomic; on failure the temp is removed).
 */
function write(repoRoot, slug, token) {
  if (!validSlug(slug)) throw new Error("bad slug: " + JSON.stringify(slug));
  const normalized = validate(token);
  if (normalized.slug !== slug) {
    throw new Error("slug mismatch: arg=" + slug + " token.slug=" + normalized.slug);
  }
  const dir = plansDirOf(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, tokenFile(slug));
  const data = JSON.stringify(normalized, null, 2) + "\n";
  const tmp = target + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (e) {
    // Clean up the temp file so no partial artifact is left behind.
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
  return target;
}

/**
 * Read + validate .plans/<slug>.resume.json. Returns the normalized token
 * (loop.continue default applied). Throws if the file is missing/invalid.
 */
function read(repoRoot, slug) {
  if (!validSlug(slug)) throw new Error("bad slug: " + JSON.stringify(slug));
  const target = path.join(plansDirOf(repoRoot), tokenFile(slug));
  const txt = fs.readFileSync(target, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(txt);
  } catch (e) {
    throw new Error("resume token is not valid JSON: " + e.message);
  }
  return validate(parsed);
}

module.exports = { SCHEMA, validate, write, read, plansDirOf, tokenFile, validSlug };
