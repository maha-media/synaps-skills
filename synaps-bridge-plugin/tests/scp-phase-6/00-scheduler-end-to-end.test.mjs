/**
 * @file tests/scp-phase-6/00-scheduler-end-to-end.test.mjs
 *
 * End-to-end tests for the Scheduler against a real mongo-memory-server.
 *
 * Design choice (documented per brief):
 * ──────────────────────────────────────
 * Agenda is a hybrid ESM/CJS package that vitest's vmThreads pool cannot
 * inline at import time without a vitest.config change (see the
 * "server.deps.inline" workaround the package suggests).  Modifying
 * vitest.config.js is outside Wave C scope.
 *
 * The brief explicitly endorses this fallback:
 *   "If real fire is too flaky, use the unit-test pattern from
 *    scheduler.test.js (mock agenda). Document the choice."
 *
 * We therefore use a MOCK agenda (vi.fn() spies) paired with a REAL
 * mongo-memory-server for the ScheduledTaskRepo.  This approach:
 *   - Exercises the full Scheduler domain logic (create/list/remove/fire)
 *   - Validates repo persistence against a real MongoDB instance
 *   - Keeps the suite fast and deterministic (no 60-second cron waits)
 *   - Avoids ESM/CJS interop issues with vitest's vmThreads pool
 *
 * ≥ 4 tests
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { makeScheduledTaskRepo } from '../../bridge/core/db/index.js';
import {
  Scheduler,
  NoopScheduler,
  SchedulerValidationError,
  SchedulerDisabledError,
} from '../../bridge/core/scheduler.js';

// ─── Mock Agenda factory ──────────────────────────────────────────────────────

/** Build a mock agenda that captures the job handler for manual invocation. */
function makeMockAgenda() {
  let _capturedHandler = null;

  return {
    /** Simulate a job fire by calling the captured handler. */
    _fire: async (job) => _capturedHandler && _capturedHandler(job),
    define: vi.fn((name, fn) => { _capturedHandler = fn; }),
    every:  vi.fn(async (_cron, _name, _data) => ({
      attrs: {
        _id:       new mongoose.Types.ObjectId().toString(),
        nextRunAt: new Date('2030-01-01T09:00:00Z'),
      },
    })),
    cancel: vi.fn(async () => 1),
    start:  vi.fn(async () => {}),
    stop:   vi.fn(async () => {}),
  };
}

// ─── Module-level fixtures ────────────────────────────────────────────────────

let mongod;
let m;   // private mongoose instance

/** Silent logger. */
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Create a fresh random ObjectId string — matches the schema's ObjectId type. */
const newId = () => new mongoose.Types.ObjectId().toString();

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m      = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), { serverSelectionTimeoutMS: 10_000, autoIndex: true });
}, 60_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

// ─── 1. create() — persists task to REAL Mongo, agenda_job_id linked ─────────

describe('Scheduler — create() writes to real MongoDB repo', () => {
  let scheduler;
  let repo;
  let agenda;

  beforeAll(async () => {
    repo      = makeScheduledTaskRepo(m);
    agenda    = makeMockAgenda();
    scheduler = new Scheduler({ agenda, repo, dispatcher: vi.fn(), logger: silent });
    await scheduler.start();
  }, 30_000);

  afterAll(async () => {
    await scheduler.stop();
  });

  it('create() returns id, agenda_job_id, next_run and persists to DB', async () => {
    const userId = newId();
    const instId = newId();

    const result = await scheduler.create({
      synapsUserId:  userId,
      institutionId: instId,
      name:          'Monday digest',
      cron:          '0 9 * * MON',
      channel:       '#dev',
      prompt:        'Post digest',
    });

    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.agenda_job_id).toBeTruthy();
    if (result.next_run !== null && result.next_run !== undefined) {
      expect(result.next_run instanceof Date).toBe(true);
    }

    // Verify the row exists in the real MongoDB.
    const row = await repo.findById(result.id);
    expect(row).not.toBeNull();
    expect(row.name).toBe('Monday digest');
    expect(row.cron).toBe('0 9 * * MON');
  });
});

// ─── 2. list() — returns tasks from real MongoDB ──────────────────────────────

