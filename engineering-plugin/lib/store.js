/*
 * store.js — notes/events persistence under .plans/. Atomic writes, write
 * confinement to *.notes.json / *.events.json, body/event caps. Spec §6, §7.2.
 * Plan P3-1, P3-3, P4-SEC-4.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const EngPlan = require("../assets/engplan.js");
const { safeRealpath, isInside } = require("./paths.js");

const DEFAULTS = { maxEventsPerPlan: 1000, maxBodyBytes: 256 * 1024 };

function plansDirOf(repoRoot) { return path.join(repoRoot, ".plans"); }

function slugOk(slug) { return EngPlan.validId(slug); }

// Only these filenames are writable, and only inside .plans/.
function allowedWriteTarget(repoRoot, filename) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(notes|events)\.json$/.test(filename) && filename !== "agents.json") {
    throw new Error("write target not allowed: " + filename);
  }
  const plansDir = plansDirOf(repoRoot);
  const target = safeRealpath(plansDir, filename);
  if (!isInside(plansDir, target)) throw new Error("write escapes .plans/");
  ensurePlansGitignore(repoRoot);
  return target;
}

function eventsFile(slug) { return slug + ".events.json"; }
function notesFile(slug) { return slug + ".notes.json"; }

// Runtime artifacts the plans server rewrites continuously. Self-confined to
// .plans/ so every project that uses the engineering toolkit is correct by
// default — no root .gitignore edits required. Plan documents (*.plan.html)
// and _assets/ stay tracked intentionally (never listed as rules).
const PLANS_GITIGNORE_PATTERNS = [
  "agents.json",
  "*.events.json",
  "*.notes.json",
  "*.oracle.jsonl",
  "*.tmp-*",
  "*.lock",
  ".server.json",
  ".server.lock",
];

// Delimited managed block. The plugin owns ONLY the bytes between these markers
// (interior + the marker lines themselves); everything outside is user content
// and is preserved byte-for-byte. This lets existing projects gain the rules on
// upgrade without the plugin clobbering a file it did not fully author.
const MANAGED_BEGIN = "# >>> engineering plans (managed — do not edit inside) >>>";
const MANAGED_END = "# <<< engineering plans (managed) <<<";
const MANAGED_BLOCK = [MANAGED_BEGIN, ...PLANS_GITIGNORE_PATTERNS, MANAGED_END].join("\n");

// Header preamble written above the block only when creating a brand-new file.
const PLANS_GITIGNORE_HEADER = [
  "# Engineering plugin runtime artifacts — auto-generated.",
  "# Plan documents (*.plan.html) and _assets/ stay tracked.",
].join("\n");

/**
 * Idempotently ensure .plans/.gitignore carries the managed runtime-artifact
 * block (Option A — managed-block merge). Best-effort: never throws into a
 * notes/events write.
 *
 *  - No file            → create with header preamble + managed block.
 *  - File without block  → append the block, preserving every existing user
 *                          line byte-for-byte.
 *  - File with stale block → replace only the bytes between the markers.
 *  - File with up-to-date block → no write (idempotent).
 */
function ensurePlansGitignore(repoRoot) {
  const gi = path.join(plansDirOf(repoRoot), ".gitignore");
  try {
    let content = null;
    try { content = fs.readFileSync(gi, "utf8"); } catch (_) { content = null; }

    if (content === null) {
      // Brand-new file.
      fs.mkdirSync(path.dirname(gi), { recursive: true });
      fs.writeFileSync(gi, PLANS_GITIGNORE_HEADER + "\n" + MANAGED_BLOCK + "\n");
      return;
    }

    const begIdx = content.indexOf(MANAGED_BEGIN);
    const endMarkerIdx = content.indexOf(MANAGED_END);
    if (begIdx !== -1 && endMarkerIdx !== -1 && endMarkerIdx > begIdx) {
      // A complete managed block exists — operate only on its bytes.
      const blockEnd = endMarkerIdx + MANAGED_END.length;
      const current = content.slice(begIdx, blockEnd);
      if (current === MANAGED_BLOCK) return; // up-to-date → no-op
      const updated = content.slice(0, begIdx) + MANAGED_BLOCK + content.slice(blockEnd);
      fs.writeFileSync(gi, updated);
      return;
    }

    // No managed block — append it, preserving all existing bytes. Insert a
    // single separating newline only when the file does not already end in one.
    const sep = content.length && !content.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(gi, content + sep + MANAGED_BLOCK + "\n");
  } catch (_) { /* best-effort; never block a write on ignore scaffolding */ }
}

