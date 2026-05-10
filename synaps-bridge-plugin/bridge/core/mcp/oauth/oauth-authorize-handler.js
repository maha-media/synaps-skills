/**
 * @file bridge/core/mcp/oauth/oauth-authorize-handler.js
 *
 * OAuth 2.1 Authorization Code + PKCE — authorize endpoint handler.
 *
 * Handles:
 *   GET  <authorize_path>  – Validate params → check session → render consent HTML.
 *   POST <authorize_path>  – Validate CSRF → process consent → redirect with code.
 *
 * Session resolution
 * ------------------
 * For production use, `identityRouter.resolveSession(cookieValue)` must return
 * `{ synaps_user_id, institution_id }`.  If `identityRouter` is absent or has no
 * `resolveSession` method, every GET is treated as unauthenticated and the user
 * is redirected to the login page.
 *
 * Test-auth-header bypass
 * -----------------------
 * When `config.test_auth_header_enabled = true` (never set in production),
 * the `X-Synaps-Test-Auth` request header may carry a value of the form
 * `<synaps_user_id>:<institution_id>`.  This bypasses session cookie
 * resolution entirely — for smoke tests only.
 *
 * CSRF protection
 * ---------------
 * A 32-byte random base64url token is generated per consent page view.
 * It is embedded in the HTML form and stored in an in-memory Map.
 * The POST handler looks up the token and deletes it atomically to prevent
 * replay.  Entries expire after `config.code_ttl_ms` (default 10 min).
 *
 * XSS protection
 * --------------
 * All template variables are HTML-escaped before substitution.
 * The response includes `Content-Security-Policy: default-src 'self'`.
 *
 * No external dependencies beyond `node:crypto` and `node:fs`.
 *
 * Spec reference: Phase 9 brief § Track 3 — OAuth 2.1 + PKCE; Wave C C2.
 */

import { readFileSync }       from 'node:fs';
import { fileURLToPath }      from 'node:url';
import path                   from 'node:path';
import { randomBytes }        from 'node:crypto';

// ── HTML template ─────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load the consent.html template once at module load time.
 * Using readFileSync is intentional — no top-level await (ESM rule).
 */
const CONSENT_TEMPLATE = readFileSync(
  path.join(__dirname, 'consent.html'),
  'utf8',
);

// ── HTML escaping ─────────────────────────────────────────────────────────────

/**
 * Escape a value for safe insertion into HTML attribute values and text content.
 *
 * Covers the five characters that must never appear raw in HTML:
 *   &  →  &amp;
 *   <  →  &lt;
 *   >  →  &gt;
 *   "  →  &quot;
 *   '  →  &#39;
 *
 * @param {*} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random 32-byte base64url string.
 * Used for CSRF tokens and (transitively) for auth codes.
 *
 * @returns {string}
 */
function generateToken() {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Parse a `Cookie:` header string into a key→value map.
 *
 * @param {string|undefined} cookieHeader
 * @returns {Record<string, string>}
 */
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 1) continue;
    const key   = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    cookies[key] = value;
  }
  return cookies;
}

/**
 * Send a JSON error response.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {string} error
 * @param {string} [description]
 */