describe('Scheduler — list() reads from real MongoDB', () => {
  let scheduler;
  let repo;
  let userId;

  beforeAll(async () => {
    userId    = newId();
    repo      = makeScheduledTaskRepo(m);
    const agenda = makeMockAgenda();
    scheduler = new Scheduler({ agenda, repo, dispatcher: vi.fn(), logger: silent });
    await scheduler.start();

    await scheduler.create({
      synapsUserId:  userId,
      institutionId: newId(),
      name:          'Weekly summary',
      cron:          '0 9 * * MON',
      channel:       '#general',
      prompt:        'Run weekly summary',
    });
  }, 30_000);

  afterAll(async () => {
    await scheduler.stop();
  });

  it('list() returns array including the created task for the user', async () => {
    const tasks = await scheduler.list({ synapsUserId: userId });
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.some(t => t.name === 'Weekly summary')).toBe(true);
  });

  it('list() for unknown user returns empty array', async () => {
    // Use a fresh ObjectId that was never used — no tasks for this user.
    const unknownUser = newId();
    const tasks = await scheduler.list({ synapsUserId: unknownUser });
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks).toHaveLength(0);
  });
});

// ─── 3. remove() — deletes from real MongoDB ──────────────────────────────────

describe('Scheduler — remove() deletes from real MongoDB', () => {
  let scheduler;
  let repo;
  let createdId;

  beforeAll(async () => {
    repo      = makeScheduledTaskRepo(m);
    const agenda = makeMockAgenda();
    scheduler = new Scheduler({ agenda, repo, dispatcher: vi.fn(), logger: silent });
    await scheduler.start();

    const result = await scheduler.create({
      synapsUserId:  newId(),
      institutionId: newId(),
      name:          'To be removed',
      cron:          '0 9 * * MON',
      channel:       '#dev',
      prompt:        'Delete me',
    });
    createdId = result.id;
  }, 30_000);

  afterAll(async () => {
    await scheduler.stop();
  });

  it('remove() returns { ok: true } and deletes the row from DB', async () => {
    const result = await scheduler.remove(createdId);
    expect(result).toEqual({ ok: true });

    // Verify the row is gone from the DB.
    const row = await repo.findById(createdId);
    expect(row).toBeNull();
  });
});

// ─── 4. dispatcher fires via captured agenda handler ──────────────────────────

describe('Scheduler — dispatcher is called with task row on fire', () => {
  let scheduler;
  let repo;
  let dispatcher;
  let agenda;

  beforeAll(async () => {
    repo       = makeScheduledTaskRepo(m);
    dispatcher = vi.fn().mockResolvedValue(undefined);
    agenda     = makeMockAgenda();
    scheduler  = new Scheduler({ agenda, repo, dispatcher, logger: silent });
    await scheduler.start();
  }, 30_000);

  afterAll(async () => {
    await scheduler.stop();
  });

  it('dispatcher is called with task row when agenda job fires', async () => {
    const result = await scheduler.create({
      synapsUserId:  newId(),
      institutionId: newId(),
      name:          'Fire test task',
      cron:          '* * * * *',
      channel:       '#fire',
      prompt:        'Fire me now',
    });

    // Simulate agenda firing the job by invoking the captured handler.
    // The handler uses repo.findByAgendaJobId to hydrate the row — this
    // exercises the real MongoDB path.
    await agenda._fire({
      attrs: {
        _id:       result.agenda_job_id,
        nextRunAt: new Date(),
      },
    });

    // Verify dispatcher was called with the full task row.
    expect(dispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Fire test task' })
    );
  });

  it('NoopScheduler.create() throws SchedulerDisabledError', async () => {
    const noop = new NoopScheduler();
    await expect(noop.create({})).rejects.toThrow(SchedulerDisabledError);
  });

  it('SchedulerValidationError thrown when cron is missing', async () => {
    await expect(scheduler.create({
      synapsUserId:  newId(),
      institutionId: newId(),
      name:          'Invalid',
      cron:          '',   // invalid
      channel:       '#c',
      prompt:        'p',
    })).rejects.toThrow(SchedulerValidationError);
  });

  it('NoopScheduler.list() throws SchedulerDisabledError', async () => {
    const noop = new NoopScheduler();
    await expect(noop.list({})).rejects.toThrow(SchedulerDisabledError);
  });
});
