/**
 * @file bridge/core/mcp/mcp-token-resolver.js
 *
 * Helpers and resolver class for MCP bearer tokens.
 *
 * - `hashToken(rawToken)`    — SHA-256 hex digest of a raw token string.
 * - `generateRawToken()`     — Cryptographically-random 32-byte raw token (64 hex chars).
 * - `McpTokenResolver`       — Resolves an MCP-Token header value to a user context.
 *
 * Spec reference: Phase 7 brief § Wave B1 — McpTokenResolver
 */

import { createHash, randomBytes } from 'node:crypto';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * SHA-256 of the raw token, hex-encoded, lowercase.
 *
 * Exported as a stand-alone helper so callers can pre-hash before write.
 *
 * @param {string} rawToken
 * @returns {string}
 */
export function hashToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    throw new TypeError('hashToken: rawToken must be a non-empty string');
  }
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Generate a new raw token (32 bytes → 64 lowercase hex chars).
 * Returned ONCE to the caller — never stored.
 *
 * @returns {string}
 */
export function generateRawToken() {
  return randomBytes(32).toString('hex');
}

// ── McpTokenResolver ──────────────────────────────────────────────────────────

export class McpTokenResolver {
  /**
   * @param {object} opts
   * @param {object} opts.tokenRepo   — McpTokenRepo (Wave A1); must expose
   *                                    `.findActive(token_hash)` and `.touch(_id)`.
   * @param {object} [opts.logger=console]
   */
  constructor({ tokenRepo, logger = console }) {
    if (!tokenRepo) throw new TypeError('McpTokenResolver: tokenRepo required');
    this._tokenRepo = tokenRepo;
    this._logger = logger;
  }

  /**
   * Resolve a raw token to a user context.
   *
   * Hashes the raw token, looks it up in the repo, fires a best-effort
   * `touch()` on hit, then returns the user context.
   *
   * The raw token and the full hash are NEVER logged at any level.
   *
   * @param {string} rawToken
   * @returns {Promise<{synaps_user_id, institution_id, token_id} | null>}
   *   `null` when the token is invalid, expired, revoked, or on repo error.
   */
  async resolve(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') return null;

    const hash = hashToken(rawToken);

    let row;
    try {
      row = await this._tokenRepo.findActive(hash);
    } catch (err) {
      this._logger.warn?.('McpTokenResolver: findActive failed', {
        err:        err?.message,
        hashPrefix: hash.slice(0, 8),   // first 8 chars only — never the full hash
      });
      return null;
    }

    if (!row) return null;

    // Best-effort touch — never fail the resolution on touch error.
    this._tokenRepo.touch(row._id).catch((err) => {
      this._logger.warn?.('McpTokenResolver: touch failed', {
        token_id: String(row._id),      // coerce ObjectId → string
        err:      err?.message,
      });
    });

    return {
      synaps_user_id: row.synaps_user_id,
      institution_id: row.institution_id,
      token_id:       row._id,
    };
  }
}
