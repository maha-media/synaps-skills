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
  return target;
}

function eventsFile(slug) { return slug + ".events.json"; }
function notesFile(slug) { return slug + ".notes.json"; }

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
  DEFAULTS, plansDirOf, eventsFile, notesFile, allowedWriteTarget,
  readNotes, appendEvent, writeEvents, respondToEvent, findEvent, atomicWrite, genId,
};
