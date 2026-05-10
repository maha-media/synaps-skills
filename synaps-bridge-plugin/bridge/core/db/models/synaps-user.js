/**
 * @file bridge/core/db/models/synaps-user.js
 *
 * Mongoose schema and model factory for the `synaps_users` collection.
 *
 * Spec reference: PLATFORM.SPEC.md § 3.2 (synaps_user) / Phase 3 brief § Data model additions
 *
 * Exports
 * -------
 *   synapsUserSchema            – the raw Schema (useful for testing without a DB).
 *   getSynapsUserModel(mongooseInstance)
 *                               – returns (or reuses) the compiled model bound to
 *                                 the given mongoose instance.  Pass a test-local
 *                                 mongoose instance in tests so models are scoped
 *                                 to the test connection.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/** Channel enum values shared with synaps_channel_identity. */
const CHANNEL_VALUES = ['slack', 'web', 'discord', 'telegram', 'teams'];

/**
 * Primary schema matching spec § 3.2 `synaps_user`.
 *
 * @type {import('mongoose').Schema}
 */
export const synapsUserSchema = new Schema(
  {
    pria_user_id: {
      type:     Schema.Types.ObjectId,
      required: [true, 'pria_user_id is required'],
    },
    institution_id: {
      type: Schema.Types.ObjectId,
    },
    display_name: {
      type: String,
    },
    workspace_id: {
      type: Schema.Types.ObjectId,
      ref:  'SynapsWorkspace',
    },
    memory_namespace: {
      type:     String,
      required: [true, 'memory_namespace is required'],
    },
    default_channel: {
      type:    String,
      enum:    {
        values:  CHANNEL_VALUES,
        message: '{VALUE} is not a valid channel',
      },
      default: 'web',
    },
  },
  {
    collection: 'synaps_users',
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  },
);

// ── Indexes ──────────────────────────────────────────────────────────────────

synapsUserSchema.index({ pria_user_id: 1 }, { unique: true });
synapsUserSchema.index({ institution_id: 1 });

/**
 * Return (or create) the SynapsUser model bound to the given mongoose instance.
 *
 * Using a factory avoids the "Cannot overwrite model once compiled" error that
 * occurs when tests import multiple times or share a mongoose instance.
 *
 * @param {import('mongoose').Mongoose} mongooseInstance
 * @returns {import('mongoose').Model}
 */
export function getSynapsUserModel(mongooseInstance) {
  // Reuse if already registered on this instance.
  if (mongooseInstance.models && mongooseInstance.models.SynapsUser) {
    return mongooseInstance.models.SynapsUser;
  }
  return mongooseInstance.model('SynapsUser', synapsUserSchema);
}