function readJsonArray(file) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function atomicWrite(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function genId(prefix, clock) {
  const t = clock && clock.now ? clock.now() : new Date().toISOString();
  return prefix + "_" + crypto.randomBytes(6).toString("hex");
}

/** Read notes + events for a plan slug. */
function readNotes(repoRoot, slug, opts) {
  if (!slugOk(slug)) throw new Error("bad slug");
  const plansDir = plansDirOf(repoRoot);
  const events = readJsonArray(path.join(plansDir, eventsFile(slug)));
  const notes = readJsonArray(path.join(plansDir, notesFile(slug)));
  return { events, notes };
}

/**
 * Append an event (or note). Validates via parseEvent, enforces caps, writes
 * atomically with a simple retry to reduce lost-update races.
 */
function appendEvent(repoRoot, slug, rawEvent, opts) {
  opts = opts || {};
  const limits = Object.assign({}, DEFAULTS, opts.limits || {});
  const clock = opts.clock;
  if (!slugOk(slug)) throw new Error("bad slug");

  const ev = EngPlan.parseEvent(Object.assign({ plan_id: slug }, rawEvent));
  if (ev.plan_id !== slug) throw new Error("plan_id mismatch");
  if (!ev.id) ev.id = genId("evt", clock);
  if (!ev.created_at) ev.created_at = clock && clock.now ? clock.now() : new Date().toISOString();

  // Enforce the store's declared body cap (defense in depth; reconcile and
  // direct store callers bypass the HTTP transport guard). Check before
  // acquiring the lock to avoid holding it on a guaranteed-fail. The message
  // uses the literal phrase "too large" so the HTTP layer maps it to 413.
  const bodyBytes = Buffer.byteLength(JSON.stringify(ev), "utf8");
  if (bodyBytes > limits.maxBodyBytes) throw new Error("event body too large");

  const target = allowedWriteTarget(repoRoot, eventsFile(slug));
  // simple lock via O_EXCL lockfile with retry
  const lock = target + ".lock";
  let attempts = 0;
  while (true) {
    try {
      const fd = fs.openSync(lock, "wx");
      try {
        const arr = readJsonArray(target);
        if (arr.length >= limits.maxEventsPerPlan) throw new Error("event cap exceeded");
        arr.push(ev);
        atomicWrite(target, JSON.stringify(arr, null, 2) + "\n");
      } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(lock); } catch (_) {}
      }
      return ev;
    } catch (e) {
      if (e.code === "EEXIST") {
        if (++attempts > 200) throw new Error("lock timeout");
        // tiny spin
        const until = Date.now() + 5;
        while (Date.now() < until) { /* spin */ }
        continue;
      }
      try { fs.unlinkSync(lock); } catch (_) {}
      throw e;
    }
  }
}

/** Replace the entire events array (used by reconcile persistence). */
function writeEvents(repoRoot, slug, events) {
  if (!slugOk(slug)) throw new Error("bad slug");
  const target = allowedWriteTarget(repoRoot, eventsFile(slug));
  atomicWrite(target, JSON.stringify(events, null, 2) + "\n");
}

function findEvent(repoRoot, slug, eventId) {
  const { events } = readNotes(repoRoot, slug);
  return events.find((e) => e.id === eventId) || null;
}

/** Respond to an event (agent ack/incorporate/...). Spec §3.3, P3-3. */
function respondToEvent(repoRoot, slug, eventId, resp, opts) {
  opts = opts || {};
  const clock = opts.clock;
  const target = allowedWriteTarget(repoRoot, eventsFile(slug));
  const arr = readJsonArray(target);
  const idx = arr.findIndex((e) => e.id === eventId);
  if (idx === -1) throw new Error("event not found");
  let ev = arr[idx];
  const to = resp.agent_status || resp.status;
  if (!to) throw new Error("agent_status required");
  // allow ack first if currently open
  if (ev.status === "open" && to !== "acknowledged") {
    ev = EngPlan.transition(ev, "acknowledged");
  }
  const next = EngPlan.transition(ev, to);
  next.agent_status = to === "acknowledged" ? null : to;
  next.agent_response = typeof resp.agent_response === "string" ? resp.agent_response : "";
  next.changed_sections = Array.isArray(resp.changed_sections) ? resp.changed_sections.filter((s) => typeof s === "string") : [];
  next.responded_at = clock && clock.now ? clock.now() : new Date().toISOString();
  arr[idx] = next;
  atomicWrite(target, JSON.stringify(arr, null, 2) + "\n");
  return next;
}

module.exports = {
  DEFAULTS, plansDirOf, eventsFile, notesFile, allowedWriteTarget, ensurePlansGitignore,
  readNotes, appendEvent, writeEvents, respondToEvent, findEvent, atomicWrite, genId,
};
