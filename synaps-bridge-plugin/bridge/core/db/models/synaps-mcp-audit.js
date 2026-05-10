/**
 * @file bridge/core/db/models/synaps-mcp-audit.js
 *
 * Mongoose schema and model factory for the `synaps_mcp_audit` collection.
 *
 * Spec reference: Phase 7 brief § synaps_mcp_audit
 *
 * Exports
 * -------
 *   synapsMcpAuditSchema        – the raw Schema (useful for testing without a DB).
 *   getSynapsMcpAuditModel(mongooseInstance)
 *                               – returns (or reuses) the compiled model bound to
 *                                 the given mongoose instance.  Pass a test-local
 *                                 mongoose instance in tests so models are scoped
 *                                 to the test connection.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Sub-schema for the optional `client_info` field, mirroring MCP
 * initialize.clientInfo.  All fields default to null.
 */
const clientInfoSchema = new Schema(
  {
    name:    { type: String, default: null },
    version: { type: String, default: null },
  },
  { _id: false },
);

/**
 * Primary schema matching Phase 7 brief `synaps_mcp_audit`.
 *
 * @type {import('mongoose').Schema}
 */
export const synapsMcpAuditSchema = new Schema(
  {
    ts: {
      type:     Date,
      required: [true, 'ts is required'],
      default:  Date.now,
    },
    synaps_user_id: {
      type:    Schema.Types.ObjectId,
      default: null,
    },
    institution_id: {
      type:    Schema.Types.ObjectId,
      default: null,
    },
    method: {
      type:     String,
      required: [true, 'method is required'],
    },
    tool_name: {
      type:    String,
      default: null,
    },
    outcome: {
      type:     String,
      required: [true, 'outcome is required'],
      enum:     {
        values:  ['ok', 'denied', 'error', 'rate_limited'],
        message: 'outcome must be one of: ok, denied, error, rate_limited',
      },
    },
    duration_ms: {
      type:     Number,
      required: [true, 'duration_ms is required'],
      min:      [0, 'duration_ms must be >= 0'],
    },
    error_code: {
      type:    String,
      default: null,
    },
    client_info: {
      type:    clientInfoSchema,
      default: () => ({ name: null, version: null }),
    },
  },
  {
    collection: 'synaps_mcp_audit',
  },
);

// ── Indexes ───────────────────────────────────────────────────────────────────

/**
 * TTL index on ts — MongoDB automatically removes audit records after 30 days.
 */
synapsMcpAuditSchema.index(
  { ts: -1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);

/**
 * Compound index for user-scoped queries.
 */
synapsMcpAuditSchema.index({ synaps_user_id: 1, ts: -1 });

/**
 * Compound index for institution-scoped queries.
 */
synapsMcpAuditSchema.index({ institution_id: 1, ts: -1 });

/**
 * Return (or create) the SynapsMcpAudit model bound to the given mongoose instance.
 *
 * Using a factory avoids the "Cannot overwrite model once compiled" error that
 * occurs when tests import multiple times or share a mongoose instance.
 *
 * @param {import('mongoose').Mongoose} mongooseInstance
 * @returns {import('mongoose').Model}
 */
export function getSynapsMcpAuditModel(mongooseInstance) {
  if (mongooseInstance.models && mongooseInstance.models.SynapsMcpAudit) {
    return mongooseInstance.models.SynapsMcpAudit;
  }
  return mongooseInstance.model('SynapsMcpAudit', synapsMcpAuditSchema);
}
