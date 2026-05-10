/**
 * @file bridge/core/db/models/synaps-mcp-token.js
 *
 * Mongoose schema and model factory for the `synaps_mcp_tokens` collection.
 *
 * Spec reference: Phase 7 brief § Wave A1 — synaps_mcp_token
 *
 * Exports
 * -------
 *   synapsMcpTokenSchema          – the raw Schema (useful for testing without a DB).
 *   getSynapsMcpTokenModel(mongooseInstance)
 *                                 – returns (or reuses) the compiled model bound to
 *                                   the given mongoose instance.  Pass a test-local
 *                                   mongoose instance in tests so models are scoped
 *                                   to the test connection.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Primary schema matching Phase 7 brief `synaps_mcp_token`.
 *
 * token_hash stores the SHA-256 hex digest of the raw bearer token.
 * The raw token is NEVER stored.
 *
 * @type {import('mongoose').Schema}
 */
export const synapsMcpTokenSchema = new Schema(
  {
    token_hash: {
      type:      String,
      required:  [true, 'token_hash is required'],
      lowercase: true,
    },
    synaps_user_id: {
      type:     Schema.Types.ObjectId,
      ref:      'synaps_user',
      required: [true, 'synaps_user_id is required'],
    },
    institution_id: {
      type:     Schema.Types.ObjectId,
      ref:      'institution',
      required: [true, 'institution_id is required'],
    },
    name: {
      type:     String,
      required: [true, 'name is required'],
    },
    scopes: {
      type:    [String],
      default: () => ['*'],
    },
    last_used_at: {
      type:    Date,
      default: null,
    },
    created_at: {
      type:    Date,
      default: Date.now,
    },
    expires_at: {
      type:    Date,
      default: null,
    },
    revoked_at: {
      type:    Date,
      default: null,
    },
  },
  {
    collection: 'synaps_mcp_tokens',
  },
);

// ── Indexes ──────────────────────────────────────────────────────────────────

/**
 * Unique index on token_hash for non-revoked tokens only.
 *
 * The partial filter `{ revoked_at: null }` means two rows with the same
 * token_hash can coexist as long as one of them is revoked — allowing a
 * re-issued token to reuse the same hash without a duplicate-key error.
 */
synapsMcpTokenSchema.index(
  { token_hash: 1 },
  {
    unique:                true,
    partialFilterExpression: { revoked_at: null },
  },
);

/** Supporting index for per-user token listings. */
synapsMcpTokenSchema.index({ synaps_user_id: 1 });

/** Supporting index for per-institution token listings. */
synapsMcpTokenSchema.index({ institution_id: 1 });

/**
 * Return (or create) the SynapsMcpToken model bound to the given mongoose instance.
 *
 * Using a factory avoids the "Cannot overwrite model once compiled" error that
 * occurs when tests import multiple times or share a mongoose instance.
 *
 * @param {import('mongoose').Mongoose} mongooseInstance
 * @returns {import('mongoose').Model}
 */
export function getSynapsMcpTokenModel(mongooseInstance) {
  if (mongooseInstance.models && mongooseInstance.models.SynapsMcpToken) {
    return mongooseInstance.models.SynapsMcpToken;
  }
  return mongooseInstance.model('SynapsMcpToken', synapsMcpTokenSchema);
}
