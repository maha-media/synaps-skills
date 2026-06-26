#!/usr/bin/env node
/*
 * plans-sidecar.js — Synaps provides.sidecar process (protocol v2).
 *
 * Newline-delimited JSON over stdio. The PRIMARY, host-supervised surface for
 * the plans server: it hosts the HTTP server IN-PROCESS, on demand, for the
 * lifetime of its parent Synaps. There is NO detached daemon, NO .unref(), and
 * the process is never handed to another Synaps.
 *
 *   start            → emit hello (capabilities)
 *   ← init           → ready (no listener yet — on demand)
 *   ← trigger{plans} → ensureServer in-process → emit url-bearing status +
 *                      insert_text (+ a custom plans.serving frame)
 *   ← shutdown / parent exit / SIGTERM / stdin EOF
 *                    → if hosting, close the server + remove the record; exit
 *
 * Node stdlib only. Plan S1.
 */
"use strict";
const path = require("path");
const readline = require("readline");

function runSidecar(opts) {
  opts = opts || {};
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const repoRoot = opts.repoRoot || process.env.REPO_ROOT || process.cwd();
  const pluginDir = opts.pluginDir || process.env.PLUGIN_DIR || path.join(__dirname, "..");
  const life = opts.lifecycle || require("../lib/server_lifecycle.js");
  const createServer = opts.createServer; // optional factory override (tests)
  const doExit = opts.exit !== false;     // tests pass exit:false

  let hosting = false;
  let closed = false;

  function emit(obj) { try { output.write(JSON.stringify(obj) + "\n"); } catch (_) {} }
  function status(state, label) { emit({ type: "status", state, label }); }

  // Readiness frame first.
  emit({ type: "hello", protocol_version: 2, extension: "plans-server", capabilities: ["status", "insert-text"] });

  async function onTrigger(frame) {
    // 'plans' is our lifecycle trigger; tolerate an unnamed trigger too.
    if (frame && frame.name && frame.name !== "plans") {
      emit({ type: "error", message: "unknown trigger: " + frame.name });
      return;
    }
    status("active", "starting plans server");
    try {
      const r = await life.ensureServer(repoRoot, { createServer, pluginDir });
      if (r.hosted) hosting = true;
      emit({ type: "insert_text", text: r.url, mode: "final" });
      emit({ type: "status", state: "active", label: (r.reused ? "plans server (reused): " : "plans server: ") + r.url });
      emit({ type: "custom", event_type: "plans.serving", payload: { url: r.url, port: r.port, reused: !!r.reused, hosted: !!r.hosted } });
    } catch (e) {
      emit({ type: "error", message: "plans ensureServer failed: " + (e && e.message) });
      status("idle", "plans server error");
    }
  }

  async function shutdown(code) {
    if (closed) return; closed = true;
    try { if (hosting) await life.stopServer(repoRoot); } catch (_) {}
    hosting = false;
    status("stopped", "plans server stopped");
    if (doExit) process.exit(code || 0);
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const t = String(line).trim();
    if (!t) return;
    let frame;
    try { frame = JSON.parse(t); } catch (e) { emit({ type: "error", message: "bad JSON: " + e.message }); return; }
    switch (frame.type) {
      case "init": status("idle", "plans sidecar ready"); break;
      case "trigger": onTrigger(frame); break;
      case "shutdown": shutdown(0); break;
      default: emit({ type: "error", message: "unknown frame type: " + frame.type });
    }
  });
  // Parent death closes our stdin → tear down (parent-bound lifetime).
  rl.on("close", () => { shutdown(0); });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(sig, () => shutdown(0));

  return { emit, shutdown, isHosting: () => hosting, repoRoot };
}

module.exports = { runSidecar };

if (require.main === module) runSidecar();
