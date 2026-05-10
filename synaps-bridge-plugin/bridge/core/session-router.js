/**
 * @file bridge/core/session-router.js
 *
 * Multiplexes (source, conversation, thread) → SynapsRpc instance.
 * Persists session metadata via SessionStore; idle-reaps after idleTtlMs.
 *
 * No Slack / Discord / source-specific imports.
 */

import { EventEmitter } from "node:events";
import { SynapsRpc } from "./synaps-rpc.js";
import { SessionStore } from "./session-store.js";
import { sessionKey } from "./helpers.js";

// ─── default rpc factory ─────────────────────────────────────────────────────

/**
 * @param {{ sessionId?: string|null, model?: string|null, logger?: object }} opts
 * @returns {SynapsRpc}
 */
function defaultRpcFactory({ sessionId = null, model = null, logger = console } = {}) {
  return new SynapsRpc({ sessionId, model, logger });
}

// ─── SessionRouter ────────────────────────────────────────────────────────────

export class SessionRouter extends EventEmitter {
  /**
   * @param {object}   [opts]
   * @param {SessionStore}   [opts.store]          - Injected store (default: new SessionStore()).
   * @param {Function}       [opts.rpcFactory]     - Factory: (opts) => SynapsRpc-like.
   * @param {number}         [opts.idleTtlMs]      - Idle TTL before reaping (default 24h).
   * @param {number}         [opts.reapIntervalMs] - How often to check for idle sessions (default 1h).
   * @param {Function}       [opts.nowMs]          - Returns current epoch ms (injectable).
   * @param {object}         [opts.logger]         - Logger (default: console).
   */
  constructor({
    store = new SessionStore(),
    rpcFactory = defaultRpcFactory,
    idleTtlMs = 24 * 60 * 60 * 1000,
    reapIntervalMs = 60 * 60 * 1000,
    nowMs = () => Date.now(),
    logger = console,
  } = {}) {
    super();

    this._store = store;
    this._rpcFactory = rpcFactory;
    this._idleTtlMs = idleTtlMs;
    this._reapIntervalMs = reapIntervalMs;
    this._nowMs = nowMs;
    this.logger = logger;

    /**
     * Live rpc instances.
     * @type {Map<string, import("node:events").EventEmitter>}
     */
    this._live = new Map();

    /**
     * In-flight creation promises — race-safety map.
     * @type {Map<string, Promise<import("node:events").EventEmitter>>}
     */
    this._pending = new Map();

    /** @type {NodeJS.Timeout|null} */
    this._reapTimer = null;

    /** Tracks per-key lastActiveAt for reaping without an extra store round-trip. */
    this._lastActive = new Map();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Load existing store state and schedule the idle reaper.
   * @returns {Promise<void>}
   */
  async start() {
    // Pre-load store so we know which sessions exist on first access.
    await this._store.load();
    this._scheduleReaper();
  }

  /**
   * Cancel the reaper and gracefully shut down all live rpc instances.
   * @returns {Promise<void>}
   */
  async stop() {
    this._cancelReaper();

    const keys = Array.from(this._live.keys());
    await Promise.allSettled(
      keys.map((key) => this._shutdownRpc(key, { removeFromStore: false })),
    );
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Return the live SynapsRpc for the given tuple, creating one if needed.
   * Race-safe: concurrent calls for the same key all wait on the same promise.
   *
   * @param {{ source: string, conversation: string, thread: string, model?: string|null }} opts
   * @returns {Promise<import("node:events").EventEmitter>}
   */
  async getOrCreateSession({ source, conversation, thread, model = null }) {
    const key = sessionKey({ source, conversation, thread });

    // 1. Already live.
    if (this._live.has(key)) {
      return this._live.get(key);
    }

    // 2. Another concurrent call is already constructing this key.
    if (this._pending.has(key)) {
      return this._pending.get(key);
    }

    // 3. We are the first caller — create and register the pending promise.
    const promise = this._createSession({ key, source, conversation, thread, model });
    this._pending.set(key, promise);

    try {
      const rpc = await promise;
      return rpc;
    } finally {
      this._pending.delete(key);
    }
  }

  /**
   * Shut down the rpc for the given tuple and remove it from the live map.
   * The store record is kept (for future --continue resumption).
   *
   * @param {{ source: string, conversation: string, thread: string }} opts
   * @returns {Promise<void>}
   */
  async closeSession({ source, conversation, thread }) {
    const key = sessionKey({ source, conversation, thread });
    await this._shutdownRpc(key, { removeFromStore: false });
  }

  /**
   * Update lastActiveAt for the given key.  Call this after each successful
   * prompt completion.
   *
   * @param {string} key - The string returned by sessionKey().
   * @returns {Promise<void>}
   */
  async recordActivity(key) {
    this._lastActive.set(key, this._nowMs());
    await this._store.touch(key);
  }

  /**
   * Return an array of all currently-live sessions.
   * @returns {Array<{ key: string, rpc: import("node:events").EventEmitter }>}
   */
  liveSessions() {
    return Array.from(this._live.entries()).map(([key, rpc]) => ({ key, rpc }));
  }

  /**
   * Return enriched metadata for all currently-live sessions by merging the
   * live map with persisted store records.  Used by the control socket `threads`
   * op and any observer that needs more than just the rpc handle.
   *
   * Fields returned per entry:
   *   key, source, conversation, thread, model, sessionId,
   *   lastActiveAt (epoch ms), inFlight (boolean)
   *
   * @returns {Promise<Array<{
   *   key: string,
   *   source: string,
   *   conversation: string,
   *   thread: string,
   *   model: string|null,
   *   sessionId: string|null,
   *   lastActiveAt: number,
   *   inFlight: boolean,
   * }>>}
   */
  async listSessions() {
    const storeMap = await this._store.load();
    const results = [];

    for (const [key, rpc] of this._live.entries()) {
      const rec = storeMap.get(key);
      const inFlight = typeof rpc.inFlight === 'boolean' ? rpc.inFlight : false;
      results.push({
        key,
        source:       rec?.source       ?? '',
        conversation: rec?.conversation ?? '',
        thread:       rec?.thread       ?? '',
        model:        rec?.model        ?? null,
        sessionId:    rec?.sessionId    ?? null,
        lastActiveAt: this._lastActive.get(key) ?? rec?.lastActiveAt ?? 0,
        inFlight,
      });
    }

    return results;
  }

  /**
   * Close any live rpcs that have been idle for longer than idleTtlMs.
   * Reaped sessions stay in the store; next access spawns with --continue.
   *
   * @returns {Promise<void>}
   */
  async reapIdle() {
    const now = this._nowMs();
    const cutoff = now - this._idleTtlMs;

    const toReap = [];
    for (const [key] of this._live) {
      const last = this._lastActive.get(key) ?? 0;
      if (last < cutoff) {
        toReap.push(key);
      }
    }

    await Promise.allSettled(
      toReap.map(async (key) => {
        await this._shutdownRpc(key, { removeFromStore: false });
        this.emit("session_reaped", { key });
      }),
    );
  }

  // ── internal: session creation ────────────────────────────────────────────

  /**
   * @param {{ key: string, source: string, conversation: string, thread: string, model: string|null }} opts
   * @returns {Promise<import("node:events").EventEmitter>}
   */
  async _createSession({ key, source, conversation, thread, model }) {
    // Load persisted record (if any) to pick up sessionId for --continue.
    const map = await this._store.load();
    const existing = map.get(key);
    const sessionId = existing?.sessionId ?? null;
    const effectiveModel = model ?? existing?.model ?? null;

    const rpc = this._rpcFactory({
      sessionId,
      model: effectiveModel,
      logger: this.logger,
    });

    // Start and await ready.
    let readyInfo;
    try {
      readyInfo = await rpc.start();
    } catch (err) {
      throw err;
    }

    // Persist/update store record.
    const now = this._nowMs();
    await this._store.upsert({
      key,
      source,
      conversation,
      thread,
      sessionId: readyInfo.sessionId,
      model: readyInfo.model,
      createdAt: existing?.createdAt ?? now,
      lastActiveAt: now,
    });

    // Track live state.
    this._live.set(key, rpc);
    this._lastActive.set(key, now);

    this.emit("session_started", {
      key,
      sessionId: readyInfo.sessionId,
      model: readyInfo.model,
    });

    // Subscribe to unexpected exit for auto-restart.
    rpc.once("exit", ({ code, signal }) => {
      this._onRpcExit({ key, source, conversation, thread, rpc, code, signal });
    });

    return rpc;
  }

  // ── internal: exit / restart ──────────────────────────────────────────────

  /**
   * @param {{ key: string, source: string, conversation: string, thread: string, rpc: object, code: number|null, signal: string|null }} opts
   */
  async _onRpcExit({ key, source, conversation, thread, rpc, code, signal }) {
    // Remove the dead instance from live map immediately.
    if (this._live.get(key) === rpc) {
      this._live.delete(key);
    }

    // Graceful shutdown (code 0) — nothing to do.
    if (code === 0) return;

    this.logger.warn(
      `SessionRouter: rpc for key=${key} exited unexpectedly (code=${code} signal=${signal}); attempting restart`,
    );

    // Load the persisted sessionId for --continue.
    let sessionId = null;
    try {
      const map = await this._store.load();
      sessionId = map.get(key)?.sessionId ?? null;
    } catch {
      // ignore
    }

    // One restart attempt.
    const effectiveModel = null; // store will supply model via existing record
    const newRpc = this._rpcFactory({
      sessionId,
      model: effectiveModel,
      logger: this.logger,
    });

    let readyInfo;
    try {
      readyInfo = await newRpc.start();
    } catch (err) {
      this.logger.warn(`SessionRouter: restart failed for key=${key}: ${err.message}`);
      this.emit("session_failed", { key, error: err });
      return;
    }

    // Persist updated sessionId.
    try {
      const now = this._nowMs();
      await this._store.upsert({
        key,
        source,
        conversation,
        thread,
        sessionId: readyInfo.sessionId,
        model: readyInfo.model,
        lastActiveAt: now,
      });
    } catch {
      // best-effort
    }

    this._live.set(key, newRpc);
    this._lastActive.set(key, this._nowMs());

    this.emit("session_restarted", {
      key,
      sessionId: readyInfo.sessionId,
    });

    // Re-subscribe for further unexpected exits.
    newRpc.once("exit", ({ code: c2, signal: s2 }) => {
      // Second exit: if non-zero, emit failed and clean up.
      if (this._live.get(key) === newRpc) {
        this._live.delete(key);
      }
      if (c2 !== 0) {
        const err = new Error(`rpc child exited twice unexpectedly: code=${c2}`);
        this.emit("session_failed", { key, error: err });
      }
    });
  }

  // ── internal: shutdown a single key ──────────────────────────────────────

  /**
   * @param {string} key
   * @param {{ removeFromStore: boolean }} opts
   * @returns {Promise<void>}
   */
  async _shutdownRpc(key, { removeFromStore }) {
    const rpc = this._live.get(key);
    this._live.delete(key);
    this._lastActive.delete(key);

    if (rpc) {
      try {
        // Remove the exit listener to prevent restart logic on intentional shutdown.
        rpc.removeAllListeners("exit");
        if (typeof rpc.shutdown === "function") {
          await rpc.shutdown();
        }
      } catch (err) {
        this.logger.warn(`SessionRouter: error shutting down rpc for key=${key}: ${err.message}`);
      }
    }

    if (removeFromStore) {
      try {
        await this._store.remove(key);
      } catch {
        // best-effort
      }
    }
  }

  // ── internal: reaper scheduling ───────────────────────────────────────────

  _scheduleReaper() {
    this._cancelReaper();
    this._reapTimer = setInterval(async () => {
      try {
        await this.reapIdle();
      } catch (err) {
        this.logger.warn(`SessionRouter: reaper error: ${err.message}`);
      }
    }, this._reapIntervalMs);

    // Allow the Node process to exit even if the timer is still armed.
    if (this._reapTimer.unref) this._reapTimer.unref();
  }

  _cancelReaper() {
    if (this._reapTimer) {
      clearInterval(this._reapTimer);
      this._reapTimer = null;
    }
  }
}
