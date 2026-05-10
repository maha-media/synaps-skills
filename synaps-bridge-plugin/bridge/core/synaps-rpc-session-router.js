/**
 * @file bridge/core/synaps-rpc-session-router.js
 *
 * SynapsRpcSessionRouter — per-user MCP tool registry accessor.
 *
 * Wraps the existing SessionRouter (or a rpcFactory) to provide two new
 * methods needed by Phase 8 Track 2:
 *
 *   listTools(synapsUserId)
 *     → probes the user's `synaps rpc` subprocess with {"op":"tools_list"}
 *     → returns [] on any failure (synaps rpc does not yet implement the op)
 *
 *   callTool({ synapsUserId, name, args })
 *     → sends {"op":"tool_call","name","args"} to the subprocess
 *     → returns MCP-shape {content:[{type:"text",text}], isError:boolean}
 *
 * The probe is intentionally fault-tolerant so that Phase 8 ships safely
 * before the synaps-cli `tools_list` op lands (parallel watcher PR).
 */

// ─── SynapsRpcSessionRouter ───────────────────────────────────────────────────

export class SynapsRpcSessionRouter {
  /**
   * @param {object}   opts
   * @param {Function} opts.rpcFactory
   *   (synapsUserId: string) → Promise<RpcHandle>
   *   RpcHandle must expose:
   *     send(op: object) → Promise<object>  (resolves with the parsed response)
   * @param {number}   [opts.probeTimeoutMs=5_000]
   *   How long to wait for a tools_list response before returning [].
   * @param {number}   [opts.callTimeoutMs=60_000]
   *   How long to wait for a tool_call response before rejecting.
   * @param {number}   [opts.cacheTtlMs=30_000]
   *   How long (ms) to cache per-user tool lists to avoid re-probing.
   * @param {object}   [opts.logger=console]
   * @param {Function} [opts.now=Date.now]  — injectable for tests
   */
  constructor({
    rpcFactory,
    probeTimeoutMs = 5_000,
    callTimeoutMs = 60_000,
    cacheTtlMs = 30_000,
    logger = console,
    now = Date.now,
  } = {}) {
    if (typeof rpcFactory !== 'function') {
      throw new TypeError('SynapsRpcSessionRouter: rpcFactory must be a function');
    }

    this._rpcFactory = rpcFactory;
    this._probeTimeoutMs = probeTimeoutMs;
    this._callTimeoutMs = callTimeoutMs;
    this._cacheTtlMs = cacheTtlMs;
    this._logger = logger;
    this._now = now;

    /**
     * Per-user tool-list cache.
     * @type {Map<string, { tools: Array, expiresAt: number }>}
     */
    this._cache = new Map();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Probe the user's rpc workspace for its tool list.
   * Returns [] on any failure (timeout, unknown_op, parse error, network error).
   *
   * Results are cached per user for `cacheTtlMs` milliseconds so that
   * repeated tools/list calls do not restart or re-probe the rpc subprocess.
   *
   * @param {string} synapsUserId
   * @returns {Promise<Array<{name:string, description:string, inputSchema:object}>>}
   */
  async listTools(synapsUserId) {
    if (!synapsUserId) return [];

    // ── cache hit ──────────────────────────────────────────────────────────
    const cached = this._cache.get(synapsUserId);
    if (cached && this._now() < cached.expiresAt) {
      return cached.tools;
    }

    // ── probe ──────────────────────────────────────────────────────────────
    let handle;
    try {
      handle = await this._rpcFactory(synapsUserId);
    } catch (err) {
      this._logger.warn(
        `SynapsRpcSessionRouter.listTools: rpcFactory failed for ${synapsUserId}: ${err.message}`,
      );
      return [];
    }

    let response;
    try {
      response = await this._withTimeout(
        handle.send({ op: 'tools_list' }),
        this._probeTimeoutMs,
        'tools_list probe',
      );
    } catch (err) {
      this._logger.warn(
        `SynapsRpcSessionRouter.listTools: probe failed for ${synapsUserId}: ${err.message}`,
      );
      return [];
    }

    // ── validate response ─────────────────────────────────────────────────
    if (!response || response.ok !== true || !Array.isArray(response.tools)) {
      this._logger.warn(
        `SynapsRpcSessionRouter.listTools: unexpected response for ${synapsUserId}:`,
        response,
      );
      return [];
    }

    const tools = response.tools;

    // ── populate cache ────────────────────────────────────────────────────
    this._cache.set(synapsUserId, {
      tools,
      expiresAt: this._now() + this._cacheTtlMs,
    });

    return tools;
  }

  /**
   * Invoke a named tool in the user's rpc workspace.
   *
   * @param {object} opts
   * @param {string} opts.synapsUserId
   * @param {string} opts.name
   * @param {object} [opts.args={}]
   * @returns {Promise<{content: Array<{type:string, text:string}>, isError: boolean}>}
   */
  async callTool({ synapsUserId, name, args = {} }) {
    if (!synapsUserId) throw new Error('SynapsRpcSessionRouter.callTool: synapsUserId required');
    if (!name) throw new Error('SynapsRpcSessionRouter.callTool: name required');

    let handle;
    try {
      handle = await this._rpcFactory(synapsUserId);
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Failed to connect to rpc workspace: ${err.message}` }],
        isError: true,
      };
    }

    let response;
    try {
      response = await this._withTimeout(
        handle.send({ op: 'tool_call', name, args }),
        this._callTimeoutMs,
        `tool_call:${name}`,
      );
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Tool call failed: ${err.message}` }],
        isError: true,
      };
    }

    // ── success ───────────────────────────────────────────────────────────
    if (response && response.ok === true) {
      const text =
        typeof response.result === 'string'
          ? response.result
          : response.result?.text != null
            ? response.result.text
            : JSON.stringify(response.result ?? null);

      return {
        content: [{ type: 'text', text }],
        isError: false,
      };
    }

    // ── error from rpc ────────────────────────────────────────────────────
    const errMsg =
      response?.error ?? response?.message ?? 'Unknown error from rpc workspace';

    return {
      content: [{ type: 'text', text: errMsg }],
      isError: true,
    };
  }

  /**
   * Invalidate the cached tool list for a user (e.g. after workspace restart).
   *
   * @param {string} synapsUserId
   */
  invalidateCache(synapsUserId) {
    this._cache.delete(synapsUserId);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Race a promise against a timeout.
   *
   * @param {Promise<*>} promise
   * @param {number}     ms
   * @param {string}     label      — used in the timeout error message
   * @returns {Promise<*>}
   */
  _withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`SynapsRpcSessionRouter: ${label} timed out after ${ms}ms`));
      }, ms);

      // Don't keep the event loop alive for the timeout alone.
      if (typeof t.unref === 'function') t.unref();

      promise.then(
        (val) => { clearTimeout(t); resolve(val); },
        (err) => { clearTimeout(t); reject(err); },
      );
    });
  }
}
