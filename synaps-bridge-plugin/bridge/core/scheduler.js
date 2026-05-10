/**
 * @file bridge/core/scheduler.js
 *
 * Scheduler — wraps agenda-js to fire synthetic inbound events on a cron
 * schedule.  Each scheduled task stored in `synaps_scheduled_task` has an
 * associated agenda job.  When the job fires, the Scheduler reads the task
 * row from the repo, calls the injected `dispatcher` callback, then records
 * `last_run` / `next_run`.
 *
 * agenda v5 is a proper ESM package (`"type":"module"`).  Callers that need
 * to construct a real Agenda instance should import it directly:
 *
 *   import { Agenda } from 'agenda';
 *
 * `scheduler.js` itself does NOT import agenda at the module level — the
 * constructor receives a pre-built Agenda instance via dependency injection,
 * keeping this file free of hard runtime dependencies and making unit testing
 * trivial (pass a plain mock object).
 *
 * Spec reference: PHASE_6_BRIEF.md §6.4 / Wave B1 task list
 */

// ── constants ─────────────────────────────────────────────────────────────────

/** Single agenda job name used for all scheduled tasks. */
const JOB_NAME = 'synaps-scheduled-task';

// ── validation helpers ────────────────────────────────────────────────────────

/**
 * Very lightweight cron-expression validator.
 * Agenda itself validates when scheduling; this guard gives an early,
 * readable error instead of letting agenda throw deep inside Mongo writes.
 *
 * Accepts standard 5-field or 6-field (with seconds) expressions.
 */
function isValidCron(cron) {
  if (typeof cron !== 'string' || !cron.trim()) return false;
  const parts = cron.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}

// ── Error classes ─────────────────────────────────────────────────────────────

export class SchedulerValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchedulerValidationError';
  }
}

export class SchedulerDisabledError extends Error {
  constructor(message = 'Scheduler is disabled') {
    super(message);
    this.name = 'SchedulerDisabledError';
  }
}

// ── Noop logger ───────────────────────────────────────────────────────────────

const NOOP_LOGGER = {
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
};

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Scheduler wraps an Agenda instance with domain logic for synaps scheduled
 * tasks.
 *
 * @example
 * import { Agenda, Scheduler } from './scheduler.js';
 * const agenda    = new Agenda({ db: { address: mongoUri } });
 * const scheduler = new Scheduler({ agenda, repo, dispatcher, logger });
 * await scheduler.start();
 * const task = await scheduler.create({ synapsUserId, institutionId, name, cron, channel, prompt });
 * await scheduler.stop();
 */
