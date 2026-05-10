/**
 * @file bridge/core/session-store.js
 *
 * Atomic-write JSON persistence for bridge session metadata.
 * Stores records at ~/.synaps-cli/bridge/sessions.json.
 *
 * Pure I/O module — no SynapsRpc references, no spawning.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { sessionKey } from "./helpers.js";

/**
 * @typedef {Object} SessionRecord
 * @property {string}      key           - sessionKey({source, conversation, thread})
 * @property {string}      source
 * @property {string}      conversation
 * @property {string}      thread
 * @property {string|null} sessionId     - synaps session id, set after first ready
 * @property {string|null} model
 * @property {number}      createdAt     - epoch ms
 * @property {number}      lastActiveAt  - epoch ms
 */

/**
 * Default store path.
 * @type {string}
 */
const DEFAULT_STORE_PATH = path.join(
  os.homedir(),
  ".synaps-cli",
  "bridge",
  "sessions.json",
);

export class SessionStore {
  /**
   * @param {object}   [opts]
   * @param {string}   [opts.storePath]   - Path to the sessions JSON file.
   * @param {object}   [opts.fsImpl]      - fs.promises implementation (injectable for tests).
   * @param {object}   [opts.logger]      - Logger (default: console).
   * @param {Function} [opts.nowMs]       - Returns current epoch ms (injectable for tests).
   */
  constructor({
    storePath = DEFAULT_STORE_PATH,
    fsImpl = fs,
    logger = console,
    nowMs = () => Date.now(),
  } = {}) {
    this._storePath = storePath;
    this._fs = fsImpl;
    this.logger = logger;
    this._nowMs = nowMs;

    /**
     * Serialise writes: each write waits for the previous one to finish so
     * concurrent calls don't clobber each other's work.
     * @type {Promise<void>}
     */
    this._writeChain = Promise.resolve();
  }

  // ── I/O helpers ─────────────────────────────────────────────────────────────

  /**
   * Read the sessions file and return a Map<key, SessionRecord>.
   * A missing file returns an empty Map; a malformed file logs a warning
   * and returns an empty Map.
   *
   * @returns {Promise<Map<string, SessionRecord>>}
   */
  async load() {
    let raw;
    try {
      raw = await this._fs.readFile(this._storePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        return new Map();
      }
      this.logger.warn(`SessionStore: failed to read ${this._storePath}: ${err.message}`);
      return new Map();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn(`SessionStore: malformed JSON in ${this._storePath}: ${err.message}`);
      return new Map();
    }

    // Accept both array and object-as-map serialization formats.
    const records = Array.isArray(parsed) ? parsed : Object.values(parsed);
    const map = new Map();
    for (const rec of records) {
      if (rec && rec.key) {
        map.set(rec.key, rec);
      }
    }
    return map;
  }

  /**
   * Atomically write a Map<key, SessionRecord> to disk.
   *
   * Pattern: write → tmp, fsync, rename.  If fsync is unavailable (minimal
   * mock in tests), logs a warning and continues.
   *
   * @param {Map<string, SessionRecord>} records
   * @returns {Promise<void>}
   */
  async save(records) {
    const serialized = Array.from(records.values());
    const dir = path.dirname(this._storePath);
    const tmp = `${this._storePath}.tmp.${process.pid}.${Math.random()
      .toString(36)
      .slice(2)}`;

    await this._fs.mkdir(dir, { recursive: true });
    await this._fs.writeFile(tmp, JSON.stringify(serialized, null, 2), {
      mode: 0o600,
    });

    // fsync — gracefully degrade if open/sync/close are absent (test mocks).
    let fh;
    try {
      fh = await this._fs.open(tmp, "r+");
    } catch {
      this.logger.warn("SessionStore: fsImpl.open unavailable — skipping fsync");
    }
    if (fh) {
      try {
        await fh.sync();
      } catch {
        this.logger.warn("SessionStore: fh.sync unavailable — skipping fsync");
      }
      try {
        await fh.close();
      } catch {
        // best-effort
      }
    }

    await this._fs.rename(tmp, this._storePath);
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  /**
   * Insert or merge-update a record.
   * - On insert: stamps `createdAt` and `lastActiveAt` if absent.
   * - On update: preserves `createdAt`; merges all other supplied fields.
   *
   * Serialised internally so concurrent calls are safe within the same instance.
   *
   * @param {Partial<SessionRecord> & { source: string, conversation: string, thread: string }} record
   * @returns {Promise<SessionRecord>}
   */
  async upsert(record) {
    // Chain onto the previous write so concurrent calls serialise.
    let resolveChain;
    const prior = this._writeChain;
    this._writeChain = new Promise((res) => { resolveChain = res; });

    try {
      await prior; // wait for any in-flight write to finish
      return await this._doUpsert(record);
    } finally {
      resolveChain();
    }
  }

  /** @private */
  async _doUpsert(record) {
    const key =
      record.key ?? sessionKey({ source: record.source, conversation: record.conversation, thread: record.thread });
    const map = await this.load();
    const existing = map.get(key);
    const now = this._nowMs();

    const merged = {
      ...(existing ?? {}),
      ...record,
      key,
      createdAt: existing?.createdAt ?? record.createdAt ?? now,
      // lastActiveAt: caller may supply an explicit value; if not, stamp now.
      lastActiveAt: record.lastActiveAt !== undefined ? record.lastActiveAt : now,
    };

    map.set(key, merged);
    await this.save(map);
    return merged;
  }

  /**
   * Remove a record by key.  No-op if the key is absent.
   * Serialised via _writeChain.
   *
   * @param {string} key
   * @returns {Promise<void>}
   */
  async remove(key) {
    let resolveChain;
    const prior = this._writeChain;
    this._writeChain = new Promise((res) => { resolveChain = res; });
    try {
      await prior;
      const map = await this.load();
      if (!map.has(key)) return;
      map.delete(key);
      await this.save(map);
    } finally {
      resolveChain();
    }
  }

  /**
   * Update `lastActiveAt` to now for the given key.
   * No-op if the key is not present.
   * Serialised via _writeChain.
   *
   * @param {string} key
   * @returns {Promise<void>}
   */
  async touch(key) {
    let resolveChain;
    const prior = this._writeChain;
    this._writeChain = new Promise((res) => { resolveChain = res; });
    try {
      await prior;
      const map = await this.load();
      const rec = map.get(key);
      if (!rec) return;
      rec.lastActiveAt = this._nowMs();
      map.set(key, rec);
      await this.save(map);
    } finally {
      resolveChain();
    }
  }

  /**
   * Return all records as an array.
   *
   * @returns {Promise<SessionRecord[]>}
   */
  async list() {
    const map = await this.load();
    return Array.from(map.values());
  }

  /**
   * Return records whose `lastActiveAt` is older than `olderThanMs` ago.
   *
   * @param {{ olderThanMs: number }} opts
   * @returns {Promise<SessionRecord[]>}
   */
  async findIdle({ olderThanMs }) {
    const map = await this.load();
    const cutoff = this._nowMs() - olderThanMs;
    const idle = [];
    for (const rec of map.values()) {
      if (rec.lastActiveAt < cutoff) {
        idle.push(rec);
      }
    }
    return idle;
  }
}
