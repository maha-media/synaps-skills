/**
 * @file bridge/core/scheduler.test.js
 *
 * Unit tests for Scheduler and NoopScheduler.
 *
 * Design: agenda is NEVER spun up for real here.  A mock agenda object with
 * vi.fn() spies replaces the real instance.  The ScheduledTaskRepo is also
 * mocked so there is no Mongo dependency.
 *
 * Spec reference: PHASE_6_BRIEF.md Wave B1 task list (≥ 20 tests)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Scheduler,
  NoopScheduler,
  SchedulerValidationError,
  SchedulerDisabledError,
} from './scheduler.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock agenda. */
function makeMockAgenda() {
  // Capture the handler registered via define() so tests can invoke it directly.
  let _capturedHandler = null;

  const agenda = {
    _capturedHandler: () => _capturedHandler,
    define: vi.fn((name, fn) => { _capturedHandler = fn; }),
    every:  vi.fn(async (_cron, _name, _data) => ({
      attrs: {
        _id:       'agenda-job-id-001',
        nextRunAt: new Date('2030-01-01T09:00:00Z'),
      },
    })),
    cancel: vi.fn(async () => 1),
    start:  vi.fn(async () => {}),
    stop:   vi.fn(async () => {}),
  };

  return agenda;
}

/** Build a mock ScheduledTaskRepo. */
function makeMockRepo(overrides = {}) {
  const store = new Map();
  let _idCounter = 1;

  const repo = {
    _store: store,
    create: vi.fn(async (data) => {
      const id  = `task-id-${_idCounter++}`;
      const row = {
        _id:            id,
        synaps_user_id: data.synapsUserId,
        institution_id: data.institutionId,
        agenda_job_id:  data.agendaJobId ?? null,
        name:           data.name,
        cron:           data.cron,
        channel:        data.channel,
        prompt:         data.prompt,
        enabled:        data.enabled ?? true,
      };
      store.set(id, row);
      return row;
    }),
    findById: vi.fn(async (id) => store.get(String(id)) ?? null),
    findByAgendaJobId: vi.fn(async (agendaJobId) => {
      for (const row of store.values()) {
        if (String(row.agenda_job_id) === String(agendaJobId)) return row;
      }
      return null;
    }),
    listByUser: vi.fn(async ({ synapsUserId }) =>
      [...store.values()].filter(r => String(r.synaps_user_id) === String(synapsUserId))
    ),
    setEnabled: vi.fn(async (id, enabled) => {
      const row = store.get(String(id));
      if (!row) return null;
      row.enabled = enabled;
      return row;
    }),
    updateLastRun: vi.fn(async (id, ts) => {
      const row = store.get(String(id));
      if (!row) return null;
      row.last_run = ts;
      return row;
    }),
    updateNextRun: vi.fn(async (id, ts) => {
      const row = store.get(String(id));
      if (!row) return null;
      row.next_run = ts;
      return row;
    }),
    remove: vi.fn(async (id) => {
      return store.delete(String(id));
    }),
    // Expose _ScheduledTask so _patchAgendaJobId can set agenda_job_id
    _ScheduledTask: {
      findByIdAndUpdate: vi.fn(async (id, update) => {
        const row = store.get(String(id));
        if (row && update.$set) Object.assign(row, update.$set);
        return row;
      }),
    },
    ...overrides,
  };

  return repo;
}

/** Build a mock logger that records calls. */
function makeMockLogger() {
  return {
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  };
}

/** Valid create() payload. */
const VALID_CREATE = {
  synapsUserId:  'user-001',
  institutionId: 'inst-001',
  name:          'Daily digest',
  cron:          '0 9 * * *',
  channel:       '#general',
  prompt:        'Post the daily digest',
};

// ── Scheduler ─────────────────────────────────────────────────────────────────

