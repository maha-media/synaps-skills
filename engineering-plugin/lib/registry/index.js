/*
 * registry/index.js — agent registry (spec §5.5, §4.6). Typed boundary parse,
 * bounded, writes agents.json (gitignored). Heartbeat + reaper. Plan P5-1.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROLES = ["orchestrator", "impl", "sub"];
const STATUSES = ["spawning", "working", "idle", "blocked", "done", "dead"];
const DEFAULTS = { maxAgents: 256, maxFieldLen: 512, heartbeatTimeoutMs: 30000 };

function isStr(v) { return typeof v === "string"; }

function parseAgent(raw, limits) {
  limits = limits || DEFAULTS;
  if (!raw || typeof raw !== "object") throw new Error("agent must be object");
  function s(v, def) {
    if (v === undefined || v === null) return def;
    if (!isStr(v)) throw new Error("field must be string");
    if (v.length > limits.maxFieldLen) throw new Error("field too long");
    return v;
  }
  const role = s(raw.role, "impl");
  if (ROLES.indexOf(role) === -1) throw new Error("bad role: " + role);
  let depth = raw.depth == null ? 0 : raw.depth;
  if (typeof depth !== "number" || depth < 0 || depth > 64) throw new Error("bad depth");
  const status = s(raw.status, "spawning");
  if (STATUSES.indexOf(status) === -1) throw new Error("bad status");
  // pane address claim is NOT authority — just stored as data
  return {
    id: s(raw.id, null),
    role,
    pane: s(raw.pane, null),
    parent: s(raw.parent, null),
    depth,
    model: s(raw.model, null),
    worktree: s(raw.worktree, null),
    branch: s(raw.branch, null),
    plan_id: s(raw.plan_id, null),
    current_section: s(raw.current_section, null),
    status,
    started_at: s(raw.started_at, null),
    last_heartbeat: s(raw.last_heartbeat, null),
  };
}

class Registry {
  constructor(repoRoot, opts) {
    opts = opts || {};
    this.repoRoot = repoRoot;
    this.limits = Object.assign({}, DEFAULTS, opts.limits || {});
    this.clock = opts.clock || { now: () => new Date().toISOString() };
    this.file = path.join(repoRoot, ".plans", "agents.json");
    this.listeners = new Set();
  }
  _read() {
    try { const a = JSON.parse(fs.readFileSync(this.file, "utf8")); return Array.isArray(a) ? a : []; }
    catch (_) { return []; }
  }
  _write(arr) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp-" + crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2) + "\n");
    fs.renameSync(tmp, this.file);
    this._emit();
  }
  list() { return this._read(); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { const snap = this._read(); for (const fn of this.listeners) { try { fn(snap); } catch (_) {} } }

  register(raw) {
    const arr = this._read();
    if (arr.length >= this.limits.maxAgents) throw new Error("agent cap exceeded");
    const agent = parseAgent(raw, this.limits);
    const now = this.clock.now();
    if (!agent.id) agent.id = "agent_" + crypto.randomBytes(5).toString("hex");
    if (!agent.started_at) agent.started_at = now;
    agent.last_heartbeat = now;
    const idx = arr.findIndex((a) => a.id === agent.id);
    if (idx === -1) arr.push(agent); else arr[idx] = Object.assign(arr[idx], agent);
    this._write(arr);
    return agent;
  }
  heartbeat(id, patch) {
    const arr = this._read();
    const idx = arr.findIndex((a) => a.id === id);
    if (idx === -1) throw new Error("agent not found");
    const now = this.clock.now();
    arr[idx].last_heartbeat = now;
    if (patch && typeof patch === "object") {
      const p = parseAgent(Object.assign({}, arr[idx], patch), this.limits);
      arr[idx] = Object.assign(arr[idx], p, { id: arr[idx].id, last_heartbeat: now });
    }
    this._write(arr);
    return arr[idx];
  }
  deregister(id) {
    const arr = this._read().filter((a) => a.id !== id);
    this._write(arr);
  }
  reap(nowMs) {
    const arr = this._read();
    const cut = (nowMs != null ? nowMs : Date.now()) - this.limits.heartbeatTimeoutMs;
    let changed = false;
    for (const a of arr) {
      const hb = a.last_heartbeat ? Date.parse(a.last_heartbeat) : 0;
      if (hb < cut && a.status !== "dead") { a.status = "dead"; changed = true; }
    }
    if (changed) this._write(arr);
    return arr.filter((a) => a.status === "dead");
  }
}

module.exports = { Registry, parseAgent, ROLES, STATUSES, DEFAULTS };
