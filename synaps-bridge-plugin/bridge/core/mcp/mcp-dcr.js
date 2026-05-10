/**
 * @file bridge/core/mcp/mcp-dcr.js
 *
 * OAuth2 Dynamic Client Registration handler (RFC 7591 minimal subset).
 *
 * This module is a pure handler — it accepts a parsed request body and
 * returns `{ statusCode, body }` for the HTTP layer to serialise. It has
 * no knowledge of `http.IncomingMessage` / `http.ServerResponse`.
 *
 * Re-uses the same `synaps_mcp_tokens` collection and the same helper
 * functions (`generateRawToken`, `hashToken`) that Phase 7 uses for
 * `mcp_token_issue` via `ControlSocket`. DCR is a different *entrance*
 * to the same token store.
 *
 * Spec reference: Phase 8 brief § Track 4 — OAuth2 Dynamic Client
 * Registration; Wave A4 contract.
 */

import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { generateRawToken, hashToken } from './mcp-token-resolver.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 365 days

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Constant-time string comparison using `crypto.timingSafeEqual`.
 *
 * Both strings are UTF-8 encoded before comparison.  Length mismatch is
 * handled defensively: we still call `timingSafeEqual` on same-length
 * buffers derived from the inputs so we always do "work" (preventing a
 * trivial early-exit timing oracle), then return `false`.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');

  if (ba.length !== bb.length) {
    // Still perform a dummy comparison to avoid length-based timing leakage.
    // We use a same-length pair so timingSafeEqual doesn't throw.
    const dummy = Buffer.alloc(ba.length, 0);
    timingSafeEqual(ba, dummy); // result discarded
    return false;
  }

  return timingSafeEqual(ba, bb);
}

/**
 * Generate a short client_id (first 16 chars of a UUIDv4, dashes removed).
 *
 * @returns {string}  16 lowercase hex chars
 */
function generateClientId() {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

// ── McpDcrHandler ─────────────────────────────────────────────────────────────

export class McpDcrHandler {
  /**
   * @param {object}   opts
   * @param {string}   opts.registrationSecret   - Pre-shared admin secret.
   *                                               Empty string or falsy → handler disabled.
   * @param {object}   opts.tokenRepo             - McpTokenRepo (Phase 7).
   *                                               Must expose `.create({ token_hash,
   *                                               synaps_user_id, name, expires_at })`.
   * @param {object}   [opts.identityRepo]        - Optional; must expose
   *                                               `.findById(id)` → truthy if found.
   * @param {() => string} [opts.generateRawToken] - Defaults to mcp-token-resolver helper.
   * @param {(s: string) => string} [opts.hashToken] - Defaults to mcp-token-resolver helper.
   * @param {() => number} [opts.now]             - Returns current epoch ms; defaults to Date.now.
   * @param {object}   [opts.logger]              - Optional logger with `.warn?.()` / `.error?.()`.
   * @param {number}   [opts.tokenTtlMs]          - Token lifetime in ms; default 365 days.
   */
  constructor({
    registrationSecret,
    tokenRepo,
    identityRepo      = null,
    generateRawToken: _generateRawToken = generateRawToken,
    hashToken: _hashToken               = hashToken,
    now                                 = () => Date.now(),
    logger                              = null,
    tokenTtlMs                          = DEFAULT_TOKEN_TTL_MS,
  } = {}) {
    if (!tokenRepo) throw new TypeError('McpDcrHandler: tokenRepo is required');

    // Normalise: treat empty / whitespace-only / null / undefined as "disabled".
    const secret = typeof registrationSecret === 'string'
      ? registrationSecret.trim()
      : '';

    this._secret           = secret;
    this._tokenRepo        = tokenRepo;
    this._identityRepo     = identityRepo;
    this._generateRawToken = _generateRawToken;
    this._hashToken        = _hashToken;
    this._now              = now;
    this._logger           = logger;
    this._tokenTtlMs       = tokenTtlMs;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * `true` when the handler is enabled (registrationSecret is non-empty).
   * @returns {boolean}
   */
  get enabled() {
    return this._secret.length > 0;
  }

  /**
   * Handle a DCR registration request.
   *
   * @param {unknown} body   - Parsed request body (already JSON-decoded by caller).
   * @returns {Promise<{statusCode: number, body: object}>}
   */
  async register(body) {
    // ── Guard: disabled ───────────────────────────────────────────────────────
    if (!this.enabled) {
      return _res(404, { error: 'not_found' });
    }

    // ── Guard: body must be a plain object ───────────────────────────────────
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return _res(400, {
        error: 'invalid_request',
        error_description: 'body must be object',
      });
    }

    // ── Guard: registration_secret presence ──────────────────────────────────
    if (!Object.prototype.hasOwnProperty.call(body, 'registration_secret')
        || typeof body.registration_secret !== 'string'
        || body.registration_secret.length === 0) {
      return _res(401, { error: 'invalid_client' });
    }

    // ── Guard: registration_secret correctness (constant-time) ───────────────
    if (!safeEqual(body.registration_secret, this._secret)) {
      return _res(401, { error: 'invalid_client' });
    }

    // ── Guard: synaps_user_id presence ───────────────────────────────────────
    const synaps_user_id = body.synaps_user_id;
    if (!synaps_user_id || typeof synaps_user_id !== 'string') {
      return _res(400, {
        error: 'invalid_request',
        error_description: 'synaps_user_id required',
      });
    }

    // ── Guard: synaps_user_id existence (optional repo check) ─────────────────
    if (this._identityRepo) {
      let found;
      try {
        found = await this._identityRepo.findById(synaps_user_id);
      } catch (err) {
        this._logger?.warn?.('McpDcrHandler: identityRepo.findById error', {
          err: err?.message,
        });
        return _res(400, {
          error: 'invalid_request',
          error_description: 'synaps_user_id not found',
        });
      }
      if (!found) {
        return _res(400, {
          error: 'invalid_request',
          error_description: 'synaps_user_id not found',
        });
      }
    }

    // ── Issue token ───────────────────────────────────────────────────────────
    const raw        = this._generateRawToken();
    const token_hash = this._hashToken(raw);
    const nowMs      = this._now();
    const expiresAt  = new Date(nowMs + this._tokenTtlMs);
    const label      = (typeof body.client_name === 'string' && body.client_name.length > 0)
      ? body.client_name
      : 'dcr';
    const clientId   = generateClientId();

    let row;
    try {
      row = await this._tokenRepo.create({
        token_hash,
        synaps_user_id,
        name:       label,
        expires_at: expiresAt,
      });
    } catch (err) {
      this._logger?.warn?.('McpDcrHandler: tokenRepo.create error', {
        err: err?.message,
      });
      return _res(500, { error: 'server_error', error_description: err?.message });
    }

    // `client_secret_expires_at` is Unix epoch seconds (RFC 7591 §3.2.1).
    const expiresAtSec = Math.floor(expiresAt.getTime() / 1000);

    // IMPORTANT: raw token is returned ONCE — it must NOT appear in any log.
    return _res(201, {
      client_id:                     clientId,
      client_secret:                 raw,
      client_secret_expires_at:      expiresAtSec,
      token_endpoint_auth_method:    'client_secret_post',
      grant_types:                   ['client_credentials'],
      token_type:                    'bearer',
    });
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Build a handler response envelope.
 *
 * @param {number} statusCode
 * @param {object} body
 * @returns {{ statusCode: number, body: object }}
 */
function _res(statusCode, body) {
  return { statusCode, body };
}
