/*
 * tmux/index.js — tmux detection + pane lifecycle controller (spec §4.6, §7.2).
 * Own-pane-only control, caps/depth enforcement, by-reference task handoff,
 * reap+clean. Plan P5-0, P5-2. Uses an injectable `exec` so it is testable
 * headlessly (and can drive a real `tmux` server in a temp dir).
 */
"use strict";
const { execFileSync } = require("child_process");

function detect(env) {
  env = env || process.env;
  return { inTmux: !!env.TMUX, tmux: env.TMUX || null };
}

function defaultExec(args, opts) {
  return execFileSync("tmux", args, Object.assign({ encoding: "utf8" }, opts || {})).toString();
}

// A pane address must look like session:window.pane (chars limited).
const PANE_RE = /^[A-Za-z0-9_-]+:\d+\.\d+$/;
function validPane(p) { return typeof p === "string" && PANE_RE.test(p); }

class PaneController {
  constructor(opts) {
    opts = opts || {};
    this.exec = opts.exec || defaultExec;
    this.maxImplAgents = opts.maxImplAgents != null ? opts.maxImplAgents : 4;
    this.maxDepth = opts.maxDepth != null ? opts.maxDepth : 2;
    this.owned = new Set(opts.owned || []); // panes we spawned
    this.depth = opts.depth || 0;
    this.spawnedCount = 0;
    this.queue = [];
  }

  currentPane() {
    try { return this.exec(["display-message", "-p", "#{session_name}:#{window_index}.#{pane_index}"]).trim(); }
    catch (_) { return null; }
  }

  _assertCaps(depth) {
    if (this.spawnedCount >= this.maxImplAgents) { const e = new Error("max_impl_agents reached"); e.code = "CAPPED"; throw e; }
    if (depth > this.maxDepth) { const e = new Error("max_depth reached"); e.code = "DEPTH"; throw e; }
  }

  // Spawn an impl pane to the right (two-column model). Returns pane address.
  spawn(opts) {
    opts = opts || {};
    const depth = opts.depth != null ? opts.depth : this.depth + 1;
    try { this._assertCaps(depth); }
    catch (e) { if (opts.backpressure !== false) { this.queue.push(opts); return { queued: true, reason: e.code }; } throw e; }
    const target = opts.target || this.currentPane();
    // split-window -h to make column 2
    const out = this.exec(["split-window", "-h", "-P", "-F", "#{session_name}:#{window_index}.#{pane_index}", "-t", target]);
    const pane = out.trim();
    if (!validPane(pane)) throw new Error("bad pane address from tmux: " + pane);
    this.owned.add(pane);
    this.spawnedCount++;
    return { pane, queued: false };
  }

  _assertOwned(pane) {
    if (!validPane(pane)) throw new Error("invalid pane address");
    if (!this.owned.has(pane)) { const e = new Error("refusing to control non-owned pane: " + pane); e.code = "NOT_OWNED"; throw e; }
  }

  // Send keys ONLY to owned panes; content must be a plain string we construct
  // (never untrusted plan/note text). Caller passes literal command strings.
  sendKeys(pane, keys) {
    this._assertOwned(pane);
    if (typeof keys !== "string") throw new Error("keys must be string");
    // refuse control/escape sequences that could be injection
    if (/[\u0000-\u0008\u000b-\u001f]/.test(keys)) throw new Error("illegal control chars in keys");
    this.exec(["send-keys", "-t", pane, keys, "Enter"]);
  }

  // Hand a task BY REFERENCE — never dump untrusted context.
  launchSynaps(pane, taskRef) {
    this._assertOwned(pane);
    this.exec(["send-keys", "-t", pane, "synaps", "Enter"]);
    this.exec(["send-keys", "-t", pane, "/clear", "Enter"]);
    if (typeof taskRef === "string" && /^[\w .:\/<>=#-]+$/.test(taskRef)) {
      this.exec(["send-keys", "-t", pane, taskRef, "Enter"]);
    }
  }

  kill(pane) {
    this._assertOwned(pane);
    try { this.exec(["kill-pane", "-t", pane]); } catch (_) {}
    this.owned.delete(pane);
    this.spawnedCount = Math.max(0, this.spawnedCount - 1);
  }

  reap(deadPanes) {
    const reaped = [];
    for (const p of deadPanes || []) {
      if (this.owned.has(p)) { try { this.kill(p); } catch (_) {} reaped.push(p); }
    }
    return reaped;
  }
}

module.exports = { detect, PaneController, validPane, defaultExec };
