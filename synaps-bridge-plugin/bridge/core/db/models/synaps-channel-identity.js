/**
 * @file bridge/core/db/models/synaps-channel-identity.js
 *
 * Mongoose schema and model factory for the `synaps_channel_identities` collection.
 *
 * Spec reference: PLATFORM.SPEC.md § 3.2 (synaps_channel_identity) / Phase 3 brief § Data model additions
 *
 * Exports
 * -------
 *   synapsChannelIdentitySchema    – the raw Schema (useful for testing without a DB).
 *   getSynapsChannelIdentityModel(mongooseInstance)
 *                                  – returns (or reuses) the compiled model bound to
 *                                    the given mongoose instance.  Pass a test-local
 *                                    mongoose instance in tests so models are scoped
 *                                    to the test connection.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/** Channel enum values shared across Phase 3 identity models. */
const CHANNEL_VALUES = ['slack', 'web', 'discord', 'telegram', 'teams'];

/** Link-method enum values. */
const LINK_METHOD_VALUES = ['oauth', 'magic_code', 'admin', 'inferred'];

/**
 * Primary schema matching spec § 3.2 `synaps_channel_identity`.
 *
 * @type {import('mongoose').Schema}
 */
export const synapsChannelIdentitySchema = new Schema(
  {
    synaps_user_id: {
      type:     Schema.Types.ObjectId,
      ref:      'SynapsUser',
      required: [true, 'synaps_user_id is required'],
    },
    channel: {
      type:     String,
      enum:     {
        values:  CHANNEL_VALUES,
        message: '{VALUE} is not a valid channel',
      },
      required: [true, 'channel is required'],
    },
    external_id: {
      type:     String,
      required: [true, 'external_id is required'],
    },
    external_team_id: {
      type:    String,
      default: '',
    },
    display_name: {
      type: String,
    },
    linked_at: {
      type:    Date,
      default: Date.now,
    },
    link_method: {
      type:     String,
      enum:     {
        values:  LINK_METHOD_VALUES,
        message: '{VALUE} is not a valid link_method',
      },
      required: [true, 'link_method is required'],
    },
  },
  {
    collection: 'synaps_channel_identities',
  },
);

// ── Indexes ──────────────────────────────────────────────────────────────────

synapsChannelIdentitySchema.index(
  { channel: 1, external_id: 1, external_team_id: 1 },
  { unique: true },
);

/**
 * Return (or create) the SynapsChannelIdentity model bound to the given mongoose instance.
 *
 * Using a factory avoids the "Cannot overwrite model once compiled" error that
 * occurs when tests import multiple times or share a mongoose instance.
 *
 * @param {import('mongoose').Mongoose} mongooseInstance
 * @returns {import('mongoose').Model}
 */
export function getSynapsChannelIdentityModel(mongooseInstance) {
  // Reuse if already registered on this instance.
  if (mongooseInstance.models && mongooseInstance.models.SynapsChannelIdentity) {
    return mongooseInstance.models.SynapsChannelIdentity;
  }
  return mongooseInstance.model('SynapsChannelIdentity', synapsChannelIdentitySchema);
}
