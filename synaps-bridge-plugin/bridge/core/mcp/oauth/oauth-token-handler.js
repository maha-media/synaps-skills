/**
 * @file bridge/core/mcp/oauth/oauth-token-handler.js
 *
 * OAuth 2.1 Authorization Code + PKCE — token endpoint handler.
 *
 * Handles POST <token_path> with an application/x-www-form-urlencoded body.
 *
 * Flow:
 *   1. Parse body (already done by caller via URLSearchParams).
 *   2. Validate grant_type, code, code_verifier, client_id, redirect_uri.
 *   3. Atomically redeem the authorization code via codeRepo.
 *   4. Validate client_id + redirect_uri match the stored code.
 *   5. Verify PKCE: base64url(sha256(code_verifier)) === stored code_challenge.
 *   6. Issue a bearer token via tokenRepo.create().
 *   7. Return 200 JSON with access_token, token_type, expires_in, scope.
 *
 * All token errors return 400 with `{ error: "invalid_grant" }` per RFC 6749 §5.2
 * (we do not distinguish "wrong client" from "wrong verifier" to avoid oracle
 * attacks).
 *
 * token_ttl_ms
 * ------------
 * Configurable via `config.token_ttl_ms`.  Defaults to 30 days (2_592_000_000 ms).
 * The same McpTokenRepo used by DCR is reused here — the resulting token is
 * interchangeable with manually-issued or DCR-issued tokens.
 *
 * No external dependencies beyond `node:crypto` (via imported verifyChallenge).
 *
 * Spec reference: Phase 9 brief § Track 3 — OAuth 2.1 + PKCE; Wave C C2.
 */

import { randomBytes, createHash } from 'node:crypto';
import { verifyChallenge }         from './oauth-pkce.js';

// ── defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random 32-byte base64url bearer token.
 *
 * @returns {string}
 */
function generateRawToken() {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * SHA-256 hash a raw token, return lowercase hex digest.
 *
 * @param {string} raw
 * @returns {string}
 */
function hashToken(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

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

// ── OauthTokenHandler ─────────────────────────────────────────────────────────

export class OauthTokenHandler {
  /**
   * @param {object}   opts
   * @param {object}   opts.config
   *   The resolved [mcp.oauth] config block.
   *   Used fields: token_ttl_ms (default 30 days).
   * @param {object}   opts.codeRepo
   *   OauthCodeRepo instance — used to atomically redeem the authorization code.
   * @param {object}   opts.tokenRepo
   *   McpTokenRepo instance — used to issue the final bearer token.
   * @param {Function} [opts.pkceVerifier]
   *   PKCE verifier function; defaults to the exported `verifyChallenge`.
   *   Injectable for testing.
   * @param {object}   [opts.logger]
   *   Optional logger with `.warn?.()` / `.error?.()`.
   * @param {() => number} [opts.clock]
   *   Injectable clock returning epoch ms.  Defaults to `Date.now`.
   */
  constructor({
    config,
    codeRepo,
    tokenRepo,
    pkceVerifier = verifyChallenge,
    logger       = null,
    clock        = Date.now,
  }) {
    if (!config)    throw new TypeError('OauthTokenHandler: config is required');
    if (!codeRepo)  throw new TypeError('OauthTokenHandler: codeRepo is required');
    if (!tokenRepo) throw new TypeError('OauthTokenHandler: tokenRepo is required');

    this._config       = config;
    this._codeRepo     = codeRepo;
    this._tokenRepo    = tokenRepo;
    this._pkceVerifier = pkceVerifier;
    this._logger       = logger;
    this._clock        = clock;
  }

  // ── handle ────────────────────────────────────────────────────────────────

  /**
   * Handle a POST /token request.
   *
   * @param {import('node:http').IncomingMessage} req   – (unused directly; body already parsed)
   * @param {import('node:http').ServerResponse}  res
   * @param {URLSearchParams} body  – Parsed application/x-www-form-urlencoded body.
   */
  async handle(req, res, body) {
    // ── Parse required fields ─────────────────────────────────────────────
    const grant_type    = body.get('grant_type');
    const code          = body.get('code');
    const code_verifier = body.get('code_verifier');
    const client_id     = body.get('client_id');
    const redirect_uri  = body.get('redirect_uri');

    // ── Validate grant_type ───────────────────────────────────────────────
    if (!grant_type) {
      return sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'grant_type is required',
      });
    }
    if (grant_type !== 'authorization_code') {
      return sendJson(res, 400, {
        error: 'unsupported_grant_type',
        error_description: 'only authorization_code grant is supported',
      });
    }

    // ── Validate other required fields ────────────────────────────────────
    if (!code) {
      return sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'code is required',
      });
    }
    if (!code_verifier) {
      return sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'code_verifier is required',
      });
    }
    if (!client_id) {
      return sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'client_id is required',
      });
    }
    if (!redirect_uri) {
      return sendJson(res, 400, {
        error: 'invalid_request',
        error_description: 'redirect_uri is required',
      });
    }

    // ── Redeem the authorization code (atomic) ────────────────────────────
    let doc;
    try {
      doc = await this._codeRepo.redeem(code);
    } catch (err) {
      this._logger?.error?.('[OauthTokenHandler] codeRepo.redeem error', err?.message);
      return sendJson(res, 500, { error: 'server_error' });
    }

    if (!doc) {
      // Code not found, already redeemed, or expired.
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'code is invalid, expired, or already redeemed' });
    }

    // ── Validate client_id matches ────────────────────────────────────────
    if (doc.client_id !== client_id) {
      this._logger?.warn?.('[OauthTokenHandler] client_id mismatch', {
        stored: doc.client_id, provided: client_id,
      });
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'client_id mismatch' });
    }

    // ── Validate redirect_uri matches ─────────────────────────────────────
    if (doc.redirect_uri !== redirect_uri) {
      this._logger?.warn?.('[OauthTokenHandler] redirect_uri mismatch');
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    }

    // ── Verify PKCE ───────────────────────────────────────────────────────
    let pkceOk = false;
    try {
      pkceOk = this._pkceVerifier({
        code_verifier,
        code_challenge:        doc.code_challenge,
        code_challenge_method: doc.code_challenge_method ?? 'S256',
      });
    } catch (err) {
      this._logger?.warn?.('[OauthTokenHandler] pkce verifier error', err?.message);
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }

    if (!pkceOk) {
      return sendJson(res, 400, { error: 'invalid_grant', error_description: 'code_verifier does not match code_challenge' });
    }

    // ── Issue bearer token ────────────────────────────────────────────────
    const raw        = generateRawToken();
    const token_hash = hashToken(raw);
    const ttlMs      = this._config.token_ttl_ms ?? DEFAULT_TOKEN_TTL_MS;
    const nowMs      = this._clock();
    const expiresAt  = new Date(nowMs + ttlMs);

    let tokenRow;
    try {
      tokenRow = await this._tokenRepo.create({
        token_hash,
        synaps_user_id: doc.synaps_user_id,
        institution_id: doc.institution_id,
        name:           client_id,
        expires_at:     expiresAt,
      });
    } catch (err) {
      this._logger?.error?.('[OauthTokenHandler] tokenRepo.create error', err?.message);
      return sendJson(res, 500, { error: 'server_error', error_description: err?.message });
    }

    const expiresInSecs = Math.floor(ttlMs / 1000);

    // IMPORTANT: raw token is returned once — never log it.
    return sendJson(res, 200, {
      access_token: raw,
      token_type:   'bearer',
      expires_in:   expiresInSecs,
      scope:        doc.scope ?? '',
    });
  }
}
