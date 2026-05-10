/**
 * @file bridge/core/db/models/synaps-link-code.js
 *
 * Mongoose schema and model factory for the `synaps_link_codes` collection.
 *
 * Spec reference: Phase 3 brief § Data model additions (synaps_link_code)
 *
 * Exports
 * -------
 *   synapsLinkCodeSchema        – the raw Schema (useful for testing without a DB).
 *   getSynapsLinkCodeModel(mongooseInstance)
 *                               – returns (or reuses) the compiled model bound to
 *                                 the given mongoose instance.  Pass a test-local
 *                                 mongoose instance in tests so models are scoped
 *                                 to the test connection.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Sub-schema for the optional `redeemed_by` field, recording which channel
 * identity redeemed the link code.  All fields are optional.
 */
const redeemedBySchema = new Schema(
  {
    channel:          { type: String },
    external_id:      { type: String },
    external_team_id: { type: String },
  },
  { _id: false },
);

/**
 * Primary schema matching Phase 3 brief `synaps_link_code`.
 *
 * @type {import('mongoose').Schema}
 */
export const synapsLinkCodeSchema = new Schema(
  {
    code: {
      type:     String,
      required: [true, 'code is required'],
    },
    pria_user_id: {
      type:     Schema.Types.ObjectId,
      required: [true, 'pria_user_id is required'],
    },
    synaps_user_id: {
      type:     Schema.Types.ObjectId,
      required: [true, 'synaps_user_id is required'],
    },
    expires_at: {
      type:     Date,
      required: [true, 'expires_at is required'],
    },
    redeemed_at: {
      type:    Date,
      default: null,
    },
    redeemed_by: {
      type:    redeemedBySchema,
      default: () => ({}),
    },
    created_at: {
      type:    Date,
      default: Date.now,
    },
  },
  {
    collection: 'synaps_link_codes',
  },
);

// ── Indexes ──────────────────────────────────────────────────────────────────

/** Unique index on code — 6-char [A-Z0-9] codes must be globally unique. */
synapsLinkCodeSchema.index({ code: 1 }, { unique: true });

/**
 * TTL index on expires_at — MongoDB automatically removes expired documents.
 * expireAfterSeconds: 0 means "remove at the instant expires_at is reached".
 */
synapsLinkCodeSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

/**
 * Return (or create) the SynapsLinkCode model bound to the given mongoose instance.
 *
 * Using a factory avoids the "Cannot overwrite model once compiled" error that
 * occurs when tests import multiple times or share a mongoose instance.
 *
 * @param {import('mongoose').Mongoose} mongooseInstance
 * @returns {import('mongoose').Model}
 */
export function getSynapsLinkCodeModel(mongooseInstance) {
  // Reuse if already registered on this instance.
  if (mongooseInstance.models && mongooseInstance.models.SynapsLinkCode) {
    return mongooseInstance.models.SynapsLinkCode;
  }
  return mongooseInstance.model('SynapsLinkCode', synapsLinkCodeSchema);
}
