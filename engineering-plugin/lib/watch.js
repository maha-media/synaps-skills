/*
 * watch.js — debounced file watcher over .plans/ artifacts. Computes a
 * section-id delta vs a cached snapshot, else a full-refresh signal. Spec §6.1.
 * Plan P2-1. Bounded (one watcher per dir).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const EngPlan = require("../assets/engplan.js");
const { extractPlanJson } = require("./discovery.js");

function snapshotSections(planJson) {
  const map = new Map();
  if (planJson && Array.isArray(planJson.sections)) {
    for (const s of planJson.sections) {
      if (s && typeof s.id === "string") map.set(s.id, JSON.stringify(s));
    }
  }
  return map;
}

function diffSnapshots(prev, next) {
  const changed = [];
  for (const [id, sig] of next) {
    if (!prev.has(id) || prev.get(id) !== sig) changed.push(id);
  }
  const removed = [];
  for (const id of prev.keys()) if (!next.has(id)) removed.push(id);
  return { changed, removed };
}

/**
 * watchPlans(plansDir, onChange, opts)
 * onChange({ file, slug, changed:[ids], removed:[ids], full:bool })
 * returns { close() }.
 */
function watchPlans(plansDir, onChange, opts) {
  opts = opts || {};
  const debounceMs = opts.debounceMs != null ? opts.debounceMs : 50;
  const snapshots = new Map(); // file -> Map(sectionId->sig)
  const timers = new Map();

  function fileToSlug(file) {
    const m = file.match(/^(.*)\.(plan|spec)\.html$/);
    return m ? m[1] : null;
  }

  function process(file) {
    const slug = fileToSlug(file);
    const full = path.join(plansDir, file);
    let json = null;
    try { json = extractPlanJson(fs.readFileSync(full, "utf8")); } catch (_) {}
    const next = snapshotSections(json);
    const prev = snapshots.get(file) || new Map();
    const { changed, removed } = diffSnapshots(prev, next);
    snapshots.set(file, next);
    const full_refresh = !json; // could not parse → full
    onChange({ file, slug, changed, removed, full: full_refresh || (changed.length === 0 && removed.length === 0 && prev.size === 0) });
  }

  // seed snapshots
  try {
    for (const f of fs.readdirSync(plansDir)) {
      if (/\.(plan|spec)\.html$/.test(f)) {
        try { snapshots.set(f, snapshotSections(extractPlanJson(fs.readFileSync(path.join(plansDir, f), "utf8")))); } catch (_) {}
      }
    }
  } catch (_) {}

  let watcher = null;
  try {
    watcher = fs.watch(plansDir, { persistent: false }, (evt, filename) => {
      if (!filename) return;
      const f = filename.toString();
      if (!/\.(plan|spec)\.html$/.test(f)) return;
      if (timers.has(f)) clearTimeout(timers.get(f));
      timers.set(f, setTimeout(() => { timers.delete(f); process(f); }, debounceMs));
    });
  } catch (_) { watcher = null; }

  return {
    close() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (watcher) try { watcher.close(); } catch (_) {}
    },
    _process: process, // for tests
  };
}

module.exports = { watchPlans, snapshotSections, diffSnapshots };
