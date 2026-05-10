/**
 * @file bridge/core/db/repositories/scheduled-task-repo.test.js
 *
 * Tests for ScheduledTaskRepo.
 *
 * Uses mongodb-memory-server for an in-process MongoDB instance.
 * `now` is injected for deterministic timestamp assertions where relevant.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { makeScheduledTaskModel } from '../models/synaps-scheduled-task.js';
import { ScheduledTaskRepo } from './scheduled-task-repo.js';

// ── Shared in-memory DB fixture ──────────────────────────────────────────────

let mongod;
let m;
let ScheduledTask;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5_000,
    autoIndex: true,
  });
  ScheduledTask = makeScheduledTaskModel(m);
}, 60_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await ScheduledTask.deleteMany({});
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRepo(nowFn) {
  return new ScheduledTaskRepo({
    ScheduledTask,
    ...(nowFn !== undefined && { now: nowFn }),
  });
}

/** Minimal valid task data for a given user (creates fresh ObjectIds). */
function taskData(overrides = {}) {
  return {
    synapsUserId:  new mongoose.Types.ObjectId(),
    institutionId: new mongoose.Types.ObjectId(),
    name:          'Test Task',
    cron:          '0 9 * * MON',
    channel:       '#general',
    prompt:        'Run the weekly digest',
    ...overrides,
  };
}

// ── create() ─────────────────────────────────────────────────────────────────

describe('ScheduledTaskRepo.create() — inserts a new task', () => {
  it('returns a document with an _id and all provided fields', async () => {
    const repo   = makeRepo();
    const userId = new mongoose.Types.ObjectId();
    const instId = new mongoose.Types.ObjectId();

    const doc = await repo.create({
      synapsUserId:  userId,
      institutionId: instId,
      name:          'My Task',
      cron:          '*/5 * * * *',
      channel:       '#alerts',
      prompt:        'Summarise alerts',
    });

    expect(doc._id).toBeDefined();
    expect(doc.synaps_user_id.toString()).toBe(userId.toString());
    expect(doc.institution_id.toString()).toBe(instId.toString());
    expect(doc.name).toBe('My Task');
    expect(doc.cron).toBe('*/5 * * * *');
    expect(doc.channel).toBe('#alerts');
    expect(doc.prompt).toBe('Summarise alerts');
  });

  it('defaults enabled to true when not specified', async () => {
    const repo = makeRepo();
    const doc  = await repo.create(taskData());
    expect(doc.enabled).toBe(true);
  });

  it('stores enabled=false when explicitly passed', async () => {
    const repo = makeRepo();
    const doc  = await repo.create(taskData({ enabled: false }));
    expect(doc.enabled).toBe(false);
  });

  it('defaults agendaJobId to null', async () => {
    const repo = makeRepo();
    const doc  = await repo.create(taskData());
    expect(doc.agenda_job_id).toBeNull();
  });

  it('stores an agendaJobId when provided', async () => {
    const repo  = makeRepo();
    const jobId = new mongoose.Types.ObjectId();
    const doc   = await repo.create(taskData({ agendaJobId: jobId }));
    expect(doc.agenda_job_id.toString()).toBe(jobId.toString());
  });
});

// ── findById() ───────────────────────────────────────────────────────────────

describe('ScheduledTaskRepo.findById() — lookup by _id', () => {
  it('returns the lean document when found', async () => {
    const repo = makeRepo();
    const created = await repo.create(taskData());

    const found = await repo.findById(created._id);
    expect(found).not.toBeNull();
    expect(found._id.toString()).toBe(created._id.toString());
    expect(found.name).toBe('Test Task');
  });

  it('returns null when the id does not exist', async () => {
    const repo   = makeRepo();
    const result = await repo.findById(new mongoose.Types.ObjectId());
    expect(result).toBeNull();
  });

  it('returns a plain object (lean), not a Mongoose Document', async () => {
    const repo    = makeRepo();
    const created = await repo.create(taskData());
    const found   = await repo.findById(created._id);
    // Lean docs don't have .save()
    expect(typeof found.save).toBe('undefined');
  });
});

// ── findByAgendaJobId() ───────────────────────────────────────────────────────

describe('ScheduledTaskRepo.findByAgendaJobId() — lookup by agenda_job_id', () => {
  it('returns the task matching the given agenda_job_id', async () => {
    const repo  = makeRepo();
    const jobId = new mongoose.Types.ObjectId();
    await repo.create(taskData({ agendaJobId: jobId }));

    const found = await repo.findByAgendaJobId(jobId);
    expect(found).not.toBeNull();
    expect(found.agenda_job_id.toString()).toBe(jobId.toString());
  });

  it('returns null when no task matches the agenda_job_id', async () => {
    const repo   = makeRepo();
    const result = await repo.findByAgendaJobId(new mongoose.Types.ObjectId());
    expect(result).toBeNull();
  });
});

// ── listByUser() ─────────────────────────────────────────────────────────────

