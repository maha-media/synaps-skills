/**
 * @file bridge/core/memory-gateway.js
 *
 * Per-tenant routing layer over the axel memory transport.
 *
 * MemoryGateway
 *   - Maps a synapsUserId → namespace (`u_<id>` by default)
 *   - Maps a namespace → brainPath (`<brainDir>/<namespace>.r8`)
 *   - Lazy-inits the brain on first use via client.init()
 *   - Exposes recall / store / consolidate
 *   - Never throws from recall or store (best-effort)
 *
 * NoopMemoryGateway
 *   - Same interface, all methods are immediate no-ops.
 *   - Used when memory.enabled = false.
 *
 * ─── Cardinal rules ──────────────────────────────────────────────────────────
 * • ESM only (import/export)
 * • No top-level await
 * • No I/O in constructors
 * • No slack/source imports (this is core)
 */

import path from 'node:path';
import os from 'node:os';

// ─── MemoryGateway ────────────────────────────────────────────────────────────

export class MemoryGateway {
  /**
   * @param {object}  opts
   * @param {object}  opts.client             - AxelCliClient instance (required)
   * @param {string}  opts.brainDir           - Directory that holds per-user .r8 files.
   *                                            A leading `~/` is expanded to os.homedir().
   * @param {number}  [opts.recallK=8]        - Top-K for search queries
   * @param {number}  [opts.recallMinScore=0] - Filter out results below this score
   * @param {number}  [opts.recallMaxChars=2000] - Char cap on formatted recall summary
   * @param {string}  [opts.namespacePrefix='u_'] - Prefix prepended to synapsUserId
   * @param {object}  [opts.logger=console]   - Injected logger
   */
  constructor({
    client,
    brainDir,
    recallK = 8,
    recallMinScore = 0.0,
    recallMaxChars = 2000,
    namespacePrefix = 'u_',
    logger = console,
  } = {}) {
    if (!client) {
      throw new TypeError('MemoryGateway: client is required');
    }

    if (typeof brainDir !== 'string' || brainDir.length === 0) {
      throw new TypeError('MemoryGateway: brainDir must be a non-empty string');
    }

    // Expand leading tilde.
    const resolvedBrainDir = brainDir.startsWith('~/')
      ? path.join(os.homedir(), brainDir.slice(2))
      : brainDir;

    this._client = client;
    this._brainDir = resolvedBrainDir;
    this._recallK = recallK;
    this._recallMinScore = recallMinScore;
    this._recallMaxChars = recallMaxChars;
    this._namespacePrefix = namespacePrefix;
    this._logger = logger;

    /**
     * Set of namespace strings that have already been initialised.
     * @type {Set<string>}
     */
    this._initialised = new Set();
  }

  // ── Public helpers ──────────────────────────────────────────────────────────

  /**
   * Return the stable namespace string for a given synapsUserId.
   *
   * @param {string} synapsUserId
   * @returns {string}
   */
  namespaceFor(synapsUserId) {
    if (typeof synapsUserId !== 'string' || synapsUserId.length === 0) {
      throw new TypeError('synapsUserId must be a non-empty string');
    }
    return `${this._namespacePrefix}${synapsUserId}`;
  }

