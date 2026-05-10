/**
 * @file bridge/core/db/repositories/mcp-audit-repo.test.js
 *
 * Tests for McpAuditRepo.
 *
 * Uses mongodb-memory-server for an in-process MongoDB instance.
 * The schema is built from the real model file so we exercise the full stack.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getSynapsMcpAuditModel } from '../models/synaps-mcp-audit.js';
import { McpAuditRepo } from './mcp-audit-repo.js';

// ── Silence logger ────────────────────────────────────────────────────────────

const silentLogger = { warn: () => {} };

// ── Module-level fixtures ─────────────────────────────────────────────────────

let mongod;
let m;
let Model;
let repo;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5000,
    autoIndex: true,
  });

  Model = getSynapsMcpAuditModel(m);
  await Model.ensureIndexes();

  repo = new McpAuditRepo({ model: Model, logger: silentLogger });
}, 120_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function validEntry(overrides = {}) {
  return {
    method:      'tools/call',
    outcome:     'ok',
    duration_ms: 25,
    ...overrides,
  };
}

// ── record() — persistence ────────────────────────────────────────────────────

describe('McpAuditRepo.record()', () => {
  it('persists a full entry to the database', async () => {
    const userId = new m.Types.ObjectId();
    const instId = new m.Types.ObjectId();

    await repo.record(validEntry({
      synaps_user_id: userId,
      institution_id: instId,
      tool_name:      'search',
      error_code:     null,
      client_info:    { name: 'TestClient', version: '1.0.0' },
    }));

    const docs = await Model.find({}).lean();
    expect(docs).toHaveLength(1);
    expect(String(docs[0].synaps_user_id)).toBe(String(userId));
    expect(String(docs[0].institution_id)).toBe(String(instId));
    expect(docs[0].method).toBe('tools/call');
    expect(docs[0].outcome).toBe('ok');
    expect(docs[0].duration_ms).toBe(25);
    expect(docs[0].tool_name).toBe('search');
    expect(docs[0].client_info.name).toBe('TestClient');
    expect(docs[0].client_info.version).toBe('1.0.0');
  });

  it('auto-fills ts from clock when not supplied', async () => {
    const fakeNow = new Date('2030-01-15T12:00:00.000Z');
    // Provide a clock constructor whose `new` returns fakeNow.
    const fakeClock = class {
      constructor() { return fakeNow; }
    };

    const clockRepo = new McpAuditRepo({
      model:  Model,
      clock:  fakeClock,
      logger: silentLogger,
    });

    await clockRepo.record(validEntry());

    const docs = await Model.find({}).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].ts.toISOString()).toBe(fakeNow.toISOString());
  });

  it('ts supplied in entry overrides the clock default', async () => {
    const explicitTs = new Date('2025-06-01T00:00:00.000Z');
    await repo.record(validEntry({ ts: explicitTs }));

    const docs = await Model.find({}).lean();
    expect(docs[0].ts.toISOString()).toBe(explicitTs.toISOString());
  });

  it('never returns a value (Promise<void>)', async () => {
    const result = await repo.record(validEntry());
    expect(result).toBeUndefined();
  });

  it('swallows error on invalid outcome — does NOT throw', async () => {
    await expect(
      repo.record(validEntry({ outcome: 'invalid_value' })),
    ).resolves.toBeUndefined();
  });

  it('calls logger.warn with an Error when record() swallows an error', async () => {
    const warnSpy = vi.fn();
    const spyRepo = new McpAuditRepo({
      model:  Model,
      logger: { warn: warnSpy },
    });

    await spyRepo.record(validEntry({ outcome: 'invalid_value' }));

    expect(warnSpy).toHaveBeenCalledOnce();
    const [, err] = warnSpy.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
  });

  it('swallows error on missing required field (method) — does NOT throw', async () => {
    const { method: _omit, ...noMethod } = validEntry();
    await expect(repo.record(noMethod)).resolves.toBeUndefined();
  });

  it('swallows error on missing required field (duration_ms) — does NOT throw', async () => {
    const { duration_ms: _omit, ...noDuration } = validEntry();
    await expect(repo.record(noDuration)).resolves.toBeUndefined();
  });
});

// ── recent() — reads ──────────────────────────────────────────────────────────

describe('McpAuditRepo.recent()', () => {
  it('returns an empty array when nothing has been recorded', async () => {
    const results = await repo.recent();
    expect(results).toEqual([]);
  });

  it('returns entries newest first', async () => {
    const t1 = new Date('2025-01-01T10:00:00Z');
    const t2 = new Date('2025-01-01T11:00:00Z');
    const t3 = new Date('2025-01-01T12:00:00Z');

    await Model.create([
      { ...validEntry(), ts: t1, method: 'initialize' },
      { ...validEntry(), ts: t2, method: 'tools/list' },
      { ...validEntry(), ts: t3, method: 'tools/call' },
    ]);

    const results = await repo.recent();
    expect(results).toHaveLength(3);
    expect(results[0].ts.toISOString()).toBe(t3.toISOString());
    expect(results[1].ts.toISOString()).toBe(t2.toISOString());
    expect(results[2].ts.toISOString()).toBe(t1.toISOString());
  });

  it('filters by synaps_user_id', async () => {
    const userId  = new m.Types.ObjectId();
    const otherId = new m.Types.ObjectId();

    await Model.create([
      { ...validEntry(), synaps_user_id: userId,  method: 'tools/call' },
      { ...validEntry(), synaps_user_id: otherId, method: 'initialize' },
    ]);

    const results = await repo.recent({ synaps_user_id: userId });
    expect(results).toHaveLength(1);
    expect(String(results[0].synaps_user_id)).toBe(String(userId));
  });

  it('filters by institution_id', async () => {
    const instId  = new m.Types.ObjectId();
    const otherId = new m.Types.ObjectId();

    await Model.create([
      { ...validEntry(), institution_id: instId,  method: 'tools/call' },
      { ...validEntry(), institution_id: otherId, method: 'initialize' },
      { ...validEntry(), institution_id: instId,  method: 'tools/list' },
    ]);

    const results = await repo.recent({ institution_id: instId });
    expect(results).toHaveLength(2);
    results.forEach((r) => expect(String(r.institution_id)).toBe(String(instId)));
  });

  it('caps results with limit', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      ({ ...validEntry(), ts: new Date(Date.now() + i * 1000) }),
    );
    await Model.create(entries);

    const results = await repo.recent({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('defaults limit to 100 when not specified', async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      ({ ...validEntry(), ts: new Date(Date.now() + i * 1000) }),
    );
    await Model.create(entries);

    const results = await repo.recent();
    expect(results).toHaveLength(5); // all 5 — well under 100
  });

  it('does NOT include __v (uses .lean())', async () => {
    await Model.create(validEntry());
    const [doc] = await repo.recent();
    expect(doc).not.toHaveProperty('__v');
  });

  it('applies both synaps_user_id and institution_id filters simultaneously', async () => {
    const userId = new m.Types.ObjectId();
    const instId = new m.Types.ObjectId();

    await Model.create([
      { ...validEntry(), synaps_user_id: userId, institution_id: instId,  method: 'tools/call' },
      { ...validEntry(), synaps_user_id: userId, institution_id: new m.Types.ObjectId(), method: 'initialize' },
      { ...validEntry(), synaps_user_id: new m.Types.ObjectId(), institution_id: instId, method: 'tools/list' },
    ]);

    const results = await repo.recent({ synaps_user_id: userId, institution_id: instId });
    expect(results).toHaveLength(1);
    expect(results[0].method).toBe('tools/call');
  });
});
