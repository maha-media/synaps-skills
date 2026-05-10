/**
 * @file bridge/core/db/models/synaps-mcp-tool-acl.js
 *
 * Mongoose schema and model factory for the `synaps_mcp_tool_acls` collection.
 *
 * Spec reference: Phase 9 brief § Track 4 — Per-tool ACL resolver
 *
 * Exports
 * -------
 *   synapsMcpToolAclSchema           – the raw Schema (useful for testing without a DB).
 *   getSynapsMcpToolAclModel(mongooseInstance)
 *                                    – returns (or reuses) the compiled model bound to
 *                                      the given mongoose instance.  Pass a test-local
 *                                      mongoose instance in tests so models are scoped
 *                                      to the test connection.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Primary schema matching Phase 9 brief `synaps_mcp_tool_acls`.
 *
 * tool_name '*' acts as a wildcard covering all tools for that user.
 * policy 'deny' wins over 'allow' when a wildcard deny is present
 * (security default enforced in the resolver, not here).
 *
 * @type {import('mongoose').Schema}
 */
export const synapsMcpToolAclSchema = new Schema(
  {
    synaps_user_id: {
      type:     Schema.Types.ObjectId,
      ref:      'synaps_user',
      required: [true, 'synaps_user_id is required'],
    },
    tool_name: {
      type:     String,
      required: [true, 'tool_name is required'],
    },
    policy: {
      type:     String,
      required: [true, 'policy is required'],
      enum: {
        values:  ['allow', 'deny'],
        message: 'policy must be one of: allow, deny',
      },
    },
    reason: {
      type:    String,
      default: '',
    },
    created_at: {
      type:    Date,
      default: () => new Date(),
    },
    expires_at: {
      type:    Date,
      default: null,
    },
  },
  {
    collection: 'synaps_mcp_tool_acls',
  },
);

// ── Indexes ───────────────────────────────────────────────────────────────────

/**
 * Compound unique index on (synaps_user_id, tool_name).
 *
 * Ensures only one ACL entry exists per user+tool combination.
 * Upserts use this pair as the composite key.
 */
synapsMcpToolAclSchema.index(
  { synaps_user_id: 1, tool_name: 1 },
  { unique: true },
);

/**
 * Sparse TTL index on expires_at.
 *
 * MongoDB will automatically remove documents once expires_at passes.
 * Sparse means documents with expires_at: null are excluded from the index.
 */
synapsMcpToolAclSchema.index(
  { expires_at: 1 },
  { expireAfterSeconds: 0, sparse: true },
);

/**
 * Return (or create) the SynapsMcpToolAcl model bound to the given mongoose instance.
 *
 * Using a factory avoids the "Cannot overwrite model once compiled" error that
 * occurs when tests import multiple times or share a mongoose instance.
 *
 * @param {import('mongoose').Mongoose} mongooseInstance
 * @returns {import('mongoose').Model}
 */
export function getSynapsMcpToolAclModel(mongooseInstance) {
  if (mongooseInstance.models && mongooseInstance.models.SynapsMcpToolAcl) {
    return mongooseInstance.models.SynapsMcpToolAcl;
  }
  return mongooseInstance.model('SynapsMcpToolAcl', synapsMcpToolAclSchema);
}