  /**
   * Return the absolute brain path for a given synapsUserId.
   *
   * @param {string} synapsUserId
   * @returns {string}
   */
  brainPathFor(synapsUserId) {
    const ns = this.namespaceFor(synapsUserId);
    return path.join(this._brainDir, `${ns}.r8`);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** No-op — provided for symmetry with NoopMemoryGateway. */
  async start() { /* intentional no-op */ }

  /** No-op — provided for symmetry with NoopMemoryGateway. */
  async stop()  { /* intentional no-op */ }

  /** @returns {true} */
  get enabled() { return true; }

  // ── Core operations ─────────────────────────────────────────────────────────

  /**
   * Search a user's brain for relevant context.
   *
   * Returns a single formatted summary string (bullet lines joined by `\n`),
   * capped at `recallMaxChars`.  Returns `null` if there are no usable
   * results, or if any error occurs — recall MUST NEVER throw.
   *
   * @param {string} synapsUserId
   * @param {string} query
   * @returns {Promise<string|null>}
   */
  async recall(synapsUserId, query) {
    // Guard: empty / non-string query → skip immediately.
    if (typeof query !== 'string' || query.trim().length === 0) {
      return null;
    }

    try {
      const brainPath = this.brainPathFor(synapsUserId);
      await this._ensureInit(synapsUserId, brainPath);

      const results = await this._client.search(brainPath, query, { k: this._recallK });

      if (!Array.isArray(results) || results.length === 0) {
        return null;
      }

      // Sort by score descending (defensive — CLI may already sort).
      const sorted = results
        .slice()
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      // Filter by minimum score.
      const filtered = sorted.filter(r => (r.score ?? 0) >= this._recallMinScore);

      if (filtered.length === 0) {
        return null;
      }

      // Build formatted summary, respecting the char cap.
      const lines = [];
      let totalChars = 0;

      for (const result of filtered) {
        const line = `- ${result.content}`;
        // +1 for the '\n' separator between lines (except first).
        const addedLen = lines.length === 0 ? line.length : line.length + 1;
        if (totalChars + addedLen > this._recallMaxChars) {
          break;
        }
        lines.push(line);
        totalChars += addedLen;
      }

      if (lines.length === 0) {
        return null;
      }

      return lines.join('\n');
    } catch (err) {
      this._logger.warn(`MemoryGateway.recall: ${err.message}`);
      return null;
    }
  }

  /**
   * Persist a memory entry for a user.
   *
   * Returns `{ ok: true }` on success, `{ ok: false, error }` on failure.
   * MUST NEVER throw — best-effort persistence.
   *
   * @param {string} synapsUserId
   * @param {string} text
   * @param {object} [metadata={}]
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async store(synapsUserId, text, metadata = {}) {
    // Guard: empty / non-string text.
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { ok: false, error: 'empty text' };
    }

    try {
      const brainPath = this.brainPathFor(synapsUserId);
      await this._ensureInit(synapsUserId, brainPath);

      // Forward only the fields axel understands.
      const memOpts = {};
      if (metadata.category !== undefined) memOpts.category = metadata.category;
      if (metadata.topic    !== undefined) memOpts.topic    = metadata.topic;
      if (metadata.title    !== undefined) memOpts.title    = metadata.title;

      await this._client.remember(brainPath, text, memOpts);
      return { ok: true };
    } catch (err) {
      this._logger.warn(`MemoryGateway.store: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Run axel consolidate for a user.
   * Errors propagate — callers (e.g. cron) need to know about failures.
   *
   * @param {string} synapsUserId
   * @param {object} [opts={}]
   * @returns {Promise<object>}
   */
  async consolidate(synapsUserId, opts = {}) {
    const brainPath = this.brainPathFor(synapsUserId);
    await this._ensureInit(synapsUserId, brainPath);
    return this._client.consolidate(brainPath, opts);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Lazily initialise the brain file for the given user.
   * On success, marks the namespace as done so subsequent calls skip init.
   * On failure, logs a warning but does NOT mark as done (so the next call
   * will retry).
   *
   * @private
   * @param {string} synapsUserId
   * @param {string} brainPath
   * @returns {Promise<void>}
   */
  async _ensureInit(synapsUserId, brainPath) {
    const ns = this.namespaceFor(synapsUserId);
    if (this._initialised.has(ns)) {
      return;
    }

    try {
      await this._client.init(brainPath, { name: ns });
      this._initialised.add(ns);
    } catch (err) {
      this._logger.warn(`MemoryGateway._ensureInit(${ns}): ${err.message}`);
      // Do NOT add to _initialised — let the next call retry.
    }
  }
}

// ─── NoopMemoryGateway ────────────────────────────────────────────────────────

/**
 * Drop-in replacement for MemoryGateway used when memory is disabled.
 * All methods are immediate no-ops — no client required.
 */
export class NoopMemoryGateway {
  async recall()       { return null; }
  async store()        { return { ok: true, noop: true }; }
  async consolidate()  { return { ok: true, noop: true }; }
  async start()        {}
  async stop()         {}

  /**
   * @param {string} id
   * @returns {string}
   */
  namespaceFor(id) { return `u_${id}`; }

  /**
   * Always returns null — no brain files when memory is disabled.
   * @returns {null}
   */
  brainPathFor() { return null; }

  /** @returns {false} */
  get enabled() { return false; }
}
