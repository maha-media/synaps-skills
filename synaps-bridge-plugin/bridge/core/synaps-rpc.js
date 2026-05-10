/**
 * bridge/core/synaps-rpc.js
 *
 * Node client for `synaps rpc` — spawns the child process and exposes a
 * typed Promise + EventEmitter API.  No I/O in the constructor; all side
 * effects are behind start() / shutdown().
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// ─── internal helpers ───────────────────────────────────────────────────────

/**
 * Build the argv for the child process.
 * @param {object} opts
 * @returns {string[]}
 */
function buildArgv({ sessionId, systemPrompt, model, profile, args }) {
  const argv = ["rpc"];
  if (sessionId) argv.push("--continue", sessionId);
  if (systemPrompt) argv.push("--system", systemPrompt);
  if (model) argv.push("--model", model);
  if (profile) argv.push("--profile", profile);
  argv.push(...args);
  return argv;
}

// ─── SynapsRpc ───────────────────────────────────────────────────────────────

export class SynapsRpc extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string}   [opts.binPath="synaps"]
   * @param {string[]} [opts.args=[]]
   * @param {string|null} [opts.sessionId=null]
   * @param {string|null} [opts.systemPrompt=null]
   * @param {string|null} [opts.model=null]
   * @param {string|null} [opts.profile=null]
   * @param {string}   [opts.cwd]
   * @param {object}   [opts.env]
   * @param {object}   [opts.logger=console]
   * @param {number}   [opts.commandTimeoutMs=60_000]
   * @param {number}   [opts.spawnTimeoutMs=10_000]
   * @param {Function} [opts._spawn]  — test-only override for child_process.spawn
   */
  constructor({
    binPath = "synaps",
    args = [],
    sessionId = null,
    systemPrompt = null,
    model = null,
    profile = null,
    cwd = process.cwd(),
    env = process.env,
    logger = console,
    commandTimeoutMs = 60_000,
    spawnTimeoutMs = 10_000,
    _spawn = null,
    _sigkillDelayMs = 1_000,  // test-only: how long after SIGTERM before SIGKILL
  } = {}) {
    super();

    this._binPath = binPath;
    this._args = args;
    this._sessionId = sessionId;
    this._systemPrompt = systemPrompt;
    this._model = model;
    this._profile = profile;
    this._cwd = cwd;
    this._env = env;
    this.logger = logger;
    this._commandTimeoutMs = commandTimeoutMs;
    this._spawnTimeoutMs = spawnTimeoutMs;
    this._sigkillDelayMs = _sigkillDelayMs;
    this._spawnFn = _spawn ?? spawn;

    /** @type {import("node:child_process").ChildProcess|null} */
    this._child = null;

    /** @type {Map<string, {command:string, resolve:Function, reject:Function, timer:NodeJS.Timeout}>} */
    this._pending = new Map();

    /** Incomplete line carried over from previous stdout chunk */
    this._lineBuffer = "";

    /** Whether stdin is currently draining (backpressure) */
    this._draining = false;
    /** Queue of serialised frames waiting for drain */
    this._writeQueue = [];
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Spawn the child process and wait for the `ready` event.
   * @returns {Promise<{sessionId:string, model:string, protocolVersion:number}>}
   */
  async start() {
    if (this._child) throw new Error("SynapsRpc: already started");

    const argv = buildArgv({
      sessionId: this._sessionId,
      systemPrompt: this._systemPrompt,
      model: this._model,
      profile: this._profile,
      args: this._args,
    });

    this._child = this._spawnFn(this._binPath, argv, {
      cwd: this._cwd,
      env: this._env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // ── stderr → logger.warn (line-buffered) ─────────────────────────────
    let stderrBuf = "";
    this._child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      let nl;
      while ((nl = stderrBuf.indexOf("\n")) !== -1) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        this.logger.warn(`[synaps-rpc stderr] ${line}`);
      }
    });
    this._child.stderr.on("end", () => {
      if (stderrBuf.length > 0) {
        this.logger.warn(`[synaps-rpc stderr] ${stderrBuf}`);
        stderrBuf = "";
      }
    });

    // ── stdout → frame parser ─────────────────────────────────────────────
    this._child.stdout.on("data", (chunk) => this._onStdoutData(chunk));
    this._child.stdout.on("end", () => {
      // flush any remaining partial line
      if (this._lineBuffer.trim().length > 0) {
        this._processLine(this._lineBuffer);
        this._lineBuffer = "";
      }
    });

    // ── child exit ────────────────────────────────────────────────────────
    this._child.on("exit", (code, signal) => {
      this._onChildExit(code, signal);
    });

    // ── wait for ready ────────────────────────────────────────────────────
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`SynapsRpc: timed out waiting for ready (${this._spawnTimeoutMs} ms)`));
      }, this._spawnTimeoutMs);

      // Use once() so this resolves exactly once
      this.once("ready", (readyPayload) => {
        clearTimeout(timer);
        resolve(readyPayload);
      });

      // If child exits before ready fires
      this.once("exit", ({ code, signal }) => {
        clearTimeout(timer);
        reject(new Error(`SynapsRpc: child exited before ready (code=${code} signal=${signal})`));
      });
    });
  }

  /**
   * Send a shutdown command and wait for the child to exit.
   * @param {number} graceMs
   * @returns {Promise<{code:number|null, signal:string|null}>}
   */
  async shutdown(graceMs = 5_000) {
    // Write shutdown (no id, no response expected)
    if (this._child && !this._child.killed) {
      this._rawWrite(JSON.stringify({ type: "shutdown" }) + "\n");
    }

    return new Promise((resolve) => {
      let settled = false;
      let graceTimer;
      let killTimer;

      // The 'exit' event from SynapsRpc always carries a single object payload
      // { code, signal } — destructure it correctly here.
      const done = ({ code, signal }) => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        clearTimeout(killTimer);
        resolve({ code, signal });
      };

      // Already dead?
      if (!this._child || this._child.exitCode !== null || this._child.signalCode !== null) {
        const code = this._child?.exitCode ?? null;
        const signal = this._child?.signalCode ?? null;
        return done({ code, signal });
      }

      this.once("exit", done);

      graceTimer = setTimeout(() => {
        if (!settled && this._child && !this._child.killed) {
          this.logger.warn("SynapsRpc: grace timeout — sending SIGTERM");
          this._child.kill("SIGTERM");
        }
        // After SIGTERM, child.killed becomes true even if the process is still
        // running.  Guard SIGKILL only on !settled (process hasn't emitted exit).
        killTimer = setTimeout(() => {
          if (!settled && this._child) {
            this.logger.warn("SynapsRpc: still alive after SIGTERM — sending SIGKILL");
            this._child.kill("SIGKILL");
          }
        }, this._sigkillDelayMs);
      }, graceMs);
    });
  }

  // ── commands ──────────────────────────────────────────────────────────────

  /**
   * Send a user prompt.
   * @param {string} message
   * @param {Array<{path:string, name?:string, mime?:string}>} attachments
   */
  async prompt(message, attachments = []) {
    const frame = { type: "prompt", message };
    if (attachments.length > 0) frame.attachments = attachments;
    const response = await this._send(frame);
    if (response.ok === false) {
      throw new Error(response.error ?? "prompt failed");
    }
    return response;
  }

  /** @param {string} message */
  async followUp(message) {
    return this._send({ type: "follow_up", message });
  }

  async compact() {
    return this._send({ type: "compact" });
  }

  async newSession() {
    return this._send({ type: "new_session" });
  }

  async getMessages() {
    return this._send({ type: "get_messages" });
  }

  /** @param {string} model */
  async setModel(model) {
    return this._send({ type: "set_model", model });
  }

  async getAvailableModels() {
    return this._send({ type: "get_available_models" });
  }

  async abort() {
    return this._send({ type: "abort" });
  }

  async getSessionStats() {
    return this._send({ type: "get_session_stats" });
  }

  async getState() {
    return this._send({ type: "get_state" });
  }

  // ── internal: command correlation ─────────────────────────────────────────

  /**
   * Write a command frame with a generated id, return a Promise that resolves
   * when the matching `response` arrives or rejects on `error`/timeout/exit.
   * @param {object} frame
   * @returns {Promise<object>}
   */
  _send(frame) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const command = frame.type;

      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`rpc timeout: command=${command} id=${id}`));
        }
      }, this._commandTimeoutMs);

      this._pending.set(id, { command, resolve, reject, timer });

      const wire = JSON.stringify({ ...frame, id }) + "\n";
      this._writeFrame(wire);
    });
  }

  // ── internal: stdin writing with backpressure ─────────────────────────────

  /**
   * Write a serialised frame, honouring backpressure.
   * @param {string} wire  — already-serialised JSONL line
   */
  _writeFrame(wire) {
    if (this._draining) {
      this._writeQueue.push(wire);
      return;
    }
    this._rawWrite(wire);
  }

  /**
   * Write directly to stdin; if it returns false, set draining and flush on
   * the 'drain' event.
   * @param {string} wire
   */
  _rawWrite(wire) {
    if (!this._child || !this._child.stdin || this._child.stdin.destroyed) return;

    const ok = this._child.stdin.write(wire);
    if (!ok) {
      this._draining = true;
      this._child.stdin.once("drain", () => {
        this._draining = false;
        this._flushWriteQueue();
      });
    }
  }

  /** Flush queued frames after drain. */
  _flushWriteQueue() {
    while (this._writeQueue.length > 0 && !this._draining) {
      const wire = this._writeQueue.shift();
      this._rawWrite(wire);
    }
  }

  // ── internal: stdout parsing ──────────────────────────────────────────────

  /**
   * Called with each raw data chunk from child stdout.
   * @param {Buffer|string} chunk
   */
  _onStdoutData(chunk) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this._lineBuffer += text;

    let nl;
    while ((nl = this._lineBuffer.indexOf("\n")) !== -1) {
      const line = this._lineBuffer.slice(0, nl);
      this._lineBuffer = this._lineBuffer.slice(nl + 1);
      if (line.length > 0) this._processLine(line);
    }
  }

  /**
   * Parse and dispatch a single complete line from child stdout.
   * @param {string} line
   */
  _processLine(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      this.logger.warn(`SynapsRpc: dropped malformed JSON line (${line.length} chars)`);
      return;
    }

    this._dispatchFrame(frame);
  }

  /**
   * Route a parsed frame to the appropriate handler.
   * @param {object} frame
   */
  _dispatchFrame(frame) {
    switch (frame.type) {
      case "ready":
        this._handleReady(frame);
        break;

      case "response":
        this._handleResponse(frame);
        break;

      case "error":
        this._handleError(frame);
        break;

      case "message_update":
        // Emit the inner event object, NOT the wrapper
        this.emit("message_update", frame.event);
        break;

      case "subagent_start": {
        const { subagent_id, agent_name, task_preview } = frame;
        this.emit("subagent_start", { subagent_id, agent_name, task_preview });
        break;
      }

      case "subagent_update": {
        const { subagent_id, agent_name, status } = frame;
        this.emit("subagent_update", { subagent_id, agent_name, status });
        break;
      }

      case "subagent_done": {
        const { subagent_id, agent_name, result_preview, duration_secs } = frame;
        this.emit("subagent_done", { subagent_id, agent_name, result_preview, duration_secs });
        break;
      }

      case "agent_end":
        this.emit("agent_end", { usage: frame.usage });
        break;

      default:
        this.logger.warn(`SynapsRpc: unknown frame type '${frame.type}'`);
    }
  }

  // ── internal: frame handlers ──────────────────────────────────────────────

  /** @param {object} frame */
  _handleReady(frame) {
    if (frame.protocol_version !== 1) {
      const err = new Error(
        `SynapsRpc: unsupported protocol_version ${frame.protocol_version} (expected 1)`
      );
      this.emit("error", err);
      // Kill the child — version mismatch is fatal
      if (this._child && !this._child.killed) this._child.kill("SIGTERM");
      return;
    }
    this.emit("ready", {
      sessionId: frame.session_id,
      model: frame.model,
      protocolVersion: frame.protocol_version,
    });
  }

  /** @param {object} frame */
  _handleResponse(frame) {
    const entry = this._pending.get(frame.id);
    if (!entry) {
      // Spurious response — ignore
      return;
    }
    clearTimeout(entry.timer);
    this._pending.delete(frame.id);

    // Flatten: strip type/id/command, expose everything else
    const { type: _t, id: _id, command: _cmd, ...body } = frame;
    entry.resolve({ command: frame.command, ...body });
  }

  /** @param {object} frame */
  _handleError(frame) {
    const id = frame.id ?? null;
    if (id && this._pending.has(id)) {
      const entry = this._pending.get(id);
      clearTimeout(entry.timer);
      this._pending.delete(id);
      const err = new Error(frame.message);
      err.id = id;
      entry.reject(err);
    } else {
      // No matching pending — emit as a global error event
      const err = new Error(frame.message);
      if (id) err.id = id;
      this.emit("error", err);
    }
  }

  // ── internal: child exit ──────────────────────────────────────────────────

  /**
   * @param {number|null} code
   * @param {string|null} signal
   */
  _onChildExit(code, signal) {
    // Reject all pending promises
    const reason = new Error(`rpc child exited: code=${code}`);
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      this._pending.delete(id);
    }

    this.emit("exit", { code, signal });
  }
}
