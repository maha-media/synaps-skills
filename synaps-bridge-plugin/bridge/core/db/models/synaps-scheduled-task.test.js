/**
 * @file bridge/core/db/models/synaps-scheduled-task.test.js
 *
 * Schema-validation and round-trip tests for the ScheduledTask model.
 *
 * Uses mongodb-memory-server for round-trip tests; schema-only tests run
 * without needing index enforcement (autoIndex: true wires that in beforeAll).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { makeScheduledTaskModel } from './synaps-scheduled-task.js';

// ── Shared in-memory DB ──────────────────────────────────────────────────────

let mongod;
let m;
let ScheduledTask;

/** Minimal valid payload used as base for most tests. */
const BASE = {
  synaps_user_id:  new mongoose.Types.ObjectId(),
  institution_id:  new mongoose.Types.ObjectId(),
  name:            'Monday GitHub PR digest',
  cron:            '0 9 * * MON',
  channel:         '#dev',
  prompt:          'Post the GitHub PR digest to #dev',
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5_000,
    autoIndex: true, // build indexes so constraints are enforced
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

// ── 1. saves a task with all required fields ──────────────────────────────────

describe('ScheduledTask model — saves a task with all required fields', () => {
  it('persists all fields and returns the saved document', async () => {
    const doc = await ScheduledTask.create({ ...BASE });

    expect(doc._id).toBeDefined();
    expect(doc.synaps_user_id.toString()).toBe(BASE.synaps_user_id.toString());
    expect(doc.institution_id.toString()).toBe(BASE.institution_id.toString());
    expect(doc.name).toBe('Monday GitHub PR digest');
    expect(doc.cron).toBe('0 9 * * MON');
    expect(doc.channel).toBe('#dev');
    expect(doc.prompt).toBe('Post the GitHub PR digest to #dev');
  });
});

// ── 2. requires synaps_user_id ────────────────────────────────────────────────

describe('ScheduledTask model — requires synaps_user_id', () => {
  it('rejects a doc missing synaps_user_id', async () => {
    const { synaps_user_id: _, ...rest } = BASE;
    const doc = new ScheduledTask(rest);
    await expect(doc.validate()).rejects.toThrow(/synaps_user_id is required/);
  });
});

// ── 3. requires institution_id ────────────────────────────────────────────────

describe('ScheduledTask model — requires institution_id', () => {
  it('rejects a doc missing institution_id', async () => {
    const { institution_id: _, ...rest } = BASE;
    const doc = new ScheduledTask(rest);
    await expect(doc.validate()).rejects.toThrow(/institution_id is required/);
  });
});

// ── 4. requires name ─────────────────────────────────────────────────────────

describe('ScheduledTask model — requires name', () => {
  it('rejects a doc missing name', async () => {
    const { name: _, ...rest } = BASE;
    const doc = new ScheduledTask(rest);
    await expect(doc.validate()).rejects.toThrow(/name is required/);
  });
});

// ── 5. requires cron ─────────────────────────────────────────────────────────

describe('ScheduledTask model — requires cron', () => {
  it('rejects a doc missing cron', async () => {
    const { cron: _, ...rest } = BASE;
    const doc = new ScheduledTask(rest);
    await expect(doc.validate()).rejects.toThrow(/cron is required/);
  });
});

// ── 6. cron regex validation — rejects bad values ─────────────────────────────

describe('ScheduledTask model — cron sanity validation', () => {
  it('rejects a cron value that is plain text', async () => {
    const doc = new ScheduledTask({ ...BASE, cron: 'not-a-cron' });
    await expect(doc.validate()).rejects.toThrow(/does not look like a valid cron expression/);
  });

  it('rejects a cron value with only 4 fields', async () => {
    const doc = new ScheduledTask({ ...BASE, cron: '0 9 * *' });
    await expect(doc.validate()).rejects.toThrow(/does not look like a valid cron expression/);
  });

  it('accepts a standard 5-field cron expression', async () => {
    const doc = new ScheduledTask({ ...BASE, cron: '*/15 * * * *' });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('accepts @daily shorthand', async () => {
    const doc = new ScheduledTask({ ...BASE, cron: '@daily' });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('accepts @every shorthand', async () => {
    const doc = new ScheduledTask({ ...BASE, cron: '@every 30m' });
    await expect(doc.validate()).resolves.toBeUndefined();
  });
});

// ── 7. requires channel ───────────────────────────────────────────────────────

describe('ScheduledTask model — requires channel', () => {
  it('rejects a doc missing channel', async () => {
    const { channel: _, ...rest } = BASE;
    const doc = new ScheduledTask(rest);
    await expect(doc.validate()).rejects.toThrow(/channel is required/);
  });
});

// ── 8. requires prompt ────────────────────────────────────────────────────────

describe('ScheduledTask model — requires prompt', () => {
  it('rejects a doc missing prompt', async () => {
    const { prompt: _, ...rest } = BASE;
    const doc = new ScheduledTask(rest);
    await expect(doc.validate()).rejects.toThrow(/prompt is required/);
  });
});

// ── 9. defaults enabled to true ──────────────────────────────────────────────

describe('ScheduledTask model — enabled default', () => {
  it('sets enabled to true when not provided', async () => {
    const doc = await ScheduledTask.create({ ...BASE });
    expect(doc.enabled).toBe(true);
  });

  it('stores enabled=false when explicitly set', async () => {
    const doc = await ScheduledTask.create({ ...BASE, enabled: false });
    expect(doc.enabled).toBe(false);
  });
});

// ── 10. defaults last_run and next_run to null ────────────────────────────────

describe('ScheduledTask model — last_run / next_run defaults', () => {
  it('sets last_run to null when not provided', async () => {
    const doc = await ScheduledTask.create({ ...BASE });
    expect(doc.last_run).toBeNull();
  });

  it('sets next_run to null when not provided', async () => {
    const doc = await ScheduledTask.create({ ...BASE });
    expect(doc.next_run).toBeNull();
  });

  it('stores Date values for last_run and next_run when provided', async () => {
    const lastRun = new Date('2024-06-01T10:00:00Z');
    const nextRun = new Date('2024-06-08T10:00:00Z');
    const doc     = await ScheduledTask.create({ ...BASE, last_run: lastRun, next_run: nextRun });
    expect(doc.last_run).toEqual(lastRun);
    expect(doc.next_run).toEqual(nextRun);
  });
});

// ── 11. agenda_job_id defaults to null ───────────────────────────────────────

describe('ScheduledTask model — agenda_job_id default', () => {
  it('sets agenda_job_id to null when not provided', async () => {
    const doc = await ScheduledTask.create({ ...BASE });
    expect(doc.agenda_job_id).toBeNull();
  });

  it('stores a valid ObjectId for agenda_job_id when provided', async () => {
    const jobId = new mongoose.Types.ObjectId();
    const doc   = await ScheduledTask.create({ ...BASE, agenda_job_id: jobId });
    expect(doc.agenda_job_id.toString()).toBe(jobId.toString());
  });
});

// ── 12. Mongoose timestamps ──────────────────────────────────────────────────

describe('ScheduledTask model — created_at / updated_at timestamps', () => {
  it('populates created_at and updated_at on create', async () => {
    const before = Date.now();
    const doc    = await ScheduledTask.create({ ...BASE });
    const after  = Date.now();

    expect(doc.created_at).toBeInstanceOf(Date);
    expect(doc.updated_at).toBeInstanceOf(Date);
    expect(doc.created_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(doc.created_at.getTime()).toBeLessThanOrEqual(after);
  });

  it('advances updated_at on save', async () => {
    const doc     = await ScheduledTask.create({ ...BASE });
    const origUpd = doc.updated_at.getTime();

    // Small delay to ensure time advances
    await new Promise((r) => setTimeout(r, 10));
    doc.name = 'Updated name';
    await doc.save();

    expect(doc.updated_at.getTime()).toBeGreaterThanOrEqual(origUpd);
  });
});

// ── 13. indexes exist on the model ───────────────────────────────────────────

describe('ScheduledTask model — index existence', () => {
  it('has a compound index on synaps_user_id + enabled', async () => {
    await ScheduledTask.ensureIndexes();
    const indexes = await ScheduledTask.collection.getIndexes();
    // getIndexes() returns { <indexName>: [[field, dir], ...], ... }
    const fieldSets = Object.values(indexes).map((pairs) => pairs.map(([f]) => f));
    const found = fieldSets.some(
      (fields) => fields.includes('synaps_user_id') && fields.includes('enabled'),
    );
    expect(found).toBe(true);
  });

  it('has an index on agenda_job_id', async () => {
    await ScheduledTask.ensureIndexes();
    const indexes = await ScheduledTask.collection.getIndexes();
    const fieldSets = Object.values(indexes).map((pairs) => pairs.map(([f]) => f));
    const found = fieldSets.some((fields) => fields.includes('agenda_job_id'));
    expect(found).toBe(true);
  });
});

// ── 14. makeScheduledTaskModel is idempotent ──────────────────────────────────

describe('makeScheduledTaskModel — idempotent', () => {
  it('returns the exact same model instance on repeated calls', () => {
    const m1 = makeScheduledTaskModel(m);
    const m2 = makeScheduledTaskModel(m);
    expect(m1).toBe(m2);
  });
});
