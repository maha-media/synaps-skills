/**
 * @file bridge/core/hook-bus.js
 *
 * HookBus — dispatches lifecycle hook events to registered webhooks.
 *
 * HookBus
 *   - Accepts a duck-typed repo `{ listByEvent({event, scope}) }`
 *   - Dispatches matching enabled hooks in parallel with Promise.allSettled
 *   - HMAC-signs every request: X-Synaps-Signature: sha256=<hex>
 *   - Per-call timeout via AbortController + injectable setTimeout/clearTimeout
 *   - Returns aggregate: { fired, blocked, results }
 *
 * NoopHookBus
 *   - emit() resolves to { fired: 0, blocked: false, results: [] }
 *   - Used when hooks feature is disabled.
 *
 * ─── Cardinal rules ──────────────────────────────────────────────────────────
 * • ESM only (import/export)
 * • No top-level await
 * • No I/O in constructors
 * • No slack/synaps imports (this is core)
 * • SECRETS NEVER APPEAR IN LOGS OR RETURNED DATA
 */

import { createHmac } from 'node:crypto';

// ─── Error classes ────────────────────────────────────────────────────────────

/**
 * Thrown when a hook configuration is invalid (missing url, non-https, missing secret).
 * @property {string} code - always `'invalid_request'`
 */
export class HookValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HookValidationError';
    this.code = 'invalid_request';
  }
}

/**
 * Thrown when a webhook dispatch fails catastrophically (not a per-hook timeout/non-2xx).
 * @property {string} code - always `'hook_dispatch_error'`
 */
export class HookDispatchError extends Error {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'HookDispatchError';
    this.code = 'hook_dispatch_error';
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Valid lifecycle events. */
const VALID_EVENTS = new Set(['pre_tool', 'post_tool', 'pre_stream', 'post_stream', 'on_error']);

/** Scope ordering for priority (lower index = higher priority). */
const SCOPE_ORDER = { user: 0, institution: 1, global: 2 };

// ─── HookBus ──────────────────────────────────────────────────────────────────

export class HookBus {
  /**
   * @param {object}   opts
   * @param {object}   opts.repo               - duck-typed HookRepo { listByEvent({event, scope}) }
   * @param {Function} [opts.fetch]             - injectable fetch, defaults to globalThis.fetch
   * @param {Function} [opts.hmac]              - injectable HMAC fn (secret, body) => hex string
   * @param {number}   [opts.timeoutMs=5000]    - default per-hook request timeout in ms
   * @param {object}   [opts.logger]            - { info, warn, error, debug }
   * @param {Function} [opts.now]               - () => ISO string or epoch ms
   * @param {Function} [opts.setTimeout]        - injectable setTimeout
   * @param {Function} [opts.clearTimeout]      - injectable clearTimeout
   */
  constructor({
    repo,
    fetch: fetchImpl,
    hmac: hmacImpl,
    timeoutMs = 5000,
    logger,
    now,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
  } = {}) {
    if (!repo) {
      throw new TypeError('HookBus: repo is required');
    }

    this._repo = repo;
    this._fetch = fetchImpl ?? globalThis.fetch;
    this._hmac = hmacImpl ?? _defaultHmac;
    this._timeoutMs = timeoutMs;
    this._logger = logger ?? console;
    this._now = now ?? (() => new Date().toISOString());
    this._setTimeout = setTimeoutImpl ?? globalThis.setTimeout.bind(globalThis);
    this._clearTimeout = clearTimeoutImpl ?? globalThis.clearTimeout.bind(globalThis);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Emit a lifecycle event, dispatch to all matching hooks in parallel.
   *
   * @param {string} event   - lifecycle event name (pre_tool, post_tool, etc.)
   * @param {object} payload - event payload (tool name + args, etc.)
   * @param {object} [scope] - scope filter { type, id } — optional, matches all when omitted
   * @returns {Promise<{ fired: number, blocked: boolean, results: Array }>}
   */
  async emit(event, payload = {}, scope = null) {
    // Validate event name
    if (!VALID_EVENTS.has(event)) {
      throw new HookValidationError(
        `HookBus.emit: unknown event "${event}". Valid events: ${[...VALID_EVENTS].join(', ')}`,
      );
    }

    // Fetch matching hooks from repo
    let hooks;
    try {
      hooks = await this._repo.listByEvent({ event, scope });
    } catch (err) {
      throw new HookDispatchError(`HookBus: failed to list hooks for event "${event}": ${err.message}`, { cause: err });
    }

    if (!hooks || hooks.length === 0) {
      return { fired: 0, blocked: false, results: [] };
    }

    // Filter by matcher (tool / channel — both must match when set)
    const matched = hooks.filter(hook => this._matchesSelector(hook, payload));

    if (matched.length === 0) {
      return { fired: 0, blocked: false, results: [] };
    }

    // Sort by scope priority: user > institution > global
    const sorted = [...matched].sort((a, b) => {
      const aOrder = SCOPE_ORDER[a.scope?.type] ?? 99;
      const bOrder = SCOPE_ORDER[b.scope?.type] ?? 99;
      return aOrder - bOrder;
    });

    this._logger.info('HookBus.emit', {
      event,
      scope,
      hookCount: sorted.length,
    });

    // Dispatch all in parallel
    const ts = this._now();
    const body = { event, payload, scope, ts };

    const settlements = await Promise.allSettled(
      sorted.map(hook => this._dispatchOne(hook, body)),
    );

    // Aggregate results
    const results = settlements.map((settlement, idx) => {
      const hook = sorted[idx];
      if (settlement.status === 'fulfilled') {
        return { hookId: String(hook._id), ...settlement.value };
      }
      // Should not happen (dispatchOne catches internally), but handle defensively
      return {
        hookId: String(hook._id),
        ok: false,
        error: settlement.reason?.message ?? 'unknown error',
      };
    });

    const fired = results.filter(r => r.ok !== false || r.status !== undefined || r.error === 'timeout').length;
    const blocked = results.some(r => r.blocked === true);

    return {
      fired: sorted.length,
      blocked,
      results,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Check whether a hook's matcher selectors match the given payload.
   * @private
   */
  _matchesSelector(hook, payload) {
    const matcher = hook.matcher ?? {};

    // tool matcher: exact match on payload.tool when specified
    if (matcher.tool !== undefined && matcher.tool !== null && matcher.tool !== '') {
      if (payload.tool !== matcher.tool) {
        return false;
      }
    }

    // channel matcher: exact match on payload.channel when specified
    if (matcher.channel !== undefined && matcher.channel !== null && matcher.channel !== '') {
      if (payload.channel !== matcher.channel) {
        return false;
      }
    }

    return true;
  }

  /**
   * Validate a single hook's action config before dispatch.
   * @private
   * @throws {HookValidationError}
   */
  _validateHookAction(hook) {
    const config = hook?.action?.config;

    if (!config) {
      throw new HookValidationError(`Hook ${hook._id}: action.config is missing`);
    }

    if (!config.url || typeof config.url !== 'string' || config.url.trim() === '') {
      throw new HookValidationError(`Hook ${hook._id}: action.config.url is required`);
    }

    // HTTPS only
    try {
      const parsed = new URL(config.url);
      if (parsed.protocol !== 'https:') {
        throw new HookValidationError(
          `Hook ${hook._id}: action.config.url must use https (got "${parsed.protocol}")`,
        );
      }
    } catch (err) {
      if (err instanceof HookValidationError) throw err;
      throw new HookValidationError(`Hook ${hook._id}: action.config.url is not a valid URL: ${err.message}`);
    }

    if (!config.secret || typeof config.secret !== 'string' || config.secret.trim() === '') {
      throw new HookValidationError(`Hook ${hook._id}: action.config.secret is required`);
    }
  }

  /**
   * Dispatch a single hook, returning a result object (never throws).
   * @private
   */
  async _dispatchOne(hook, body) {
    // Validate before dispatch
    try {
      this._validateHookAction(hook);
    } catch (err) {
      // Log sanitized — no secret
      this._logger.warn('HookBus: hook validation failed', {
        hookId: String(hook._id),
        event: body.event,
        url: hook?.action?.config?.url,
        error: err.message,
      });
      return { hookId: String(hook._id), ok: false, error: err.message };
    }

    const config = hook.action.config;
    const timeoutMs = config.timeout_ms ?? this._timeoutMs;
    const bodyStr = JSON.stringify(body);
    const signature = this._hmac(config.secret, bodyStr);

    // Sanitized log — never include config.secret
    this._logger.debug('HookBus: dispatching webhook', {
      hookId: String(hook._id),
      event: body.event,
      url: config.url,
      timeoutMs,
    });

    const controller = new AbortController();
    let timer;

    const timeoutPromise = new Promise((_, reject) => {
      timer = this._setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error('timeout'), { isTimeout: true }));
      }, timeoutMs);
    });