describe('Scheduler', () => {

  // ── lifecycle ──────────────────────────────────────────────────────────────

  describe('start() / stop()', () => {
    it('calls agenda.start() on first start()', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });

      await scheduler.start();
      expect(agenda.start).toHaveBeenCalledOnce();
    });

    it('registers a job definition for JOB_NAME on start()', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });

      await scheduler.start();
      expect(agenda.define).toHaveBeenCalledOnce();
      const [registeredName] = agenda.define.mock.calls[0];
      expect(registeredName).toBe('synaps-scheduled-task');
    });

    it('is idempotent — second start() does not call agenda.start() again', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });

      await scheduler.start();
      await scheduler.start();
      expect(agenda.start).toHaveBeenCalledOnce();
    });

    it('calls agenda.stop() on stop()', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });

      await scheduler.start();
      await scheduler.stop();
      expect(agenda.stop).toHaveBeenCalledOnce();
    });

    it('stop() is idempotent — does not throw if already stopped', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });

      await scheduler.start();
      await scheduler.stop();
      await expect(scheduler.stop()).resolves.toBeUndefined();
    });

    it('stop() swallows agenda.stop() errors', async () => {
      const agenda     = makeMockAgenda();
      agenda.stop      = vi.fn().mockRejectedValue(new Error('mongo gone'));
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const logger     = makeMockLogger();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher, logger });

      await scheduler.start();
      await expect(scheduler.stop()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // ── create() ──────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('persists the task row in the repo', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });
      await scheduler.start();

      await scheduler.create(VALID_CREATE);
      expect(repo.create).toHaveBeenCalledOnce();
      const createArg = repo.create.mock.calls[0][0];
      expect(createArg.synapsUserId).toBe('user-001');
      expect(createArg.cron).toBe('0 9 * * *');
    });

    it('calls agenda.every() with the cron expression and job name', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });
      await scheduler.start();

      await scheduler.create(VALID_CREATE);
      expect(agenda.every).toHaveBeenCalledOnce();
      const [cronArg, nameArg] = agenda.every.mock.calls[0];
      expect(cronArg).toBe('0 9 * * *');
      expect(nameArg).toBe('synaps-scheduled-task');
    });

    it('returns { id, agenda_job_id, next_run }', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });
      await scheduler.start();

      const result = await scheduler.create(VALID_CREATE);
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('agenda_job_id', 'agenda-job-id-001');
      expect(result).toHaveProperty('next_run');
    });

    it('patches agenda_job_id back into the repo row', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });
      await scheduler.start();

      const { id } = await scheduler.create(VALID_CREATE);
      const row = await repo.findById(id);
      expect(String(row.agenda_job_id)).toBe('agenda-job-id-001');
    });

    it('rolls back the repo row if agenda.every() throws', async () => {
      const agenda  = makeMockAgenda();
      agenda.every  = vi.fn().mockRejectedValue(new Error('bad cron'));
      const repo    = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });
      await scheduler.start();

      await expect(scheduler.create(VALID_CREATE)).rejects.toThrow(SchedulerValidationError);
      // repo should have the row removed (remove called)
      expect(repo.remove).toHaveBeenCalled();
    });
  });

  // ── list() ────────────────────────────────────────────────────────────────

  describe('list()', () => {
    it('proxies to repo.listByUser with synapsUserId', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });
      await scheduler.start();

      await scheduler.create(VALID_CREATE);
      const tasks = await scheduler.list({ synapsUserId: 'user-001' });
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBe(1);
      expect(tasks[0].synaps_user_id).toBe('user-001');
    });

    it('returns empty array for unknown user', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });
      await scheduler.start();

      const tasks = await scheduler.list({ synapsUserId: 'nobody' });
      expect(tasks).toEqual([]);
    });
  });

  // ── remove() ─────────────────────────────────────────────────────────────

  describe('remove()', () => {
    it('cancels the agenda job and removes the repo row', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });
      await scheduler.start();

      const { id } = await scheduler.create(VALID_CREATE);
      const result  = await scheduler.remove(id);

      expect(result).toEqual({ ok: true });
      expect(agenda.cancel).toHaveBeenCalledOnce();
      expect(repo.remove).toHaveBeenCalledWith(id);
    });

    it('is idempotent — removing unknown id returns { ok: true }', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });
      await scheduler.start();

      const result = await scheduler.remove('nonexistent-id');
      expect(result).toEqual({ ok: true });
    });

    it('task no longer appears in list after remove', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher });
      await scheduler.start();

      const { id } = await scheduler.create(VALID_CREATE);
      await scheduler.remove(id);

      const tasks = await scheduler.list({ synapsUserId: 'user-001' });
      expect(tasks).toEqual([]);
    });
  });

  // ── dispatch on fire ──────────────────────────────────────────────────────

  describe('agenda job handler (dispatch on fire)', () => {
    /**
     * Helper: start scheduler, create a task, retrieve the captured agenda
     * handler, set agenda_job_id in the store to match the mock return,
     * then invoke the handler with a fake job object.
     */
    async function setup() {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const logger     = makeMockLogger();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher, logger });
      await scheduler.start();

      const { id, agenda_job_id } = await scheduler.create(VALID_CREATE);

      // agenda.define captured the handler — retrieve it.
      const handler = agenda._capturedHandler();
      expect(typeof handler).toBe('function');

      // Build a fake Agenda job object.
      const fakeJob = {
        attrs: {
          _id:       agenda_job_id,
          nextRunAt: new Date('2030-01-02T09:00:00Z'),
        },
      };

      return { scheduler, agenda, repo, dispatcher, logger, handler, fakeJob, taskId: id };
    }

    it('calls dispatcher with the full task row when job fires', async () => {
      const { handler, fakeJob, dispatcher } = await setup();

      await handler(fakeJob);
      expect(dispatcher).toHaveBeenCalledOnce();
      const [row] = dispatcher.mock.calls[0];
      expect(row).toHaveProperty('synaps_user_id', 'user-001');
      expect(row).toHaveProperty('cron', '0 9 * * *');
      expect(row).toHaveProperty('channel', '#general');
      expect(row).toHaveProperty('prompt', 'Post the daily digest');
    });

    it('calls repo.updateLastRun after dispatch', async () => {
      const { handler, fakeJob, repo } = await setup();

      await handler(fakeJob);
      expect(repo.updateLastRun).toHaveBeenCalled();
    });

    it('calls repo.updateNextRun with nextRunAt from job attrs', async () => {
      const { handler, fakeJob, repo } = await setup();

      await handler(fakeJob);
      expect(repo.updateNextRun).toHaveBeenCalledWith(
        expect.any(String),
        new Date('2030-01-02T09:00:00Z'),
      );
    });

    it('dispatcher error does NOT crash — handler resolves anyway', async () => {
      const { handler, fakeJob, dispatcher, logger } = await setup();
      dispatcher.mockRejectedValue(new Error('channel gone'));

      await expect(handler(fakeJob)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('dispatcher error is warn-logged with taskId and agendaJobId', async () => {
      const { handler, fakeJob, dispatcher, logger } = await setup();
      dispatcher.mockRejectedValue(new Error('boom'));

      await handler(fakeJob);
      const warnArgs = logger.warn.mock.calls.flat();
      expect(warnArgs.some(a => typeof a === 'string' && a.includes('dispatcher error'))).toBe(true);
    });

    it('disabled task: handler skips dispatch', async () => {
      const { handler, fakeJob, repo, dispatcher, taskId } = await setup();

      // Disable the task in the store.
      await repo.setEnabled(taskId, false);

      await handler(fakeJob);
      expect(dispatcher).not.toHaveBeenCalled();
    });

    it('unknown agendaJobId: handler logs warn and skips dispatch', async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      const logger     = makeMockLogger();
      const scheduler  = new Scheduler({ agenda, repo, dispatcher, logger });
      await scheduler.start();

      const handler = agenda._capturedHandler();
      const fakeJob = { attrs: { _id: 'totally-unknown-id', nextRunAt: null } };

      await handler(fakeJob);
      expect(dispatcher).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('removed task does not fire dispatcher after remove', async () => {
      const { handler, fakeJob, scheduler, taskId, dispatcher } = await setup();

      await scheduler.remove(taskId);

      // Handler still fires (agenda side), but repo.findByAgendaJobId returns null.
      await handler(fakeJob);
      expect(dispatcher).not.toHaveBeenCalled();
    });
  });

  // ── validation ────────────────────────────────────────────────────────────

  describe('validation', () => {
    let scheduler;

    beforeEach(async () => {
      const agenda     = makeMockAgenda();
      const repo       = makeMockRepo();
      const dispatcher = vi.fn();
      scheduler        = new Scheduler({ agenda, repo, dispatcher });
      await scheduler.start();
    });

    it('throws SchedulerValidationError for missing synapsUserId', async () => {
      const { synapsUserId: _omit, ...rest } = VALID_CREATE;
      await expect(scheduler.create({ ...rest })).rejects.toThrow(SchedulerValidationError);
    });

    it('throws SchedulerValidationError for missing institutionId', async () => {
      const { institutionId: _omit, ...rest } = VALID_CREATE;
      await expect(scheduler.create({ ...rest })).rejects.toThrow(SchedulerValidationError);
    });

    it('throws SchedulerValidationError for missing channel', async () => {
      const { channel: _omit, ...rest } = VALID_CREATE;
      await expect(scheduler.create({ ...rest })).rejects.toThrow(SchedulerValidationError);
    });

    it('throws SchedulerValidationError for missing prompt', async () => {
      const { prompt: _omit, ...rest } = VALID_CREATE;
      await expect(scheduler.create({ ...rest })).rejects.toThrow(SchedulerValidationError);
    });

    it('throws SchedulerValidationError for missing cron', async () => {
      const { cron: _omit, ...rest } = VALID_CREATE;
      await expect(scheduler.create({ ...rest })).rejects.toThrow(SchedulerValidationError);
    });

    it('throws SchedulerValidationError for invalid cron (empty string)', async () => {
      await expect(scheduler.create({ ...VALID_CREATE, cron: '' })).rejects.toThrow(SchedulerValidationError);
    });

    it('throws SchedulerValidationError for invalid cron (too few fields)', async () => {
      await expect(scheduler.create({ ...VALID_CREATE, cron: '* * *' })).rejects.toThrow(SchedulerValidationError);
    });

    it('throws SchedulerValidationError for missing name', async () => {
      const { name: _omit, ...rest } = VALID_CREATE;
      await expect(scheduler.create({ ...rest })).rejects.toThrow(SchedulerValidationError);
    });

    it('SchedulerValidationError has correct name property', async () => {
      try {
        await scheduler.create({ ...VALID_CREATE, cron: '' });
      } catch (err) {
        expect(err.name).toBe('SchedulerValidationError');
      }
    });

    it('list() throws SchedulerValidationError for missing synapsUserId', async () => {
      await expect(scheduler.list({})).rejects.toThrow(SchedulerValidationError);
    });

    it('remove() throws SchedulerValidationError for missing id', async () => {
      await expect(scheduler.remove('')).rejects.toThrow(SchedulerValidationError);
    });
  });

});

