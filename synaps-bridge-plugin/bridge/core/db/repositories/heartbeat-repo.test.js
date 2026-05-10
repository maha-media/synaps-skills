/**
 * @file bridge/core/db/repositories/heartbeat-repo.test.js
 *
 * Tests for HeartbeatRepo.
 *
 * Uses mongodb-memory-server for an in-process MongoDB instance.
 * `now` is injected for deterministic timestamp assertions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { makeHeartbeatModel } from '../models/synaps-heartbeat.js';
import { HeartbeatRepo } from './heartbeat-repo.js';

// ── Shared in-memory DB fixture ──────────────────────────────────────────────

let mongod;
let m;
let Heartbeat;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5_000,
    autoIndex: true,
  });
  Heartbeat = makeHeartbeatModel(m);
}, 60_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Heartbeat.deleteMany({});
});

// Helper — build a repo with an injectable clock
function makeRepo(nowFn) {
  return new HeartbeatRepo({
    Heartbeat,
    ...(nowFn !== undefined && { now: nowFn }),
  });
}

// ── record() — creates a new doc ─────────────────────────────────────────────

describe('HeartbeatRepo.record() — creates a new doc', () => {
  it('inserts a new heartbeat and returns the saved document', async () => {
    const repo = makeRepo();
    const doc  = await repo.record({ component: 'bridge', id: 'b-1' });

    expect(doc._id).toBeDefined();
    expect(doc.component).toBe('bridge');
    expect(doc.id).toBe('b-1');
    expect(doc.healthy).toBe(true);
    expect(doc.ts).toBeInstanceOf(Date);
  });
});

// ── record() — updates existing doc (upsert) ─────────────────────────────────

describe('HeartbeatRepo.record() — upserts existing doc', () => {
  it('updates the same {component, id} doc and advances ts', async () => {
    const t1   = new Date('2024-06-01T10:00:00Z');
    const t2   = new Date('2024-06-01T10:00:05Z');
    let tick = 0;
    const repo = makeRepo(() => (tick++ === 0 ? t1 : t2));

    const first  = await repo.record({ component: 'workspace', id: 'ws-1' });
    expect(first.ts).toEqual(t1);

    const second = await repo.record({ component: 'workspace', id: 'ws-1' });
    expect(second.ts).toEqual(t2);

    // Only one document should exist in the collection
    const count = await Heartbeat.countDocuments({});
    expect(count).toBe(1);
  });
});

// ── record() — stores healthy + details ──────────────────────────────────────

describe('HeartbeatRepo.record() — sets healthy and details', () => {
  it('persists healthy=false and custom details payload', async () => {
    const repo    = makeRepo();
    const details = { queue_depth: 42, cpu: 0.9 };
    const doc     = await repo.record({
      component: 'rpc',
      id:        'sess-x',
      healthy:   false,
      details,
    });

    expect(doc.healthy).toBe(false);
    expect(doc.details.queue_depth).toBe(42);
    expect(doc.details.cpu).toBe(0.9);
  });
});

// ── findStale() — returns docs older than threshold ───────────────────────────

describe('HeartbeatRepo.findStale() — returns stale docs', () => {
  it('returns docs whose ts is older than the threshold', async () => {
    const base  = new Date('2024-06-01T12:00:00Z');
    const staleTs = new Date(base.getTime() - 10_000); // 10 s before base

    // Insert stale doc directly
    await Heartbeat.create({ component: 'bridge', id: 'b-stale', ts: staleTs });

    // now() returns base; olderThanMs = 5_000  →  threshold = base - 5 s
    // staleTs is 10 s before base, so it IS older than threshold
    const repo = makeRepo(() => base);
    const stale = await repo.findStale({ olderThanMs: 5_000 });

    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe('b-stale');
  });
});

// ── findStale() — excludes fresh docs ────────────────────────────────────────

describe('HeartbeatRepo.findStale() — excludes fresh docs', () => {
  it('does not return docs whose ts is within the threshold', async () => {
    const base    = new Date('2024-06-01T12:00:00Z');
    const freshTs = new Date(base.getTime() - 1_000); // 1 s before base

    await Heartbeat.create({ component: 'bridge', id: 'b-fresh', ts: freshTs });

    // threshold = base - 5 s → freshTs is only 1 s old, not stale
    const repo = makeRepo(() => base);
    const stale = await repo.findStale({ olderThanMs: 5_000 });

    expect(stale).toHaveLength(0);
  });
});

// ── findStale() — boundary: exactly olderThanMs is NOT stale ─────────────────

describe('HeartbeatRepo.findStale() — boundary at exactly olderThanMs', () => {
  it('does not return a doc whose ts equals the threshold exactly', async () => {
    const base      = new Date('2024-06-01T12:00:00Z');
    const olderThanMs = 5_000;
    const exactTs   = new Date(base.getTime() - olderThanMs); // exactly on boundary

    await Heartbeat.create({ component: 'scp', id: 'scp-boundary', ts: exactTs });

    const repo  = makeRepo(() => base);
    const stale = await repo.findStale({ olderThanMs });

    // $lt is strict — equal-to-threshold is NOT stale
    expect(stale).toHaveLength(0);
  });
});

// ── findStale() — filtered by component ──────────────────────────────────────

describe('HeartbeatRepo.findStale() — filtered by component', () => {
  it('only returns stale docs for the given component', async () => {
    const base    = new Date('2024-06-01T12:00:00Z');
    const staleTs = new Date(base.getTime() - 20_000);

    await Heartbeat.create({ component: 'workspace', id: 'ws-stale', ts: staleTs });
    await Heartbeat.create({ component: 'rpc',       id: 'rpc-stale', ts: staleTs });

    const repo  = makeRepo(() => base);
    const stale = await repo.findStale({ component: 'workspace', olderThanMs: 10_000 });

    expect(stale).toHaveLength(1);
    expect(stale[0].component).toBe('workspace');
  });
});

// ── findStale() — without component returns all stale ────────────────────────

describe('HeartbeatRepo.findStale() — no component filter returns all stale', () => {
  it('returns stale docs across all components when component is omitted', async () => {
    const base    = new Date('2024-06-01T12:00:00Z');
    const staleTs = new Date(base.getTime() - 20_000);

    await Heartbeat.create({ component: 'workspace', id: 'ws-x', ts: staleTs });
    await Heartbeat.create({ component: 'rpc',       id: 'rpc-x', ts: staleTs });
    await Heartbeat.create({ component: 'bridge',    id: 'b-x',  ts: staleTs });

    const repo  = makeRepo(() => base);
    const stale = await repo.findStale({ olderThanMs: 10_000 });

    expect(stale).toHaveLength(3);
  });
});

// ── findAll() — returns all heartbeats ───────────────────────────────────────

describe('HeartbeatRepo.findAll() — returns all heartbeats', () => {
  it('returns all documents in the collection', async () => {
    const repo = makeRepo();
    await repo.record({ component: 'bridge',    id: 'b-1' });
    await repo.record({ component: 'workspace', id: 'ws-1' });
    await repo.record({ component: 'rpc',       id: 'r-1' });

    const all = await repo.findAll();
    expect(all).toHaveLength(3);
  });
});

// ── findAll() — empty collection ─────────────────────────────────────────────

describe('HeartbeatRepo.findAll() — empty collection', () => {
  it('returns an empty array when no heartbeats exist', async () => {
    const repo = makeRepo();
    const all  = await repo.findAll();
    expect(all).toEqual([]);
  });
});

// ── findAll() — sorted by component then id ──────────────────────────────────

describe('HeartbeatRepo.findAll() — sorted by component then id', () => {
  it('returns docs sorted ascending by component, then by id', async () => {
    const repo = makeRepo();
    // Insert in reverse-sorted order
    await repo.record({ component: 'workspace', id: 'ws-b' });
    await repo.record({ component: 'workspace', id: 'ws-a' });
    await repo.record({ component: 'rpc',       id: 'r-1' });
    await repo.record({ component: 'bridge',    id: 'b-1' });
    await repo.record({ component: 'scp',       id: 's-1' });

    const all = await repo.findAll();
    const keys = all.map((d) => `${d.component}:${d.id}`);
    expect(keys).toEqual([
      'bridge:b-1',
      'rpc:r-1',
      'scp:s-1',
      'workspace:ws-a',
      'workspace:ws-b',
    ]);
  });
});

// ── remove() — deletes existing doc ──────────────────────────────────────────

describe('HeartbeatRepo.remove() — deletes existing doc', () => {
  it('removes the document and returns true', async () => {
    const repo = makeRepo();
    await repo.record({ component: 'bridge', id: 'b-del' });

    const result = await repo.remove({ component: 'bridge', id: 'b-del' });
    expect(result).toBe(true);

    const remaining = await repo.findAll();
    expect(remaining).toHaveLength(0);
  });
});

// ── remove() — returns true on success ───────────────────────────────────────

describe('HeartbeatRepo.remove() — returns true on success', () => {
  it('returns exactly true (boolean) when a doc is deleted', async () => {
    const repo = makeRepo();
    await repo.record({ component: 'scp', id: 'scp-remove' });
    const result = await repo.remove({ component: 'scp', id: 'scp-remove' });
    expect(result).toBe(true);
  });
});

// ── remove() — returns false when not found ──────────────────────────────────

describe('HeartbeatRepo.remove() — returns false when not found', () => {
  it('returns false when no matching doc exists', async () => {
    const repo   = makeRepo();
    const result = await repo.remove({ component: 'rpc', id: 'ghost-id' });
    expect(result).toBe(false);
  });
});

// ── remove() — no-op on empty collection ─────────────────────────────────────

describe('HeartbeatRepo.remove() — no-op on empty collection', () => {
  it('returns false and does not throw when collection is empty', async () => {
    const repo   = makeRepo();
    const result = await repo.remove({ component: 'workspace', id: 'whatever' });
    expect(result).toBe(false);
  });
});

// ── record() — custom now injection produces deterministic ts ─────────────────

describe('HeartbeatRepo.record() — deterministic ts via injected now', () => {
  it('uses the injected now() for ts instead of wall-clock time', async () => {
    const fixed = new Date('2030-12-31T23:59:59Z');
    const repo  = makeRepo(() => fixed);

    const doc = await repo.record({ component: 'scp', id: 'deterministic' });
    expect(doc.ts).toEqual(fixed);

    // Ensure the persisted value matches too
    const fetched = await Heartbeat.findOne({ component: 'scp', id: 'deterministic' }).lean();
    expect(fetched.ts).toEqual(fixed);
  });
});
