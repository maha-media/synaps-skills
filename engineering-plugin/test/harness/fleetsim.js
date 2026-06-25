/*
 * fleetsim.js — FleetSim (Addendum E, H-7). Headless tmux fleet harness.
 * Uses a deterministic in-process fake tmux model (panes/windows) so S16–S21
 * run with no real editor and no human. The fake exec implements the subset of
 * tmux the PaneController uses; stub agents register/heartbeat via the Registry
 * and reconcile via the Plan Inbox.
 */
"use strict";
const { PaneController } = require("../../lib/tmux/index.js");
const { Registry } = require("../../lib/registry/index.js");

// Minimal tmux server model: sessions/windows/panes with addresses s:w.p.
class FakeTmux {
  constructor() {
    this.calls = [];
    this.panes = new Set(["main:0.0"]); // orchestrator pane exists
    this.keys = {};                     // pane -> [strings sent]
    this._next = { "main:0": 1 };       // next pane index per window
  }
  exec(args) {
    this.calls.push(args.slice());
    const cmd = args[0];
    if (cmd === "display-message") return "main:0.0";
    if (cmd === "split-window") {
      // -t target ; allocate next pane in same window
      const ti = args.indexOf("-t");
      const target = ti !== -1 ? args[ti + 1] : "main:0.0";
      const win = target.split(".")[0]; // main:0
      const idx = this._next[win] || 1;
      this._next[win] = idx + 1;
      const pane = win + "." + idx;
      this.panes.add(pane);
      return pane;
    }
    if (cmd === "send-keys") {
      const ti = args.indexOf("-t");
      const pane = args[ti + 1];
      const payload = args[ti + 2];
      (this.keys[pane] = this.keys[pane] || []).push(payload);
      return "";
    }
    if (cmd === "kill-pane") {
      const ti = args.indexOf("-t");
      this.panes.delete(args[ti + 1]);
      return "";
    }
    if (cmd === "capture-pane") return (this.keys[args[args.indexOf("-t") + 1]] || []).join("\n");
    return "";
  }
}

class FleetSim {
  constructor(ctx, opts) {
    opts = opts || {};
    this.ctx = ctx;
    this.tmux = new FakeTmux();
    this.controller = new PaneController({
      exec: (a) => this.tmux.exec(a),
      maxImplAgents: opts.maxImplAgents != null ? opts.maxImplAgents : 2,
      maxDepth: opts.maxDepth != null ? opts.maxDepth : 2,
      owned: ["main:0.0"],
    });
    this.registry = new Registry(ctx.repoRoot, { clock: ctx.clock });
  }

  spawnImpl(opts) {
    const r = this.controller.spawn(opts || {});
    if (r.queued) return r;
    // register the agent in the roster
    this.registry.register({ role: "impl", pane: r.pane, depth: (opts && opts.depth) || 1, model: "claude-opus-4-8", status: "spawning" });
    return r;
  }

  // hand task by reference only (no untrusted content)
  launch(pane, taskRef) { this.controller.launchSynaps(pane, taskRef); }

  roster() { return this.registry.list(); }
  panes() { return Array.from(this.tmux.panes); }
}

module.exports = { FleetSim, FakeTmux };