// ── NoopScheduler ─────────────────────────────────────────────────────────────

describe('NoopScheduler', () => {
  it('start() resolves without error', async () => {
    const noop = new NoopScheduler();
    await expect(noop.start()).resolves.toBeUndefined();
  });

  it('stop() resolves without error', async () => {
    const noop = new NoopScheduler();
    await expect(noop.stop()).resolves.toBeUndefined();
  });

  it('create() rejects with SchedulerDisabledError', async () => {
    const noop = new NoopScheduler();
    await expect(noop.create(VALID_CREATE)).rejects.toThrow(SchedulerDisabledError);
  });

  it('list() rejects with SchedulerDisabledError', async () => {
    const noop = new NoopScheduler();
    await expect(noop.list({ synapsUserId: 'user-001' })).rejects.toThrow(SchedulerDisabledError);
  });

  it('remove() rejects with SchedulerDisabledError', async () => {
    const noop = new NoopScheduler();
    await expect(noop.remove('some-id')).rejects.toThrow(SchedulerDisabledError);
  });

  it('SchedulerDisabledError has correct name property', async () => {
    const noop = new NoopScheduler();
    try {
      await noop.create(VALID_CREATE);
    } catch (err) {
      expect(err.name).toBe('SchedulerDisabledError');
    }
  });
});
