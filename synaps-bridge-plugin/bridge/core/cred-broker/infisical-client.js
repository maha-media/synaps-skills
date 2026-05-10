/**
 * bridge/core/cred-broker/infisical-client.js
 *
 * Thin HTTP wrapper around the Infisical secrets API.
 * Reads a service token from a file on disk (lazily, once), then fetches
 * secrets via the v3 raw-secrets endpoint.
 *
 * All external boundaries (fetch, fs, logger, now) are injectable for tests.
 * No top-level await; no I/O in constructor.
 *
 * Spec reference: PLATFORM.SPEC.md §8 — CredBroker / InfisicalClient
 */

import { promises as fsDefault } from 'node:fs';

// ─── Errors ──────────────────────────────────────────────────────────────────

/** Thrown when the requested secret does not exist in Infisical (HTTP 404). */
export class InfisicalNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name  = 'InfisicalNotFoundError';
    this.code  = 'secret_not_found';
  }
}

/** Thrown when the service token is rejected by Infisical (HTTP 401/403). */
export class InfisicalAuthError extends Error {
  constructor(message) {
    super(message);
    this.name  = 'InfisicalAuthError';
    this.code  = 'broker_auth_failed';
  }
}

/** Thrown for 5xx responses, network failures, or malformed responses. */
export class InfisicalUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name  = 'InfisicalUpstreamError';
    this.code  = 'broker_upstream';
  }
}

// ─── InfisicalClient ─────────────────────────────────────────────────────────

/**
 * HTTP client for the Infisical secrets API.
 *
 * @example
 * const client = new InfisicalClient({
 *   baseUrl:   'https://infisical.internal',
 *   tokenFile: '/run/secrets/infisical_token',
 * });
 * const { value, fetchedAt } = await client.getSecret({
 *   institutionId: 'inst_123',
 *   synapsUserId:  'u_alice',
 *   key:           'github.token',
 * });
 */
export class InfisicalClient {
  /**
   * @param {object}   opts
   * @param {string}   opts.baseUrl                 - Infisical API base URL, e.g. 'https://infisical.internal'
   * @param {string}   opts.tokenFile               - Path to file containing the Infisical service token
   * @param {Function} [opts.fetch]                 - Injectable fetch; defaults to globalThis.fetch
   * @param {object}   [opts.fs]                    - Injectable fs/promises; defaults to node:fs/promises
   * @param {object}   [opts.logger]                - { info, warn, error, debug }; defaults to console
   * @param {Function} [opts.now]                   - () => number (ms since epoch); defaults to Date.now
   * @param {boolean}  [opts.auditAttributeUser]    - Include synapsUserId in User-Agent; default true
   */
  constructor({
    baseUrl,
    tokenFile,
    fetch: fetchImpl,
    fs: fsImpl,
    logger,
    now,
    auditAttributeUser = true,
  }) {
    if (!baseUrl) {
      throw new TypeError('InfisicalClient: baseUrl is required');
    }
    if (!tokenFile) {
      throw new TypeError('InfisicalClient: tokenFile is required');
    }

    this._baseUrl             = baseUrl.replace(/\/$/, ''); // strip trailing slash
    this._tokenFile           = tokenFile;
    this._fetch               = fetchImpl ?? globalThis.fetch;
    this._fs                  = fsImpl ?? fsDefault;
    this._logger              = logger ?? console;
    this._now                 = now ?? (() => Date.now());
    this._auditAttributeUser  = auditAttributeUser;

    /** @type {string|null} Cached token; null until first read. */
    this._token = null;
  }

  // ─── token management ──────────────────────────────────────────────────────

  /**
   * Read and cache the service token from disk.
   * Idempotent — only reads once unless reloadToken() is called.
   *
   * @returns {Promise<string>}
   * @throws {InfisicalAuthError} when the file is missing or unreadable
   */
  async _ensureToken() {
    if (this._token !== null) return this._token;
    return this._readToken();
  }

  /**
   * Do the actual disk read and cache.
   * @returns {Promise<string>}
   */
  async _readToken() {
    try {
      const raw = await this._fs.readFile(this._tokenFile, 'utf8');
      this._token = raw.trimEnd(); // strip trailing whitespace / newlines
      return this._token;
    } catch (err) {
      // Never surface path in error if it could reveal layout — but per spec we
      // do include the path in the auth error message (not in logs).
      throw new InfisicalAuthError(
        `failed to read token file: ${this._tokenFile}`,
      );
    }
  }

  /**
   * Force a re-read of the token from disk (for SIGHUP rotation).
   * @returns {Promise<void>}
   */
  async reloadToken() {
    this._token = null;
    await this._readToken();
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  /**
   * Build the redacted Authorization string for logging.
   * Token value is NEVER written to any log.
   *
   * @param {string} token
   * @returns {string}  e.g. 'Bearer <redacted:40 chars>'
   */
  _redactedAuth(token) {
    return `Bearer <redacted:${token.length} chars>`;
  }

  /**
   * Build common request headers.
   *
   * @param {string} token
   * @param {string} [synapsUserId]
   * @returns {Record<string,string>}
   */
  _buildHeaders(token, synapsUserId) {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };

    if (this._auditAttributeUser && synapsUserId) {
      headers['User-Agent'] = `synaps-cred-broker/${synapsUserId}`;
    } else {
      headers['User-Agent'] = 'synaps-cred-broker';
    }

    return headers;
  }

