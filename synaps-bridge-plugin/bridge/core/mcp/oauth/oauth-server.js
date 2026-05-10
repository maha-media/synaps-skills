/**
 * @file bridge/core/mcp/oauth/oauth-server.js
 *
 * OAuth 2.1 HTTP dispatcher.
 *
 * Owns the routing table for all OAuth 2.1 endpoints.  Each call to
 * `handle(req, res, pathname, query)` either handles the request and returns
 * true, or returns false (letting ScpHttpServer fall through to a 404).
 *
 * Routes:
 *   GET  /.well-known/oauth-authorization-server  → metadataHandler
 *   GET  /.well-known/oauth-protected-resource    → metadataHandler
 *   GET  <authorize_path>                         → authorizeHandler.handleGet
 *   POST <authorize_path>                         → parse form body → authorizeHandler.handlePost
 *   POST <token_path>                             → parse form body → tokenHandler.handle
 *   GET  <token_path>                             → 405 Method Not Allowed
 *
 * Body parsing
 * ------------
 * For POST requests the dispatcher reads up to `config.max_body_bytes`
 * (default 16 384) bytes.  Requests exceeding the limit receive a 413.
 * The raw body is decoded as UTF-8 and parsed with URLSearchParams.
 *
 * Error isolation
 * ---------------
 * Exceptions thrown by sub-handlers are caught and turned into 500 responses
 * so an OAuth bug never crashes ScpHttpServer.
 *
 * No external dependencies.
 *
 * Spec reference: Phase 9 brief § Track 3 — OAuth 2.1 + PKCE; Wave C C2.
 */

// ── defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_BODY_BYTES = 16_384;

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Send a JSON response.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {object} body
 */
function sendJson(res, statusCode, body) {
  if (res.headersSent) return;
  const raw = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

/**
 * Read up to `maxBytes` from the request stream.
 *
 * Resolves with the raw UTF-8 body string on success.
 * Resolves with the sentinel `TOO_LARGE` if the body exceeds `maxBytes`.
 * Rejects on stream error.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<string|Symbol>}
 */
const TOO_LARGE = Symbol('too_large');

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('OauthServer: body read timeout'));
      }
    }, 5_000);

    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        clearTimeout(timer);
        req.resume(); // drain remaining
        resolve(TOO_LARGE);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── OauthServer ───────────────────────────────────────────────────────────────

export class OauthServer {
  /**
   * @param {object}   opts
   * @param {object}   opts.config
   *   The resolved [mcp.oauth] config block.
   *   Used fields: authorize_path, token_path, max_body_bytes.
   * @param {object}   opts.authorizeHandler
   *   OauthAuthorizeHandler instance.
   * @param {object}   opts.tokenHandler
   *   OauthTokenHandler instance.
   * @param {object}   opts.metadataHandler
   *   OauthMetadataHandler instance.
   * @param {object}   [opts.logger]
   *   Optional logger with `.warn?.()` / `.error?.()`.
   */
  constructor({ config, authorizeHandler, tokenHandler, metadataHandler, logger = null }) {
    if (!config)            throw new TypeError('OauthServer: config is required');
    if (!authorizeHandler)  throw new TypeError('OauthServer: authorizeHandler is required');
    if (!tokenHandler)      throw new TypeError('OauthServer: tokenHandler is required');
    if (!metadataHandler)   throw new TypeError('OauthServer: metadataHandler is required');

    this._config           = config;
    this._authorizeHandler = authorizeHandler;
    this._tokenHandler     = tokenHandler;
    this._metadataHandler  = metadataHandler;
    this._logger           = logger;

    this._maxBodyBytes = config.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
    this._authorizePath = config.authorize_path;
    this._tokenPath     = config.token_path;
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Route an incoming request to the appropriate OAuth sub-handler.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse}  res
   * @param {string} pathname  – URL pathname (no query string).
   * @param {URLSearchParams} query  – Parsed query parameters.
   * @returns {Promise<boolean>}  true if handled, false to 404.
   */
  async handle(req, res, pathname, query) {
    try {
      return await this._dispatch(req, res, pathname, query);
    } catch (err) {
      this._logger?.error?.('[OauthServer] unhandled error', err?.message);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'server_error' });
      }
      return true; // swallow — we wrote a response
    }
  }

  // ── private ───────────────────────────────────────────────────────────────

  /**
   * Internal dispatch — throws on error (caught by `handle()`).
   */
  async _dispatch(req, res, pathname, query) {
    const method = req.method?.toUpperCase() ?? 'GET';

    // ── well-known metadata ────────────────────────────────────────────────
    if (
      pathname === '/.well-known/oauth-authorization-server' ||
      pathname === '/.well-known/oauth-protected-resource'
    ) {
      if (method !== 'GET') {
        res.writeHead(405, { Allow: 'GET', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return true;
      }
      return this._metadataHandler.handle(req, res, pathname);
    }

    // ── /authorize ────────────────────────────────────────────────────────
    if (pathname === this._authorizePath) {
      if (method === 'GET') {
        await this._authorizeHandler.handleGet(req, res, query);
        return true;
      }

      if (method === 'POST') {
        const raw = await readBody(req, this._maxBodyBytes);
        if (raw === TOO_LARGE) {
          sendJson(res, 413, { error: 'request_entity_too_large' });
          return true;
        }
        const formData = new URLSearchParams(raw);
        await this._authorizeHandler.handlePost(req, res, formData);
        return true;
      }

      res.writeHead(405, { Allow: 'GET, POST', 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return true;
    }

    // ── /token ────────────────────────────────────────────────────────────
    if (pathname === this._tokenPath) {
      if (method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return true;
      }

      const raw = await readBody(req, this._maxBodyBytes);
      if (raw === TOO_LARGE) {
        sendJson(res, 413, { error: 'request_entity_too_large' });
        return true;
      }
      const formData = new URLSearchParams(raw);
      await this._tokenHandler.handle(req, res, formData);
      return true;
    }

    // ── no match ──────────────────────────────────────────────────────────
    return false;
  }
}
