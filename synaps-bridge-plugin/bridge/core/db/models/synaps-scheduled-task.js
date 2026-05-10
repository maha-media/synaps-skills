/**
 * @file bridge/core/db/models/synaps-scheduled-task.js
 *
 * Mongoose schema and model factory for the `synaps_scheduled_task` collection.
 *
 * Spec reference: PHASE_6_BRIEF.md §6.1 (scheduled-task schema)
 *
 * Exports
 * -------
 *   makeScheduledTaskModel(mongooseInstance)
 *     – Returns (or reuses) the compiled ScheduledTask model bound to the given
 *       mongoose instance.  Pass a test-local instance in tests to keep models
 *       scoped to the test connection and avoid "Cannot overwrite model" errors.
 *
 * Cron validation
 * ---------------
 *   A lightweight regex sanity-check is applied to `cron` at the schema level.
 *   Fine-grained validation (e.g. validating range limits per field) is
 *   intentionally deferred to agenda-js, which validates the expression at
 *   schedule time.
 *
 * TODO: If cron-parser is already present in the dependency tree, replace the
 *       regex guard below with `import { parseExpression } from 'cron-parser'`
 *       for richer validation.  Do NOT add cron-parser as a new top-level dep.
 */

/**
 * Very permissive cron sanity-check.
 * Accepts standard 5-field POSIX cron strings, including named day/month
 * abbreviations and common shorthand like `@daily`.
 *
 * Examples that pass: '0 9 * * MON', 'STAR/15 * * * *', '@daily'
 * Examples that fail: 'not-a-cron', '', '1 2 3'
 *
 * @type {RegExp}
 */
const CRON_SANITY_RE = /^(@(annually|yearly|monthly|weekly|daily|hourly|reboot))|(@every\s+\d+[smhd])|(\S+\s+\S+\s+\S+\s+\S+\s+\S+)$/;

/**
 * Return (or create) the ScheduledTask model bound to the given mongoose
 * instance.
 *
 * Schema
 * ------
 *   synaps_user_id   {ObjectId}       – FK → synaps_user
 *   institution_id   {ObjectId}       – FK → pria institution (multi-tenant scope)
 *   agenda_job_id    {ObjectId}       – FK → agendajobs._id
 *   name             {String}         – Human-readable label, e.g. 'Monday GitHub PR digest'
 *   cron             {String}         – Cron expression, e.g. '0 9 * * MON'
 *                                       Sanity-checked by regex; fine validation deferred to agenda.
 *   channel          {String}         – Delivery target (references default_channel pattern)
 *   prompt           {String}         – Payload sent as synthetic inbound text
 *   enabled          {Boolean}        – Whether the task is active; defaults to true
 *   last_run         {Date|null}      – Timestamp of the most recent execution
 *   next_run         {Date|null}      – Timestamp of the next scheduled execution
 *   created_at       {Date}           – Managed via Mongoose timestamps
 *   updated_at       {Date}           – Managed via Mongoose timestamps
 *
 * Indexes
 * -------
 *   { synaps_user_id: 1, enabled: 1 }  – list-by-user queries filtered by enabled
 *   { agenda_job_id: 1 }               – lookup on fire (agenda job → task row)
 *
 * @param {import('mongoose').Mongoose} mongooseInstance
 * @returns {import('mongoose').Model}
 */
export function makeScheduledTaskModel(mongooseInstance) {
  // Reuse an already-compiled model on this instance to avoid duplicate-model
  // errors when the factory is called multiple times in the same process.
  if (mongooseInstance.models && mongooseInstance.models.ScheduledTask) {
    return mongooseInstance.models.ScheduledTask;
  }

  const { Schema } = mongooseInstance;

  const scheduledTaskSchema = new Schema(
    {
      synaps_user_id: {
        type:     Schema.Types.ObjectId,
        required: [true, 'synaps_user_id is required'],
        ref:      'SynapsUser',
      },

      institution_id: {
        type:     Schema.Types.ObjectId,
        required: [true, 'institution_id is required'],
        ref:      'Institution',
      },

      agenda_job_id: {
        type:    Schema.Types.ObjectId,
        default: null,
        ref:     'AgendaJob',
      },

      name: {
        type:     String,
        required: [true, 'name is required'],
        trim:     true,
      },

      cron: {
        type:     String,
        required: [true, 'cron is required'],
        trim:     true,
        validate: {
          /**
           * Sanity-check only.  Agenda validates the expression fully at
           * schedule time.  This guard catches obviously wrong strings like
           * plain text or empty values before they reach the DB.
           *
           * @param {string} v
           * @returns {boolean}
           */
          validator(v) {
            return CRON_SANITY_RE.test(v);
          },
          message: '"{VALUE}" does not look like a valid cron expression; fine validation is deferred to agenda',
        },
      },

      channel: {
        type:     String,
        required: [true, 'channel is required'],
        trim:     true,
      },

      prompt: {
        type:     String,
        required: [true, 'prompt is required'],
      },

      enabled: {
        type:    Boolean,
        default: true,
      },

      last_run: {
        type:    Date,
        default: null,
      },

      next_run: {
        type:    Date,
        default: null,
      },
    },
    {
      collection: 'synaps_scheduled_task',
      // Let Mongoose manage created_at / updated_at via standard timestamps
      timestamps: {
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
  );

  // ── Indexes ─────────────────────────────────────────────────────────────────

  // Primary list-by-user query path: fetch tasks for a user, optionally filtered
  // by enabled state.
  scheduledTaskSchema.index({ synaps_user_id: 1, enabled: 1 });

  // Lookup-on-fire: agenda fires a job → bridge resolves the task row by
  // agenda_job_id to hydrate the full task for dispatch.
  scheduledTaskSchema.index({ agenda_job_id: 1 });

  return mongooseInstance.model('ScheduledTask', scheduledTaskSchema);
}