  // ─── public API ────────────────────────────────────────────────────────────

  /**
   * Fetch a secret value from Infisical.
   *
   * URL pattern:
   *   GET <baseUrl>/api/v3/secrets/raw
   *     ?workspaceId=<institutionId>
   *     &secretPath=%2Fusers%2F<synapsUserId>
   *     &secretName=<key>
   *     &type=shared
   *
   * @param {object} args
   * @param {string} args.institutionId  - Maps 1:1 to Infisical projectId / workspaceId
   * @param {string} args.synapsUserId   - Maps to folder /users/<synapsUserId>
   * @param {string} args.key            - Secret name (e.g. 'github.token')
   * @returns {Promise<{ value: string, fetchedAt: number }>}
   * @throws {InfisicalNotFoundError|InfisicalAuthError|InfisicalUpstreamError}
   */
  async getSecret({ institutionId, synapsUserId, key }) {
    const token = await this._ensureToken();

    // Build URL with properly percent-encoded components.
    // secretPath is a path value — pass the literal string to URLSearchParams
    // which will encode the slashes and any special chars in synapsUserId for us.
    const secretPath   = `/users/${synapsUserId}`;
    const params       = new URLSearchParams({
      workspaceId: institutionId,
      secretPath,
      secretName: key,
      type: 'shared',
    });
    const url = `${this._baseUrl}/api/v3/secrets/raw?${params.toString()}`;

    const headers = this._buildHeaders(token, synapsUserId);

    this._logger.debug('[InfisicalClient] getSecret request', {
      baseUrl:       this._baseUrl,
      institutionId,
      synapsUserId,
      key,
      Authorization: this._redactedAuth(token),
      'User-Agent':  headers['User-Agent'],
    });

    const t0 = this._now();
    let response;

    try {
      response = await this._fetch(url, { method: 'GET', headers });
    } catch (networkErr) {
      const duration_ms = this._now() - t0;
      this._logger.error('[InfisicalClient] getSecret network error', {
        baseUrl:      this._baseUrl,
        key,
        synapsUserId,
        institutionId,
        errorClass:   networkErr?.constructor?.name ?? 'Error',
        message:      networkErr?.message,
        duration_ms,
      });
      throw new InfisicalUpstreamError(
        `infisical network error: ${networkErr?.message ?? 'unknown'}`,
      );
    }

    const { status } = response;
    const duration_ms = this._now() - t0;

    this._logger.debug('[InfisicalClient] getSecret response', {
      baseUrl:      this._baseUrl,
      key,
      synapsUserId,
      institutionId,
      status,
      duration_ms,
    });

    if (status === 404) {
      throw new InfisicalNotFoundError(`secret not found: ${key}`);
    }

    if (status === 401 || status === 403) {
      throw new InfisicalAuthError(`infisical auth failed: ${status}`);
    }

    if (status >= 500) {
      this._logger.error('[InfisicalClient] getSecret upstream error', {
        baseUrl:      this._baseUrl,
        key,
        synapsUserId,
        institutionId,
        status,
        errorClass:   'InfisicalUpstreamError',
        duration_ms,
      });
      throw new InfisicalUpstreamError(
        `infisical upstream error: ${status}`,
      );
    }

    // Parse response body.
    let body;
    try {
      body = await response.json();
    } catch {
      throw new InfisicalUpstreamError(
        'malformed response from infisical',
      );
    }

    const secretValue = body?.secret?.secretValue;
    if (typeof secretValue !== 'string') {
      throw new InfisicalUpstreamError(
        'malformed response from infisical',
      );
    }

    return { value: secretValue, fetchedAt: this._now() };
  }

  /**
   * Health check.  HEAD <baseUrl>/api/status with auth.
   *
   * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
   */
  async ping() {
    // We need a token for the auth header; use cached value if available,
    // otherwise attempt a read but don't throw — a token-file error is itself
    // an unhealthy state.
    let token = this._token;
    if (token === null) {
      try {
        token = await this._readToken();
      } catch {
        token = ''; // proceed without auth so we still get a meaningful HTTP status
      }
    }

    const url     = `${this._baseUrl}/api/status`;
    const headers = this._buildHeaders(token, undefined);

    let response;
    try {
      response = await this._fetch(url, { method: 'HEAD', headers });
    } catch (err) {
      return { ok: false, error: err?.message ?? 'network error' };
    }

    const { status } = response;

    if (status >= 200 && status < 300) {
      return { ok: true, status };
    }

    return {
      ok:     false,
      status,
      error:  `infisical health check returned ${status}`,
    };
  }
}