function sendError(res, statusCode, error, description) {
  if (res.headersSent) return;
  const body = JSON.stringify(
    description ? { error, error_description: description } : { error },
  );
  res.writeHead(statusCode, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Append `key=value` to a URL, using `?` or `&` as appropriate.
 *
 * @param {string} url
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function appendParam(url, key, value) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

// ── OauthAuthorizeHandler ─────────────────────────────────────────────────────

export class OauthAuthorizeHandler {
  /**
   * @param {object}   opts
   * @param {object}   opts.config
   *   The resolved [mcp.oauth] config block.
   *   Required fields: issuer, authorize_path, allowed_redirect_uri_prefixes,
   *                    code_ttl_ms, test_auth_header_enabled.
   * @param {object}   opts.codeRepo
   *   OauthCodeRepo instance.
   * @param {object}   opts.tokenRepo
   *   McpTokenRepo instance (not used in authorize, but held for future use).
   * @param {object}   [opts.identityRouter]
   *   Optional; must expose `resolveSession(cookieValue) → Promise<{synaps_user_id, institution_id}>`.
   *   If absent or lacking `resolveSession`, all visits are treated as unauthenticated.
   * @param {object}   [opts.logger]
   * @param {() => number} [opts.clock]
   *   Injectable clock.  Returns epoch ms.
   */
  constructor({
    config,
    codeRepo,
    tokenRepo = null,
    identityRouter = null,
    logger = null,
    clock = Date.now,
  }) {
    if (!config)   throw new TypeError('OauthAuthorizeHandler: config is required');
    if (!codeRepo) throw new TypeError('OauthAuthorizeHandler: codeRepo is required');

    this._config         = config;
    this._codeRepo       = codeRepo;
    this._tokenRepo      = tokenRepo;
    this._identityRouter = identityRouter;
    this._logger         = logger;
    this._clock          = clock;

    /**
     * In-memory CSRF token store.
     * Key:   csrf_token (random 32-byte base64url)
     * Value: { synaps_user_id, institution_id, client_id, redirect_uri,
     *           code_challenge, code_challenge_method, scope, state, expires_at }
     *
     * @type {Map<string, object>}
     */
    this._csrf = new Map();
  }

  // ── GET /authorize ────────────────────────────────────────────────────────

  /**
   * Handle GET /authorize.
   *
   * Validates query parameters, resolves the user's session, and either
   * redirects to login (unauthenticated) or renders the consent page.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse}  res
   * @param {URLSearchParams} query
   */
  async handleGet(req, res, query) {
    // ── Required params ───────────────────────────────────────────────────
    const response_type          = query.get('response_type');
    const client_id              = query.get('client_id');
    const redirect_uri           = query.get('redirect_uri');
    const code_challenge         = query.get('code_challenge');
    const code_challenge_method  = query.get('code_challenge_method') ?? 'S256';
    const state                  = query.get('state') ?? '';
    const scope                  = query.get('scope') ?? '';

    if (response_type !== 'code') {
      return sendError(res, 400, 'unsupported_response_type',
        'response_type must be "code"');
    }
    if (!client_id) {
      return sendError(res, 400, 'invalid_request', 'client_id is required');
    }
    if (!redirect_uri) {
      return sendError(res, 400, 'invalid_request', 'redirect_uri is required');
    }
    if (!code_challenge) {
      return sendError(res, 400, 'invalid_request', 'code_challenge is required');
    }

    // ── Validate redirect_uri prefix ──────────────────────────────────────
    const prefixes = this._config.allowed_redirect_uri_prefixes ?? [];
    const uriAllowed = prefixes.some((p) => redirect_uri.startsWith(p));
    if (!uriAllowed) {
      return sendError(res, 400, 'invalid_redirect_uri',
        'redirect_uri does not match any allowed prefix');
    }

    // ── Validate PKCE method ──────────────────────────────────────────────
    if (code_challenge_method !== 'S256') {
      return sendError(res, 400, 'unsupported_challenge_method',
        'only code_challenge_method=S256 is supported');
    }

    // ── Resolve user identity ─────────────────────────────────────────────

    // 1. Test-auth-header bypass (dev/smoke only).
    let synaps_user_id = null;
    let institution_id = null;

    if (this._config.test_auth_header_enabled) {
      const testHeader = req.headers['x-synaps-test-auth'];
      if (testHeader) {
        const parts = testHeader.split(':');
        if (parts.length === 2 && parts[0] && parts[1]) {
          synaps_user_id = parts[0].trim();
          institution_id = parts[1].trim();
        }
      }
    }

    // 2. Session cookie (production path).
    if (!synaps_user_id && this._identityRouter?.resolveSession) {
      const cookies = parseCookies(req.headers['cookie']);
      const sessionCookie = cookies['synaps_session'];
      if (sessionCookie) {
        try {
          const identity = await this._identityRouter.resolveSession(sessionCookie);
          if (identity) {
            synaps_user_id = identity.synaps_user_id;
            institution_id = identity.institution_id;
          }
        } catch (err) {
          this._logger?.warn?.('[OauthAuthorizeHandler] resolveSession error', err?.message);
        }
      }
    }

    // 3. If still not authenticated → redirect to login.
    if (!synaps_user_id) {
      const originalUrl = req.url || this._config.authorize_path;
      const loginUrl    = `/agents/login?next=${encodeURIComponent(originalUrl)}`;
      if (!res.headersSent) {
        res.writeHead(302, { Location: loginUrl });
        res.end();
      }
      return;
    }

    // ── Generate CSRF token and store binding ─────────────────────────────
    const csrfToken = generateToken();
    const csrfTtlMs = this._config.code_ttl_ms ?? 600_000;

    this._csrf.set(csrfToken, {
      synaps_user_id,
      institution_id,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope,
      state,
      expires_at: this._clock() + csrfTtlMs,
    });

    // ── Render consent page ───────────────────────────────────────────────
    const html = CONSENT_TEMPLATE
      .replace(/\{\{client_id\}\}/g,      escapeHtml(client_id))
      .replace(/\{\{scope\}\}/g,          escapeHtml(scope))
      .replace(/\{\{authorize_path\}\}/g, escapeHtml(this._config.authorize_path))
      .replace(/\{\{csrf_token\}\}/g,     escapeHtml(csrfToken))
      .replace(/\{\{state\}\}/g,          escapeHtml(state))
      .replace(/\{\{redirect_uri\}\}/g,   escapeHtml(redirect_uri));

    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type':            'text/html; charset=utf-8',
        'Content-Length':          Buffer.byteLength(html),
        'Content-Security-Policy': "default-src 'self'",
        'X-Content-Type-Options':  'nosniff',
      });
      res.end(html);
    }
  }

  // ── POST /authorize ───────────────────────────────────────────────────────

  /**
   * Handle POST /authorize (consent form submission).
   *
   * Validates the CSRF token and processes the user's Allow/Deny decision.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse}  res
   * @param {URLSearchParams} formData  – Parsed application/x-www-form-urlencoded body.
   */
  async handlePost(req, res, formData) {
    const csrfToken = formData.get('csrf_token');
    const consent   = formData.get('consent');
    const state     = formData.get('state') ?? '';

    // ── CSRF validation ───────────────────────────────────────────────────
    if (!csrfToken || !this._csrf.has(csrfToken)) {
      return sendError(res, 400, 'invalid_request', 'invalid or missing csrf_token');
    }

    const binding = this._csrf.get(csrfToken);

    // Check CSRF expiry.
    if (this._clock() > binding.expires_at) {
      this._csrf.delete(csrfToken);
      return sendError(res, 400, 'invalid_request', 'csrf_token has expired');
    }

    // Consume the CSRF token (one-time use).
    this._csrf.delete(csrfToken);

    const { synaps_user_id, institution_id, client_id, redirect_uri,
            code_challenge, code_challenge_method, scope } = binding;

    // ── Consent decision ──────────────────────────────────────────────────
    if (consent !== 'allow') {
      // User denied — redirect with access_denied error.
      let location = `${redirect_uri}?error=access_denied`;
      if (state) location = appendParam(location, 'state', state);
      if (!res.headersSent) {
        res.writeHead(302, { Location: location });
        res.end();
      }
      return;
    }

    // ── Issue authorization code ──────────────────────────────────────────
    const { code } = await this._codeRepo.create({
      client_id,
      synaps_user_id,
      institution_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope,
      ttl_ms: this._config.code_ttl_ms ?? 600_000,
    });

    // ── Redirect with code ────────────────────────────────────────────────
    let location = `${redirect_uri}?code=${encodeURIComponent(code)}`;
    if (state) location = appendParam(location, 'state', state);

    if (!res.headersSent) {
      res.writeHead(302, { Location: location });
      res.end();
    }
  }
}
