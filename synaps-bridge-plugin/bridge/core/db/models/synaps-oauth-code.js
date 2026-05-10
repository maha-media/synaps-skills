/**
 * @file bridge/core/db/models/synaps-oauth-code.js
 *
 * Mongoose schema and model factory for the `synaps_oauth_codes` collection.
 *
 * Stores short-lived authorization codes issued by the OAuth 2.1 authorize
 * endpoint.  Each code is single-use (redeemed_at is set atomically on
 * exchange) and expires after a configurable TTL (default 10 minutes).
 *
 * Spec reference: Phase 9 brief § Track 3 — OAuth 2.1 + PKCE; Wave C C1+C2.
 *
 * Exports
 * -------
 *   synapsOauthCodeSchema          – the raw Schema (useful for testing).
 *   getSynapsOauthCodeModel(mongooseInstance)
 *                                  – returns (or reuses) the compiled model
 *                                    bound to the given mongoose instance.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Schema for `synaps_oauth_codes`.
 *
 * code                  – 32-byte random base64url string; unique while unredeemed.
 * client_id             – OAuth client identifier from the authorize request.
 * synaps_user_id        – The authenticated Synaps user who granted consent.
 * institution_id        – The institution the user belongs to.
 * redirect_uri          – Exact redirect_uri validated at authorization time.
 * code_challenge        – PKCE code challenge (base64url(sha256(verifier))).
 * code_challenge_method – Must be 'S256'; other methods are rejected at issuance.
 * scope                 – Space-separated scope string (may be empty).
 * expires_at            – Absolute expiry; MongoDB TTL index removes stale docs.
 * redeemed_at           – Set atomically by /token; null means unredeemed.
 * created_at            – Document creation timestamp.
 *
 * @type {import('mongoose').Schema}
 */
export const synapsOauthCodeSchema = new Schema(
  {
    code: {
      type:     String,
      required: [true, 'code is required'],
    },
    client_id: {
      type:     String,
      required: [true, 'client_id is required'],
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
    redirect_uri: {
      type:     String,
      required: [true, 'redirect_uri is required'],
    },
    code_challenge: {
      type:     String,
      required: [true, 'code_challenge is required'],
    },
    code_challenge_method: {
      type:    String,
      enum:    ['S256'],
      default: 'S256',
    },
    scope: {
      type:    String,
      default: '',
    },
    expires_at: {
      type:     Date,
      required: [true, 'expires_at is required'],
    },
    redeemed_at: {
      type:    Date,
      default: null,
    },
    created_at: {
      type:    Date,
      default: () => new Date(),
    },
  },
  {
    collection: 'synaps_oauth_codes',
  },
);

// ── Indexes ───────────────────────────────────────────────────────────────────

/**
 * TTL index: MongoDB automatically removes documents whose `expires_at`
 * is in the past.  `expireAfterSeconds: 0` means expire exactly at the
 * date stored in the field.
 */
synapsOauthCodeSchema.index(
  { expires_at: 1 },
  { expireAfterSeconds: 0 },
);

/**
 * Partial unique index on `code` where `redeemed_at` is null.
 *
 * Once a code is redeemed (redeemed_at set), the uniqueness constraint is
 * lifted, allowing historical records without key conflicts.
 */
synapsOauthCodeSchema.index(
  { code: 1 },
  {
    unique:                  true,
    partialFilterExpression: { redeemed_at: null },
  },
);

/** Supporting index for per-client and per-user queries. */
synapsOauthCodeSchema.index({ client_id: 1 });
synapsOauthCodeSchema.index({ synaps_user_id: 1 });

/**
 * Return (or create) the SynapsOauthCode model bound to the given mongoose instance.
 *
 * Using a factory avoids the "Cannot overwrite model once compiled" error when
 * tests import multiple times or share a mongoose instance.
 *
 * @param {import('mongoose').Mongoose} mongooseInstance
 * @returns {import('mongoose').Model}
 */
export function getSynapsOauthCodeModel(mongooseInstance) {
  if (mongooseInstance.models && mongooseInstance.models.SynapsOauthCode) {
    return mongooseInstance.models.SynapsOauthCode;
  }
  return mongooseInstance.model('SynapsOauthCode', synapsOauthCodeSchema);
}
