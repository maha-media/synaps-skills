/**
 * @file tests/scp-phase-5/00-heartbeat-emitter-mongo.test.mjs
 *
 * Acceptance tests for HeartbeatEmitter wired to a real mongo-memory-server.
 *
 * Strategy
 * ────────
 * • MongoMemoryServer provides a real in-process MongoDB instance.
 * • A private mongoose.Mongoose() instance avoids polluting any global state.
 * • makeHeartbeatRepo(mongoose) builds the production repo (no mocks).
 * • HeartbeatEmitter is constructed with REAL timers (vi.useRealTimers() is the
 *   default for .mjs acceptance tests — we never call vi.useFakeTimers() here).
 * • A short intervalMs of 50 ms lets 2+ beats land within a 200 ms window so
 *   tests stay fast while still exercising the real scheduling path.
 *
 * Scenarios (5 tests)
 * ───────────────────
 * 1. Start emitter, wait ~150 ms for ≥2 ticks, assert exactly ONE DB row exists
 *    (upsert key prevents duplicates) with a recent `ts`.
 * 2. Stop emitter, assert the final shutdown beat wrote healthy:false to the DB.
 * 3. detailsFn output is persisted in the `details` field.
 * 4. healthFn returning false is stored as healthy:false on every beat.
 * 5. Concurrent emitters with different `id` values create separate rows.
 *
 * Constraints
 * ───────────
 * • ESM only (.mjs)
 * • vi.useRealTimers() (default) — real setInterval drives the emitter.
 * • beforeAll timeout ≥ 60_000 (mongo-memory-server startup).
 * • No top-level await.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { makeHeartbeatRepo }   from '../../bridge/core/db/index.js';
import { HeartbeatEmitter }    from '../../bridge/core/heartbeat-emitter.js';
import { makeHeartbeatModel }  from '../../bridge/core/db/models/synaps-heartbeat.js';

// ─── Module-level fixtures ────────────────────────────────────────────────────

let mongod;
let m;   // private mongoose.Mongoose instance

/** Convenience: wait `ms` real milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Silent logger – keeps output clean. */
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m      = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), { serverSelectionTimeoutMS: 5_000, autoIndex: true });
}, 60_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  // Wipe the heartbeat collection before each test for isolation.
  const Heartbeat = makeHeartbeatModel(m);
  await Heartbeat.deleteMany({});
});

// ─── 1. Start emitter → single row in DB (upsert prevents duplicates) ─────────

describe('HeartbeatEmitter — DB upsert prevents duplicates', () => {
  let emitter;

  afterEach(async () => {
    if (emitter?.running) await emitter.stop();
  });

  it('produces exactly one DB row after multiple ticks', async () => {
    const repo = makeHeartbeatRepo(m);
    emitter = new HeartbeatEmitter({
      repo,
      component:  'bridge',
      id:         'main',
      intervalMs: 50,
      logger:     silent,
    });

    emitter.start();

    // Wait long enough for ≥2 scheduled beats (50 ms interval → ~3 beats in 150 ms).
    await sleep(170);

    const all = await repo.findAll();
    expect(all).toHaveLength(1);

    const row = all[0];
    expect(row.component).toBe('bridge');
    expect(row.id).toBe('main');
    expect(row.healthy).toBe(true);
    // ts should be within the last 500 ms.
    expect(Date.now() - row.ts.getTime()).toBeLessThan(500);
  });
});

// ─── 2. Stop emitter → final beat writes healthy:false ───────────────────────

describe('HeartbeatEmitter — stop() writes healthy:false', () => {
  it('final shutdown beat sets healthy:false in the DB', async () => {
    const repo = makeHeartbeatRepo(m);
    const emitter = new HeartbeatEmitter({
      repo,
      component:  'workspace',
      id:         'ws_stop_test',
      intervalMs: 50,
      logger:     silent,
    });

    emitter.start();
    await sleep(60);   // let at least one beat land
    await emitter.stop();  // triggers best-effort final beat

    const all = await repo.findAll();
    expect(all).toHaveLength(1);

    const row = all[0];
    expect(row.component).toBe('workspace');
    expect(row.id).toBe('ws_stop_test');
    expect(row.healthy).toBe(false);
    // stop() writes { reason: 'shutdown' } in details
    expect(row.details).toMatchObject({ reason: 'shutdown' });
  });
});

// ─── 3. detailsFn output stored in `details` field ───────────────────────────

describe('HeartbeatEmitter — detailsFn persisted in details', () => {
  let emitter;

  afterEach(async () => {
    if (emitter?.running) await emitter.stop();
  });

  it('stores the return value of detailsFn in the details column', async () => {
    const repo = makeHeartbeatRepo(m);
    const detailsPayload = { cpu: 42, queue_depth: 7 };

    emitter = new HeartbeatEmitter({
      repo,
      component:  'rpc',
      id:         'sess_detail_test',
      intervalMs: 50,
      detailsFn:  () => detailsPayload,
      logger:     silent,
    });

    emitter.start();
    await sleep(80);

    const all = await repo.findAll();
    expect(all).toHaveLength(1);
    // Lean docs return plain objects — compare the shape.
    expect(all[0].details).toMatchObject({ cpu: 42, queue_depth: 7 });
  });
});

// ─── 4. healthFn returning false → healthy:false persisted ───────────────────

describe('HeartbeatEmitter — healthFn:false stored as healthy:false', () => {
  let emitter;

  afterEach(async () => {
    if (emitter?.running) await emitter.stop();
  });

  it('records healthy:false when healthFn returns false', async () => {
    const repo = makeHeartbeatRepo(m);

    emitter = new HeartbeatEmitter({
      repo,
      component:  'scp',
      id:         'scp_unhealthy_test',
      intervalMs: 50,
      healthFn:   () => false,
      logger:     silent,
    });

    emitter.start();
    await sleep(80);

    const all = await repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0].healthy).toBe(false);
  });
});

// ─── 5. Concurrent emitters with different id → separate rows ─────────────────

describe('HeartbeatEmitter — concurrent emitters create separate rows', () => {
  const emitters = [];

  afterEach(async () => {
    for (const e of emitters) {
      if (e.running) await e.stop();
    }
    emitters.length = 0;
  });

  it('two emitters with different ids produce two independent DB rows', async () => {
    const repo = makeHeartbeatRepo(m);

    const eA = new HeartbeatEmitter({
      repo,
      component:  'workspace',
      id:         'ws_alice',
      intervalMs: 50,
      logger:     silent,
    });

    const eB = new HeartbeatEmitter({
      repo,
      component:  'workspace',
      id:         'ws_bob',
      intervalMs: 50,
      logger:     silent,
    });

    emitters.push(eA, eB);
    eA.start();
    eB.start();
    await sleep(170);

    const all = await repo.findAll();
    // Should have exactly 2 rows — one per (component, id) pair.
    expect(all).toHaveLength(2);

    const ids = all.map((r) => r.id).sort();
    expect(ids).toEqual(['ws_alice', 'ws_bob']);

    // Both rows belong to the 'workspace' component.
    for (const row of all) {
      expect(row.component).toBe('workspace');
      expect(row.healthy).toBe(true);
    }
  });
});
