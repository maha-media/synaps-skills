/**
 * @file bridge/core/mcp/oauth/oauth-code-repo.js
 *
 * Repository class wrapping the `synaps_oauth_codes` collection.
 *
 * Provides three operations:
 *   create(params)   – Generate and persist a new authorization code.
 *   findActive(code) – Return the doc if it is unexpired and unredeemed.
 *   redeem(code)     – Atomically mark a code as used; returns null if already
 *                      redeemed or not found.
 *
 * The `clock` parameter is injectable so tests can control time without
 * monkey-patching globals.
 *
 * No HTTP, no side effects beyond MongoDB.
 *
 * Spec reference: Phase 9 brief § Track 3 — OAuth 2.1 + PKCE; Wave C C1+C2.
 */

import { randomBytes } from 'node:crypto';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random 32-byte base64url string.
 *
 * @returns {string}
 */
function generateCode() {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── OauthCodeRepo ─────────────────────────────────────────────────────────────

export class OauthCodeRepo {
  /**
   * @param {object}   opts
   * @param {import('mongoose').Model} opts.model
   *   The SynapsOauthCode mongoose model.
   * @param {() => number} [opts.clock]
   *   Injectable clock; returns epoch ms.  Defaults to `Date.now`.
   * @param {object}   [opts.logger]
   *   Optional logger with `.warn?.()` / `.error?.()`.
   */
  constructor({ model, clock = Date.now, logger = null }) {
    if (!model) throw new TypeError('OauthCodeRepo: model is required');
    this._model  = model;
    this._clock  = clock;
    this._logger = logger;
  }

  // ── create ────────────────────────────────────────────────────────────────

  /**
   * Generate a new authorization code and persist it.
   *
   * @param {object} opts
   * @param {string} opts.client_id
   * @param {string} opts.synaps_user_id
   * @param {string} opts.institution_id
   * @param {string} opts.redirect_uri
   * @param {string} opts.code_challenge       – PKCE challenge (base64url sha256).
   * @param {string} [opts.code_challenge_method='S256']
   * @param {string} [opts.scope='']
   * @param {number} opts.ttl_ms               – Lifetime in milliseconds.
   * @returns {Promise<{ code: string, doc: object }>}
   */
  async create({
    client_id,
    synaps_user_id,
    institution_id,
    redirect_uri,
    code_challenge,
    code_challenge_method = 'S256',
    scope = '',
    ttl_ms,
  }) {
    const now       = this._clock();
    const code      = generateCode();
    const expiresAt = new Date(now + ttl_ms);

    const doc = await this._model.create({
      code,
      client_id,
      synaps_user_id,
      institution_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      scope,
      expires_at: expiresAt,
    });

    return { code, doc };
  }

  // ── findActive ────────────────────────────────────────────────────────────

  /**
   * Return the authorization code document if it is:
   *   • unredeemed (`redeemed_at === null`), AND
   *   • not expired (`expires_at > now`).
   *
   * Returns null otherwise.
   *
   * @param {string} code
   * @returns {Promise<object|null>}
   */
  async findActive(code) {
    const now = new Date(this._clock());

    const doc = await this._model
      .findOne({
        code,
        redeemed_at: null,
        expires_at:  { $gt: now },
      })
      .lean();

    return doc ?? null;
  }

  // ── redeem ────────────────────────────────────────────────────────────────

  /**
   * Atomically mark an authorization code as redeemed.
   *
   * The atomic `findOneAndUpdate` with `{ code, redeemed_at: null }` ensures
   * that only one concurrent call can succeed.  Any subsequent call for the
   * same code returns null (replay protection).
   *
   * Returns null if the code is not found, already redeemed, or expired.
   *
   * @param {string} code
   * @returns {Promise<object|null>}  The updated document or null.
   */
  async redeem(code) {
    const now = new Date(this._clock());

    const doc = await this._model.findOneAndUpdate(
      {
        code,
        redeemed_at: null,
        expires_at:  { $gt: now },
      },
      { $set: { redeemed_at: now } },
      { new: true },
    ).lean();

    return doc ?? null;
  }
}
