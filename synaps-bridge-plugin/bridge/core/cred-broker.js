/**
 * @file bridge/core/cred-broker.js
 *
 * Result-proxy credential broker.
 *
 * CredBroker
 *   - Accepts a duck-typed infisicalClient `{ getSecret({institutionId,synapsUserId,key}), ping() }`
 *   - Fetches a token on behalf of the caller, signs the request server-side,
 *     and returns only the HTTP response — the token never crosses the return boundary.
 *   - Caches the last-known-good token per (institutionId, synapsUserId, key) for
 *     `cacheTtlSecs` (default 300 s) with a graceful-degradation window of 2× TTL
 *     on Infisical outage.
 *
 * NoopCredBroker
 *   - Same public API surface.
 *   - Every `use()` call throws `CredBrokerDisabledError`.
 *   - Used when `creds.enabled = false` (default).
 *
 * ─── Cardinal rules ──────────────────────────────────────────────────────────
 * • ESM only (import/export)
 * • No top-level await
 * • No I/O in constructors
 * • No slack/source imports (this is core)
 * • TOKENS NEVER APPEAR IN LOGS OR RETURNED DATA
 */

// ─── Error classes ────────────────────────────────────────────────────────────

/**
 * Thrown when caller-supplied arguments are malformed.
 * @property {string} code - always `'invalid_request'`
 */
export class CredsValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredsValidationError';
    this.code = 'invalid_request';
  }
}

/**
 * Thrown when the token could not be obtained and there is no usable cache.
 * @property {string} code - always `'creds_unavailable'`
 */
export class CredsUnavailableError extends Error {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'CredsUnavailableError';
    this.code = 'creds_unavailable';
  }
}

/**
 * Thrown by NoopCredBroker on every `use()` call (creds feature is off).
 * @property {string} code - always `'creds_disabled'`
 */
export class CredBrokerDisabledError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredBrokerDisabledError';
    this.code = 'creds_disabled';
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** HTTP methods accepted by the broker (validated case-insensitively). */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']);

// ─── CredBroker ───────────────────────────────────────────────────────────────

