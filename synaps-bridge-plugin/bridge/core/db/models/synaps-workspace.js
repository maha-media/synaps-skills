/**
 * @file bridge/core/db/models/synaps-workspace.js
 *
 * Mongoose schema and model factory for the `synaps_workspaces` collection.
 *
 * Spec reference: PLATFORM.SPEC.md § 3.2 (synaps_workspace)
 *
 * Exports
 * -------
 *   synapsWorkspaceSchema  – the raw Schema (useful for testing without a DB).
 *   getSynapsWorkspaceModel(mongooseInstance)
 *                          – returns (or reuses) the compiled model bound to
 *                            the given mongoose instance.  Pass a test-local
 *                            mongoose instance in tests so models are scoped
 *                            to the test connection.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Sub-schema for resource limits.
 * All fields are optional – the workspace may not have limits set initially.
 */
const resourceLimitsSchema = new Schema(
  {
    cpu:    { type: Number },
    mem_mb: { type: Number },
    pids:   { type: Number },
  },
  { _id: false },
);

/**
 * Primary schema matching spec § 3.2 `synaps_workspace`.
 *
 * @type {import('mongoose').Schema}
 */
export const synapsWorkspaceSchema = new Schema(
  {
    synaps_user_id: {
      type:     Schema.Types.ObjectId,
      ref:      'SynapsUser',
      required: [true, 'synaps_user_id is required'],
      index:    true,
    },
    container_id: {
      type:   String,
      sparse: true,
      unique: true,
      index:  true,
    },
    state: {
      type:    String,
      enum:    {
        values:  ['provisioning', 'running', 'stopped', 'failed', 'reaped'],
        message: '{VALUE} is not a valid workspace state',
      },
      default: 'provisioning',
      index:   true,
    },
    image: {
      type:     String,
      required: [true, 'image is required'],
      default:  'synaps/workspace:0.1.0',
    },
    volume_path:    { type: String },
    vnc_url:        { type: String },
    rpc_socket:     { type: String },
    last_heartbeat: { type: Date, default: null, index: true },
    resource_limits: resourceLimitsSchema,
  },
  {
    collection:  'synaps_workspaces',
    timestamps:  { createdAt: 'created_at', updatedAt: 'updated_at' },
  },
);

/**
 * Return (or create) the SynapsWorkspace model bound to the given mongoose
 * instance.
 *
 * Using a factory avoids the "Cannot overwrite model once compiled" error that
 * occurs when tests import multiple times or share a mongoose instance.
 *
 * @param {import('mongoose').Mongoose} mongooseInstance
 * @returns {import('mongoose').Model}
 */
export function getSynapsWorkspaceModel(mongooseInstance) {
  // Reuse if already registered on this instance.
  if (mongooseInstance.models && mongooseInstance.models.SynapsWorkspace) {
    return mongooseInstance.models.SynapsWorkspace;
  }
  return mongooseInstance.model('SynapsWorkspace', synapsWorkspaceSchema);
}
