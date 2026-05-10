/**
 * @file bridge/core/db/repositories/link-code-repo.js
 *
 * Repository class encapsulating all MongoDB queries for the
 * `synaps_link_codes` collection.
 *
 * All methods are pure DB calls — no background work, no timers, no events.
 *
 * Spec reference: PLATFORM.SPEC.md § 14.1 (link-code flow)
 */

import { randomInt } from 'node:crypto';

/** Characters used for code generation (no I/O/0/1 to avoid visual ambiguity). */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH   = 6;

/**
 * @typedef {import('mongoose').Model} MongooseModel
 *
 * @typedef {Object} RepoOptions
 * @property {MongooseModel} model    - The SynapsLinkCode mongoose model.
 * @property {object}        [logger] - Logger with .info/.warn/.error; defaults to console.
 */

/**
 * Repository for synaps_link_code documents.
 */
export class LinkCodeRepo {
  /**
   * @param {RepoOptions} opts
   */
  constructor({ model, logger = console }) {
    this._model  = model;
    this._logger = logger;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Generate a random 6-character link code from the safe alphabet.
   *
   * @returns {string}
   */
  _generateCode() {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
    }
    return code;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Issue a new link code.
   *
   * Retries up to 5 times if a duplicate-key error occurs on `code`.
   *
   * @param {object} params
   * @param {import('mongoose').Types.ObjectId|string} params.pria_user_id
   * @param {import('mongoose').Types.ObjectId|string} params.synaps_user_id
   * @param {number} params.ttl_ms - Time-to-live in milliseconds.
   * @returns {Promise<{ doc: object, code: string }>}
   */
  async issue({ pria_user_id, synaps_user_id, ttl_ms }) {
    const MAX_ATTEMPTS = 5;
    let lastErr;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const code       = this._generateCode();
      const expires_at = new Date(Date.now() + ttl_ms);

      try {
        const doc = await this._model.create({
          code,
          pria_user_id,
          synaps_user_id,
          expires_at,
        });
        this._logger.info(`[LinkCodeRepo] Issued code ${code} expires=${expires_at.toISOString()}`);
        return { doc, code };
      } catch (err) {
        // 11000 = MongoDB duplicate-key error code
        if (err.code === 11000) {
          this._logger.warn(`[LinkCodeRepo] Duplicate code collision on attempt ${attempt + 1}, retrying…`);
          lastErr = err;
          continue;
        }
        this._logger.error('[LinkCodeRepo] issue() error:', err.message);
        throw err;
      }
    }

    this._logger.error('[LinkCodeRepo] Exhausted retries issuing link code');
    throw lastErr;
  }

  /**
   * Find an active (non-expired, non-redeemed) link code document.
   *
   * @param {string} code
   * @returns {Promise<object|null>}
   */
  async findActiveByCode(code) {
    return this._model
      .findOne({
        code,
        redeemed_at: null,
        expires_at:  { $gt: new Date() },
      })
      .lean();
  }

  /**
   * Atomically redeem a link code.
   *
   * Only succeeds when `redeemed_at == null && expires_at > now`.
   *
   * @param {object} params
   * @param {string} params.code
   * @param {{ channel: string, external_id: string, external_team_id: string }} params.redeemed_by
   * @returns {Promise<
   *   { ok: true,  doc: object } |
   *   { ok: false, reason: 'unknown'|'expired'|'already_redeemed' }
   * >}
   */
  async redeem({ code, redeemed_by }) {
    const now = new Date();

    // Atomic update — only matches if not yet redeemed and not expired.
    const updated = await this._model
      .findOneAndUpdate(
        { code, redeemed_at: null, expires_at: { $gt: now } },
        { $set: { redeemed_at: now, redeemed_by } },
        { new: true },
      )
      .lean();

    if (updated) {
      this._logger.info(`[LinkCodeRepo] Redeemed code ${code}`);
      return { ok: true, doc: updated };
    }

    // Distinguish between "not found", "expired", and "already redeemed".
    const existing = await this._model.findOne({ code }).lean();

    if (!existing) {
      return { ok: false, reason: 'unknown' };
    }

    if (existing.redeemed_at != null) {
      return { ok: false, reason: 'already_redeemed' };
    }

    // expires_at <= now
    return { ok: false, reason: 'expired' };
  }

  // ── IdentityRouter aliases ─────────────────────────────────────────────────

  /**
   * Find a link code by code string — does NOT filter on expiry or redemption
   * status.  Used by IdentityRouter.redeemLinkCode which validates state
   * in-memory after fetching the raw document.
   *
   * @param {string} code
   * @returns {Promise<object|null>}
   */
  async findByCode(code) {
    return this._model.findOne({ code }).lean();
  }

  /**
   * Insert a pre-generated link code (vs. issue() which generates internally).
   * Used when the caller (IdentityRouter) has already chosen the code value.
   *
   * @param {object} params
   * @param {string} params.code
   * @param {import('mongoose').Types.ObjectId|string} params.pria_user_id
   * @param {import('mongoose').Types.ObjectId|string} params.synaps_user_id
   * @param {Date}   params.expires_at
   * @returns {Promise<object>}
   */
  async create({ code, pria_user_id, synaps_user_id, expires_at }) {
    const doc = await this._model.create({
      code,
      pria_user_id,
      synaps_user_id,
      expires_at,
      redeemed_at: null,
    });
    this._logger.info(`[LinkCodeRepo] Created code ${code} (via .create alias)`);
    return doc;
  }

  /**
   * Mark a link code as redeemed.  Assumes the caller already verified the
   * row is unredeemed and unexpired (IdentityRouter does this in-memory).
   *
   * @param {string} code
   * @param {{ redeemed_by: {channel:string, external_id:string, external_team_id:string} }} opts
   * @returns {Promise<object|null>}  Updated doc or null if not found.
   */
  async markRedeemed(code, { redeemed_by }) {
    return this._model.findOneAndUpdate(
      { code },
      { $set: { redeemed_at: new Date(), redeemed_by } },
      { new: true },
    ).lean();
  }
}