export class CredBroker {
  /**
   * @param {object}   opts
   * @param {object}   opts.infisicalClient          - duck-typed { getSecret({institutionId,synapsUserId,key}), ping() }
   * @param {number}   [opts.cacheTtlSecs=300]        - last-known-good cache window (seconds)
   * @param {Function} [opts.fetch]                   - injectable fetch, defaults to globalThis.fetch
   * @param {object}   [opts.logger]                  - { info, warn, error, debug }
   * @param {Function} [opts.now]                     - () => number (ms epoch), injectable for tests
   */
  constructor({ infisicalClient, cacheTtlSecs = 300, fetch: fetchImpl, logger, now } = {}) {
    if (!infisicalClient) {
      throw new TypeError('CredBroker: infisicalClient is required');
    }

    this._client = infisicalClient;
    this._cacheTtlMs = cacheTtlSecs * 1000;
    this._fetch = fetchImpl ?? globalThis.fetch;
    this._logger = logger ?? console;
    this._now = now ?? (() => Date.now());

    /**
     * Cache keyed by `${institutionId}:${synapsUserId}:${key}`.
     * @type {Map<string, { value: string, cachedAt: number }>}
     */
    this._cache = new Map();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Result-proxy fetch: resolve the token, sign the request, forward it, and
   * return only the HTTP response — token never crosses the return boundary.
   *
   * @param {object}            args
   * @param {string}            args.synapsUserId
   * @param {string}            args.institutionId
   * @param {string}            args.key
   * @param {object}            args.request
   * @param {string}            args.request.method        - GET|POST|PUT|DELETE|PATCH|HEAD (case-insensitive)
   * @param {string}            args.request.url
   * @param {object}            [args.request.headers]
   * @param {string|Uint8Array} [args.request.body]
   * @returns {Promise<{ status:number, headers:object, body:string, cached:boolean, fetchedAt:number }>}
   * @throws {CredsValidationError|CredBrokerDisabledError|CredsUnavailableError}
   */
  async use({ synapsUserId, institutionId, key, request } = {}) {
    // ── 1. Validate ──────────────────────────────────────────────────────────
    this._validate({ synapsUserId, institutionId, key, request });

    const method = request.method.toUpperCase();
    const t0 = this._now();

    this._logger.info(
      'CredBroker.use',
      { synapsUserId, institutionId, key, method, url: request.url },
    );

    // ── 2. Token lookup with cache ───────────────────────────────────────────
    const cacheKey = `${institutionId}:${synapsUserId}:${key}`;
    const { token, cached } = await this._resolveToken({ cacheKey, synapsUserId, institutionId, key });

    // ── 3. Inject Authorization (overwrite any caller-supplied variant) ──────
    // Strip every case variant of 'authorization' before injecting ours.
    const cleanedHeaders = {};
    for (const [hk, hv] of Object.entries(request.headers ?? {})) {
      if (hk.toLowerCase() !== 'authorization') {
        cleanedHeaders[hk] = hv;
      }
    }

    const headers = {
      ...cleanedHeaders,
      Accept: request.headers?.Accept ?? cleanedHeaders['accept'] ?? 'application/json',
      Authorization: `Bearer ${token}`,
    };

    // ── 4. Forward request ───────────────────────────────────────────────────
    let response;
    try {
      response = await this._fetch(request.url, {
        method,
        headers,
        body: request.body,
      });
    } catch (err) {
      // Token stays cached — the upstream network failure is not the token's fault.
      throw new CredsUnavailableError('upstream request failed', { cause: err });
    }

    // ── 5. Capture response ──────────────────────────────────────────────────
    const status = response.status;
    const respHeaders = Object.fromEntries(response.headers.entries());
    const body = await response.text();
    const fetchedAt = this._now();

    this._logger.debug('CredBroker.use complete', {
      synapsUserId, institutionId, key,
      cached,
      status,
      duration_ms: fetchedAt - t0,
    });

    // ── 6. Return — token is NOT in this object ──────────────────────────────
    return { status, headers: respHeaders, body, cached, fetchedAt };
  }

  /**
   * Health check — proxies to infisicalClient.ping().
   * @returns {Promise<{ ok:boolean, broker:string, status?:number, error?:string }>}
   */
  async ping() {
    try {
      const result = await this._client.ping();
      return { ok: true, broker: 'infisical', ...result };
    } catch (err) {
      return { ok: false, broker: 'infisical', error: err.message };
    }
  }

  /**
   * Clear in-memory token cache (call on shutdown / SIGHUP).
   */
  clear() {
    this._cache.clear();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Validate all required inputs for `use()`.
   * @private
   */
  _validate({ synapsUserId, institutionId, key, request }) {
    if (typeof synapsUserId !== 'string' || synapsUserId.length === 0) {
      throw new CredsValidationError('synapsUserId must be a non-empty string');
    }
    if (typeof institutionId !== 'string' || institutionId.length === 0) {
      throw new CredsValidationError('institutionId must be a non-empty string');
    }
    if (typeof key !== 'string' || key.length === 0) {
      throw new CredsValidationError('key must be a non-empty string');
    }
    if (!request || typeof request !== 'object') {
      throw new CredsValidationError('request must be an object');
    }
    if (typeof request.method !== 'string' || !ALLOWED_METHODS.has(request.method.toUpperCase())) {
      throw new CredsValidationError(
        `request.method must be one of ${[...ALLOWED_METHODS].join('|')} (got ${JSON.stringify(request.method)})`,
      );
    }
    if (typeof request.url !== 'string' || request.url.length === 0) {
      throw new CredsValidationError('request.url must be a non-empty string');
    }
    if (request.headers !== undefined && (typeof request.headers !== 'object' || Array.isArray(request.headers))) {
      throw new CredsValidationError('request.headers must be a plain object when provided');
    }
    if (
      request.body !== undefined &&
      typeof request.body !== 'string' &&
      !(request.body instanceof Uint8Array)
    ) {
      throw new CredsValidationError('request.body must be a string or Uint8Array when provided');
    }
  }

  /**
   * Resolve the token: cache-first, then Infisical, with graceful degradation.
   * Returns `{ token, cached }`.
   * @private
   */
  async _resolveToken({ cacheKey, synapsUserId, institutionId, key }) {
    const now = this._now();
    const entry = this._cache.get(cacheKey);

    // Fresh cache hit.
    if (entry && (now - entry.cachedAt) < this._cacheTtlMs) {
      return { token: entry.value, cached: true };
    }

    // Try to fetch a fresh token from Infisical.
    let fetchError = null;
    try {
      const result = await this._client.getSecret({ institutionId, synapsUserId, key });
      const token = result.value;
      this._cache.set(cacheKey, { value: token, cachedAt: now });
      return { token, cached: false };
    } catch (err) {
      fetchError = err;
    }

    // Graceful degradation: stale cache within 2× TTL window.
    if (entry && (now - entry.cachedAt) < this._cacheTtlMs * 2) {
      this._logger.warn('CredBroker: Infisical unavailable, using stale cached token', {
        synapsUserId, institutionId, key,
        errorClass: fetchError.constructor.name,
      });
      return { token: entry.value, cached: true };
    }

    // No usable cache — propagate typed Infisical errors or wrap unknown ones.
    if (fetchError.name && fetchError.name.startsWith('Infisical')) {
      throw fetchError;
    }
    throw new CredsUnavailableError(
      `failed to obtain credential for key "${key}": ${fetchError.message}`,
      { cause: fetchError },
    );
  }
}

// ─── NoopCredBroker ───────────────────────────────────────────────────────────

/**
 * Drop-in replacement for CredBroker used when the creds feature is disabled.
 * All public methods match the CredBroker surface but do no work.
 */
export class NoopCredBroker {
  /**
   * Always throws CredBrokerDisabledError — creds feature is off.
   * @throws {CredBrokerDisabledError}
   */
  // eslint-disable-next-line no-unused-vars
  async use(..._args) {
    throw new CredBrokerDisabledError('creds broker is disabled');
  }

  /**
   * @returns {Promise<{ ok:boolean, broker:string }>}
   */
  async ping() {
    return { ok: false, broker: 'noop' };
  }

  /**
   * No-op — no cache to clear.
   */
  clear() {}
}