export class Scheduler {
  /**
   * @param {object}   opts
   * @param {object}   opts.agenda      – Pre-built Agenda instance.
   * @param {object}   opts.repo        – ScheduledTaskRepo.
   * @param {Function} opts.dispatcher  – async (taskRow) => void — fires synthetic inbound event.
   * @param {object}   [opts.logger]    – Optional logger (debug/info/warn/error).
   */
  constructor({ agenda, repo, dispatcher, logger = NOOP_LOGGER }) {
    this._agenda     = agenda;
    this._repo       = repo;
    this._dispatcher = dispatcher;
    this._logger     = logger;
    this._started    = false;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Start agenda and register the internal job handler.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async start() {
    if (this._started) return;

    // Register the single internal job that handles ALL scheduled tasks.
    // The handler is registered before agenda.start() so agenda can pick up
    // any jobs that are already due on boot.
    this._agenda.define(JOB_NAME, async (job) => {
      const agendaJobId = String(job.attrs._id);
      let row;
      try {
        row = await this._repo.findByAgendaJobId(agendaJobId);
      } catch (err) {
        this._logger.warn('[Scheduler] failed to load task row on fire', {
          agendaJobId,
          err: err.message,
        });
        return; // do not crash agenda
      }

      if (!row) {
        this._logger.warn('[Scheduler] agenda job fired but no task row found', { agendaJobId });
        return;
      }

      if (!row.enabled) {
        this._logger.debug('[Scheduler] task is disabled, skipping', { id: String(row._id) });
        return;
      }

      try {
        await this._dispatcher(row);
      } catch (err) {
        this._logger.warn('[Scheduler] dispatcher error', {
          taskId:      String(row._id),
          agendaJobId,
          err:         err.message,
        });
        // NEVER rethrow — must not crash agenda's run loop
      }

      // Record timestamps.  Errors here are also non-fatal.
      const now     = new Date();
      const nextRun = job.attrs.nextRunAt ?? null;

      try {
        await this._repo.updateLastRun(String(row._id), now);
      } catch (err) {
        this._logger.warn('[Scheduler] updateLastRun failed', { taskId: String(row._id), err: err.message });
      }

      try {
        if (nextRun) {
          await this._repo.updateNextRun(String(row._id), nextRun);
        }
      } catch (err) {
        this._logger.warn('[Scheduler] updateNextRun failed', { taskId: String(row._id), err: err.message });
      }
    });

    await this._agenda.start();
    this._started = true;
    this._logger.info('[Scheduler] started');
  }

  /**
   * Stop agenda.  Best-effort — errors are swallowed.
   */
  async stop() {
    try {
      await this._agenda.stop();
      this._logger.info('[Scheduler] stopped');
    } catch (err) {
      this._logger.warn('[Scheduler] stop error (ignored)', { err: err.message });
    }
    this._started = false;
  }

  // ── Domain operations ───────────────────────────────────────────────────────

  /**
   * Create a new scheduled task.
   *
   * Validates inputs, persists the task row in the repo, schedules the agenda
   * job, then back-fills the `agenda_job_id` by patching the row via the
   * model reference the repo exposes (`this._repo._ScheduledTask`).
   *
   * @param {object} opts
   * @param {string} opts.synapsUserId   – Owner.
   * @param {string} opts.institutionId  – Tenant.
   * @param {string} opts.name           – Human label.
   * @param {string} opts.cron           – Cron expression.
   * @param {string} opts.channel        – Delivery channel.
   * @param {string} opts.prompt         – Synthetic inbound text.
   * @returns {Promise<{ id: string, agenda_job_id: string, next_run: Date|null }>}
   */
  async create({ synapsUserId, institutionId, name, cron, channel, prompt }) {
    // ── validation ────────────────────────────────────────────────────────────
    if (!synapsUserId)  throw new SchedulerValidationError('synapsUserId is required');
    if (!institutionId) throw new SchedulerValidationError('institutionId is required');
    if (!name)          throw new SchedulerValidationError('name is required');
    if (!channel)       throw new SchedulerValidationError('channel is required');
    if (!prompt)        throw new SchedulerValidationError('prompt is required');
    if (!cron)          throw new SchedulerValidationError('cron is required');
    if (!isValidCron(cron)) throw new SchedulerValidationError(`invalid cron expression: "${cron}"`);

    // ── persist stub row (no agenda_job_id yet) ───────────────────────────────
    const row    = await this._repo.create({
      synapsUserId,
      institutionId,
      name,
      cron,
      channel,
      prompt,
      agendaJobId: null,
    });

    const taskId = String(row._id);

    // ── schedule with agenda ──────────────────────────────────────────────────
    // Pass taskId as job data so the handler can cross-reference quickly.
    let agendaJob;
    try {
      agendaJob = await this._agenda.every(cron, JOB_NAME, { taskId });
    } catch (err) {
      // Roll back the repo row so we don't leave an orphan.
      try { await this._repo.remove(taskId); } catch { /* ignore */ }
      throw new SchedulerValidationError(`agenda rejected cron "${cron}": ${err.message}`);
    }

    const agendaJobId = String(agendaJob.attrs._id);
    const nextRun     = agendaJob.attrs.nextRunAt ?? null;

    // ── link agenda_job_id back into the repo row ─────────────────────────────
    // ScheduledTaskRepo has no dedicated patch method; we reach into its
    // internal Mongoose model reference if available.
    await this._patchAgendaJobId(taskId, agendaJobId);
    if (nextRun) {
      await this._repo.updateNextRun(taskId, nextRun);
    }

    this._logger.info('[Scheduler] task created', { taskId, agendaJobId, cron });

    return { id: taskId, agenda_job_id: agendaJobId, next_run: nextRun };
  }

  /**
   * List scheduled tasks for a user.
   *
   * @param {object} opts
   * @param {string} opts.synapsUserId
   * @returns {Promise<object[]>}
   */
  async list({ synapsUserId }) {
    if (!synapsUserId) throw new SchedulerValidationError('synapsUserId is required');
    return this._repo.listByUser({ synapsUserId });
  }

  /**
   * Remove a scheduled task by its repo `_id`.
   *
   * Cancels the corresponding agenda job then removes the repo row.
   *
   * @param {string} id – Task repo `_id`.
   * @returns {Promise<{ ok: true }>}
   */
  async remove(id) {
    if (!id) throw new SchedulerValidationError('id is required');

    const row = await this._repo.findById(id);
    if (!row) {
      // Nothing to do — treat as success so remove is idempotent.
      return { ok: true };
    }

    // Cancel the agenda job first.
    if (row.agenda_job_id) {
      try {
        await this._agenda.cancel({ _id: row.agenda_job_id });
      } catch (err) {
        this._logger.warn('[Scheduler] cancel agenda job failed (continuing)', {
          agendaJobId: String(row.agenda_job_id),
          err:         err.message,
        });
      }
    }

    await this._repo.remove(id);
    this._logger.info('[Scheduler] task removed', { taskId: id });

    return { ok: true };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Patch the `agenda_job_id` field on the task document.
   *
   * ScheduledTaskRepo does not expose a generic patch method, so we reach into
   * the underlying Mongoose model via a stored reference.  The model is held
   * by the repo as `_ScheduledTask`.  In test environments the repo mock
   * exposes the same `_ScheduledTask` shim to keep this working.
   *
   * @param {string} taskId
   * @param {string} agendaJobId
   */
  async _patchAgendaJobId(taskId, agendaJobId) {
    const model = this._repo._ScheduledTask;
    if (model && typeof model.findByIdAndUpdate === 'function') {
      await model.findByIdAndUpdate(taskId, { $set: { agenda_job_id: agendaJobId } });
    }
    // In tests the repo mock handles state; no-op if model is absent.
  }
}

// ── NoopScheduler ─────────────────────────────────────────────────────────────

/**
 * Drop-in replacement for Scheduler when the scheduler feature is disabled.
 * Every domain operation rejects with SchedulerDisabledError so callers can
 * handle the disabled state uniformly.
 *
 * start() / stop() are lifecycle methods and are no-ops (not errors) so
 * BridgeDaemon can call them unconditionally.
 */
export class NoopScheduler {
  async start()  { /* lifecycle no-op */ }
  async stop()   { /* lifecycle no-op */ }
  async create() { throw new SchedulerDisabledError(); }
  async list()   { throw new SchedulerDisabledError(); }
  async remove() { throw new SchedulerDisabledError(); }
}
