/**
 * @file bridge/core/db/models/synaps-hook.js
 *
 * Mongoose schema and model factory for the `synaps_hook` collection.
 *
 * Spec reference: PLATFORM.SPEC.md § 10.2 (HookBus) + Phase 6 brief § 6.1
 *
 * Exports
 * -------
 *   makeHookModel(mongooseInstance)
 *     – Returns (or reuses) the compiled Hook model bound to the given
 *       mongoose instance.  Pass a test-local instance in tests to keep models
 *       scoped to the test connection and avoid "Cannot overwrite model" errors.
 */

/**
 * Return (or create) the Hook model bound to the given mongoose instance.
 *
 * Schema
 * ------
 *   scope.type   {String}   – 'user' | 'institution' | 'global'
 *   scope.id     {ObjectId} – null when type === 'global'; required otherwise
 *   event        {String}   – lifecycle event enum (5 values)
 *   matcher      {Object}   – optional sub-selectors (tool, channel)
 *   action.type  {String}   – 'webhook' (v0 only)
 *   action.config.url       – HTTPS endpoint URL
 *   action.config.secret    – HMAC-SHA256 signing key (never returned in API)
 *   action.config.timeout_ms – per-call timeout (default 5000)
 *   enabled      {Boolean}  – toggle without deleting
 *
 * Indexes
 * -------
 *   { event: 1, enabled: 1 }        – hot path for HookBus.emit lookup
 *   { 'scope.type': 1, 'scope.id': 1 }
 *
 * @param {import('mongoose').Mongoose} mongooseInstance
 * @returns {import('mongoose').Model}
 */
export function makeHookModel(mongooseInstance) {
  // Reuse an already-compiled model to avoid duplicate-model errors.
  if (mongooseInstance.models && mongooseInstance.models.Hook) {
    return mongooseInstance.models.Hook;
  }

  const { Schema } = mongooseInstance;

  const hookSchema = new Schema(
    {
      scope: {
        type: {
          type: String,
          required: [true, 'scope.type is required'],
          enum: {
            values:  ['user', 'institution', 'global'],
            message: '{VALUE} is not a valid scope type',
          },
        },
        id: {
          type:    Schema.Types.ObjectId,
          default: null,
          validate: {
            validator(v) {
              // `this` is the document being validated.
              // scope.id is required when scope.type is not 'global'.
              const scopeType = this.scope && this.scope.type;
              if (scopeType && scopeType !== 'global') {
                return v != null;
              }
              return true;
            },
            message: 'scope.id is required when scope.type is not "global"',
          },
        },
      },

      event: {
        type:     String,
        required: [true, 'event is required'],
        enum: {
          values:  ['pre_tool', 'post_tool', 'pre_stream', 'post_stream', 'on_error'],
          message: '{VALUE} is not a valid hook event',
        },
      },

      matcher: {
        tool:    { type: String, default: null },
        channel: { type: String, default: null },
      },

      action: {
        type: {
          type: String,
          required: [true, 'action.type is required'],
          enum: {
            values:  ['webhook'],
            message: '{VALUE} is not a valid action type (v0 supports webhook only)',
          },
        },
        config: {
          url: {
            type:     String,
            required: [true, 'action.config.url is required'],
          },
          secret: {
            type:     String,
            required: [true, 'action.config.secret is required'],
          },
          timeout_ms: {
            type:    Number,
            default: 5000,
          },
        },
      },

      enabled: {
        type:    Boolean,
        default: true,
      },
    },
    {
      collection: 'synaps_hook',
      timestamps: {
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
  );

  // Hot-path index: HookBus.emit scans by event + enabled
  hookSchema.index({ event: 1, enabled: 1 });

  // Scope lookup index
  hookSchema.index({ 'scope.type': 1, 'scope.id': 1 });

  return mongooseInstance.model('Hook', hookSchema);
}