describe('ScheduledTaskRepo.listByUser() — list tasks for a user', () => {
  it('returns all tasks for the given user', async () => {
    const repo   = makeRepo();
    const userId = new mongoose.Types.ObjectId();

    await repo.create(taskData({ synapsUserId: userId, name: 'Task A' }));
    await repo.create(taskData({ synapsUserId: userId, name: 'Task B' }));
    // A different user's task — should NOT appear
    await repo.create(taskData({ name: 'Other user task' }));

    const list = await repo.listByUser({ synapsUserId: userId });
    expect(list).toHaveLength(2);
    const names = list.map((t) => t.name).sort();
    expect(names).toEqual(['Task A', 'Task B']);
  });

  it('filters by enabled=true', async () => {
    const repo   = makeRepo();
    const userId = new mongoose.Types.ObjectId();

    await repo.create(taskData({ synapsUserId: userId, name: 'Active', enabled: true }));
    await repo.create(taskData({ synapsUserId: userId, name: 'Disabled', enabled: false }));

    const list = await repo.listByUser({ synapsUserId: userId, enabled: true });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Active');
  });

  it('filters by enabled=false', async () => {
    const repo   = makeRepo();
    const userId = new mongoose.Types.ObjectId();

    await repo.create(taskData({ synapsUserId: userId, name: 'Active',  enabled: true  }));
    await repo.create(taskData({ synapsUserId: userId, name: 'Disabled', enabled: false }));

    const list = await repo.listByUser({ synapsUserId: userId, enabled: false });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Disabled');
  });

  it('returns empty array when user has no tasks', async () => {
    const repo   = makeRepo();
    const result = await repo.listByUser({ synapsUserId: new mongoose.Types.ObjectId() });
    expect(result).toEqual([]);
  });

  it('returns results sorted by created_at ascending', async () => {
    const repo   = makeRepo();
    const userId = new mongoose.Types.ObjectId();

    // Insert three tasks in fast succession; rely on Mongoose timestamps.
    // Give each a small delay so created_at is measurably different.
    for (const name of ['First', 'Second', 'Third']) {
      await repo.create(taskData({ synapsUserId: userId, name }));
      await new Promise((r) => setTimeout(r, 5));
    }

    const list = await repo.listByUser({ synapsUserId: userId });
    expect(list.map((t) => t.name)).toEqual(['First', 'Second', 'Third']);
  });
});

// ── setEnabled() ─────────────────────────────────────────────────────────────

describe('ScheduledTaskRepo.setEnabled() — toggle enabled flag', () => {
  it('sets enabled to false on an active task', async () => {
    const repo    = makeRepo();
    const created = await repo.create(taskData({ enabled: true }));

    const updated = await repo.setEnabled(created._id, false);
    expect(updated.enabled).toBe(false);
  });

  it('sets enabled to true on a disabled task', async () => {
    const repo    = makeRepo();
    const created = await repo.create(taskData({ enabled: false }));

    const updated = await repo.setEnabled(created._id, true);
    expect(updated.enabled).toBe(true);
  });

  it('returns null when the id does not exist', async () => {
    const repo   = makeRepo();
    const result = await repo.setEnabled(new mongoose.Types.ObjectId(), true);
    expect(result).toBeNull();
  });

  it('persists the change to the database', async () => {
    const repo    = makeRepo();
    const created = await repo.create(taskData({ enabled: true }));
    await repo.setEnabled(created._id, false);

    const fetched = await repo.findById(created._id);
    expect(fetched.enabled).toBe(false);
  });
});

// ── remove() ─────────────────────────────────────────────────────────────────

describe('ScheduledTaskRepo.remove() — delete a task', () => {
  it('removes the document and returns true', async () => {
    const repo    = makeRepo();
    const created = await repo.create(taskData());

    const result = await repo.remove(created._id);
    expect(result).toBe(true);

    const fetched = await repo.findById(created._id);
    expect(fetched).toBeNull();
  });

  it('returns false when no matching document exists', async () => {
    const repo   = makeRepo();
    const result = await repo.remove(new mongoose.Types.ObjectId());
    expect(result).toBe(false);
  });
});

// ── updateLastRun() ───────────────────────────────────────────────────────────

describe('ScheduledTaskRepo.updateLastRun() — sets last_run', () => {
  it('updates last_run with the provided timestamp', async () => {
    const repo    = makeRepo();
    const created = await repo.create(taskData());
    const ts      = new Date('2024-06-10T09:00:00Z');

    const updated = await repo.updateLastRun(created._id, ts);
    expect(updated.last_run).toEqual(ts);
  });

  it('uses now() as default when ts is omitted', async () => {
    const fixed   = new Date('2030-01-01T00:00:00Z');
    const repo    = makeRepo(() => fixed);
    const created = await repo.create(taskData());

    const updated = await repo.updateLastRun(created._id);
    expect(updated.last_run).toEqual(fixed);
  });

  it('returns null when the id does not exist', async () => {
    const repo   = makeRepo();
    const result = await repo.updateLastRun(new mongoose.Types.ObjectId(), new Date());
    expect(result).toBeNull();
  });
});

// ── updateNextRun() ───────────────────────────────────────────────────────────

describe('ScheduledTaskRepo.updateNextRun() — sets next_run', () => {
  it('updates next_run with the provided timestamp', async () => {
    const repo    = makeRepo();
    const created = await repo.create(taskData());
    const ts      = new Date('2024-06-17T09:00:00Z');

    const updated = await repo.updateNextRun(created._id, ts);
    expect(updated.next_run).toEqual(ts);
  });

  it('persists the next_run change to the database', async () => {
    const repo    = makeRepo();
    const created = await repo.create(taskData());
    const ts      = new Date('2025-03-15T08:30:00Z');

    await repo.updateNextRun(created._id, ts);
    const fetched = await repo.findById(created._id);
    expect(fetched.next_run).toEqual(ts);
  });

  it('returns null when the id does not exist', async () => {
    const repo   = makeRepo();
    const result = await repo.updateNextRun(new mongoose.Types.ObjectId(), new Date());
    expect(result).toBeNull();
  });
});