    try {
      const fetchPromise = this._fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Synaps-Signature': `sha256=${signature}`,
        },
        body: bodyStr,
        signal: controller.signal,
      });

      const response = await Promise.race([fetchPromise, timeoutPromise]);

      this._clearTimeout(timer);

      const status = response.status;
      const ok = status >= 200 && status < 300;

      let responseBody = null;
      try {
        const text = await response.text();
        if (text) {
          try {
            responseBody = JSON.parse(text);
          } catch {
            responseBody = text;
          }
        }
      } catch {
        // ignore body parse errors
      }

      // Check for block: true in response body (for pre_tool / pre_stream)
      const blocked = ok && typeof responseBody === 'object' && responseBody !== null
        ? responseBody.block === true
        : false;

      this._logger.debug('HookBus: webhook response', {
        hookId: String(hook._id),
        event: body.event,
        url: config.url,
        status,
        ok,
        blocked,
      });

      return {
        hookId: String(hook._id),
        ok,
        status,
        ...(blocked ? { blocked: true } : {}),
        ...(!ok ? { error: `HTTP ${status}` } : {}),
      };

    } catch (err) {
      this._clearTimeout(timer);

      if (err.isTimeout || err.name === 'AbortError' || err.message === 'timeout') {
        this._logger.warn('HookBus: webhook timed out', {
          hookId: String(hook._id),
          event: body.event,
          url: config.url,
          timeoutMs,
        });
        return { hookId: String(hook._id), ok: false, error: 'timeout' };
      }

      this._logger.warn('HookBus: webhook dispatch error', {
        hookId: String(hook._id),
        event: body.event,
        url: config.url,
        error: err.message,
      });
      return { hookId: String(hook._id), ok: false, error: err.message };
    }
  }
}

// ─── NoopHookBus ──────────────────────────────────────────────────────────────

/**
 * Drop-in replacement for HookBus used when the hooks feature is disabled.
 * emit() always resolves to an empty summary.
 */
export class NoopHookBus {
  /**
   * @returns {Promise<{ fired: 0, blocked: false, results: [] }>}
   */
  // eslint-disable-next-line no-unused-vars
  async emit(..._args) {
    return { fired: 0, blocked: false, results: [] };
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Default HMAC implementation using Node.js builtin crypto.
 * @param {string} secret - HMAC key
 * @param {string} body   - already-serialised JSON string
 * @returns {string} hex digest
 */
function _defaultHmac(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}
