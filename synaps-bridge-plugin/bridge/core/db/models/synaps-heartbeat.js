/**
 * @file bridge/core/db/models/synaps-heartbeat.js
 *
 * Mongoose schema and model factory for the `synaps_heartbeat` collection.
 *
 * Spec reference: PLATFORM.SPEC.md § 9 (supervisor / heartbeats)
 *
 * Exports
 * -------
 *   makeHeartbeatModel(mongooseInstance)
 *     – Returns (or reuses) the compiled Heartbeat model bound to the given
 *       mongoose instance.  Pass a test-local instance in tests to keep models
 *       scoped to the test connection and avoid "Cannot overwrite model" errors.
 */

/**
 * Return (or create) the Heartbeat model bound to the given mongoose instance.
 *
 * Schema
 * ------
 *   component  {String}  – Which subsystem emitted the beat.
 *                          Enum: 'bridge' | 'workspace' | 'rpc' | 'scp'
 *   id         {String}  – Component-specific identifier (workspace_id,
 *                          session_id, etc.).
 *   ts         {Date}    – Timestamp of the last beat (managed manually; we do
 *                          NOT use Mongoose's built-in `timestamps` option).
 *   healthy    {Boolean} – Whether the component reported itself healthy.
 *   details    {Mixed}   – Free-form payload (cpu, memory, queue_depth, …).
 *
 * Indexes
 * -------
 *   { component: 1, id: 1 }  – unique compound key used as the upsert filter.
 *   { ts: 1 }                – supports stale-sweep range queries.
 *
 * @param {import('mongoose').Mongoose} mongooseInstance
 * @returns {import('mongoose').Model}
 */
export function makeHeartbeatModel(mongooseInstance) {
  // Reuse an already-compiled model on this instance to avoid duplicate-model
  // errors when the factory is called multiple times in the same process.
  if (mongooseInstance.models && mongooseInstance.models.Heartbeat) {
    return mongooseInstance.models.Heartbeat;
  }

  const { Schema } = mongooseInstance;

  const heartbeatSchema = new Schema(
    {
      component: {
        type:     String,
        required: [true, 'component is required'],
        enum: {
          values:  ['bridge', 'workspace', 'rpc', 'scp'],
          message: '{VALUE} is not a valid heartbeat component',
        },
      },
      id: {
        type:     String,
        required: [true, 'id is required'],
      },
      ts: {
        type:     Date,
        required: true,
        default:  Date.now,
      },
      healthy: {
        type:     Boolean,
        required: true,
        default:  true,
      },
      details: {
        type:    Schema.Types.Mixed,
        default: {},
      },
    },
    {
      collection: 'synaps_heartbeat',
      timestamps: false, // we manage `ts` ourselves
    },
  );

  // Compound unique index — upsert key for HeartbeatRepo.record()
  heartbeatSchema.index({ component: 1, id: 1 }, { unique: true });

  // Single-field index to support efficient stale-sweep range queries
  heartbeatSchema.index({ ts: 1 });

  return mongooseInstance.model('Heartbeat', heartbeatSchema);
}
