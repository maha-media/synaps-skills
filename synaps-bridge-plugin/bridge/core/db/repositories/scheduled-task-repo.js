/**
 * @file bridge/core/db/repositories/scheduled-task-repo.js
 *
 * Repository class encapsulating all MongoDB queries for the
 * `synaps_scheduled_task` collection.
 *
 * All methods are pure DB calls — no background work, no timers, no events.
 *
 * Spec reference: PHASE_6_BRIEF.md §6.1 / Wave A1 task list
 */

/**
 * @typedef {import('mongoose').Model}   MongooseModel
 * @typedef {import('mongoose').Types.ObjectId} ObjectId
 *
 * @typedef {Object} ScheduledTaskRepoOptions
 * @property {MongooseModel} ScheduledTask - The ScheduledTask mongoose model.
 * @property {() => Date}    [now]         - Injectable clock; defaults to
 *                                           `() => new Date()`.
 */

/**
 * Repository for synaps_scheduled_task documents.
 *
 * Designed for dependency injection: pass a test-local `ScheduledTask` model
 * and an optional deterministic `now` function to keep tests fast and
 * predictable.
 */
export class ScheduledTaskRepo {
  /**
   * @param {ScheduledTaskRepoOptions} opts
   */
  constructor({ ScheduledTask, now = () => new Date() }) {
    this._ScheduledTask = ScheduledTask;
    this._now           = now;
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Create a new scheduled task document.
   *
   * @param {object}   data
   * @param {ObjectId|string} data.synapsUserId     – Owner user id.
   * @param {ObjectId|string} data.institutionId    – Institution / tenant id.
   * @param {string}   data.name                   – Human-readable label.
   * @param {string}   data.cron                   – Cron expression (sanity-checked by schema).
   * @param {string}   data.channel                – Delivery target channel.
   * @param {string}   data.prompt                 – Synthetic inbound text payload.
   * @param {ObjectId|string|null} [data.agendaJobId] – Agenda job id (filled after agenda
   *                                                     schedules the job; null until then).
   * @param {boolean}  [data.enabled=true]         – Whether the task is active.
   * @returns {Promise<object>} The saved mongoose document.
   */
  async create({
    synapsUserId,
    institutionId,
    name,
    cron,
    channel,
    prompt,
    agendaJobId = null,
    enabled     = true,
  }) {
    return this._ScheduledTask.create({
      synaps_user_id: synapsUserId,
      institution_id: institutionId,
      agenda_job_id:  agendaJobId,
      name,
      cron,
      channel,
      prompt,
      enabled,
    });
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Find a task by its `_id`.
   *
   * @param {string|ObjectId} id
   * @returns {Promise<object|null>} Lean document or null if not found.
   */
  async findById(id) {
    return this._ScheduledTask.findById(id).lean();
  }

  /**
   * Find a task by its `agenda_job_id`.
   *
   * Used on agenda fire to hydrate the full task row from the agenda job id.
   *
   * @param {string|ObjectId} agendaJobId
   * @returns {Promise<object|null>} Lean document or null if not found.
   */
  async findByAgendaJobId(agendaJobId) {
    return this._ScheduledTask.findOne({ agenda_job_id: agendaJobId }).lean();
  }

  /**
   * List tasks belonging to a user, optionally filtered by enabled state.
   *
   * Results are sorted by `created_at` ascending so callers get a stable,
   * chronological list.
   *
   * @param {object}   params
   * @param {string|ObjectId} params.synapsUserId  – User to list tasks for.
   * @param {boolean}  [params.enabled]            – If provided, filter by this
   *                                                 value; if omitted, return all.
   * @returns {Promise<object[]>} Array of lean documents.
   */
  async listByUser({ synapsUserId, enabled } = {}) {
    const filter = { synaps_user_id: synapsUserId };
    if (enabled !== undefined) {
      filter.enabled = enabled;
    }
    return this._ScheduledTask.find(filter).sort({ created_at: 1 }).lean();
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Enable or disable a task.
   *
   * @param {string|ObjectId} id
   * @param {boolean}         enabled
   * @returns {Promise<object|null>} Updated lean document, or null if not found.
   */
  async setEnabled(id, enabled) {
    return this._ScheduledTask.findByIdAndUpdate(
      id,
      { $set: { enabled } },
      { new: true, runValidators: true },
    ).lean();
  }

  /**
   * Record the `last_run` timestamp for a task.
   *
   * Typically called by the Scheduler immediately after a job fires.
   *
   * @param {string|ObjectId} id
   * @param {Date}            ts  – Timestamp of the run (defaults to `now()`).
   * @returns {Promise<object|null>} Updated lean document, or null if not found.
   */
  async updateLastRun(id, ts = this._now()) {
    return this._ScheduledTask.findByIdAndUpdate(
      id,
      { $set: { last_run: ts } },
      { new: true, runValidators: false },
    ).lean();
  }

  /**
   * Record the `next_run` timestamp for a task.
   *
   * Typically called by the Scheduler after computing the next agenda fire time.
   *
   * @param {string|ObjectId} id
   * @param {Date}            ts  – Timestamp of the next scheduled run.
   * @returns {Promise<object|null>} Updated lean document, or null if not found.
   */
  async updateNextRun(id, ts) {
    return this._ScheduledTask.findByIdAndUpdate(
      id,
      { $set: { next_run: ts } },
      { new: true, runValidators: false },
    ).lean();
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  /**
   * Delete a task by its `_id`.
   *
   * @param {string|ObjectId} id
   * @returns {Promise<boolean>} `true` if a document was deleted; `false` otherwise.
   */
  async remove(id) {
    const result = await this._ScheduledTask.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }
}
