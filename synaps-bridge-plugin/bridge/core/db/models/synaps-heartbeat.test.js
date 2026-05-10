/**
 * @file bridge/core/db/models/synaps-heartbeat.test.js
 *
 * Schema-validation and round-trip tests for the Heartbeat model.
 *
 * Uses mongodb-memory-server for round-trip tests; schema-only tests run
 * without a live DB connection.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { makeHeartbeatModel } from './synaps-heartbeat.js';

// ── Shared in-memory DB ──────────────────────────────────────────────────────

let mongod;
let m;
let Heartbeat;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5_000,
    autoIndex: true, // build indexes so unique constraints are enforced
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

// ── 1. saves a heartbeat with valid fields ────────────────────────────────────

describe('Heartbeat model — saves a heartbeat with valid fields', () => {
  it('persists component, id, ts, healthy, details', async () => {
    const doc = await Heartbeat.create({
      component: 'bridge',
      id:        'bridge-main',
      ts:        new Date('2024-01-01T00:00:00Z'),
      healthy:   true,
      details:   { version: '0.1.0' },
    });

    expect(doc._id).toBeDefined();
    expect(doc.component).toBe('bridge');
    expect(doc.id).toBe('bridge-main');
    expect(doc.ts).toEqual(new Date('2024-01-01T00:00:00Z'));
    expect(doc.healthy).toBe(true);
    expect(doc.details).toMatchObject({ version: '0.1.0' });
  });
});

// ── 2. requires `component` ───────────────────────────────────────────────────

describe('Heartbeat model — requires component', () => {
  it('rejects a doc missing component', async () => {
    const doc = new Heartbeat({ id: 'ws-1' });
    await expect(doc.validate()).rejects.toThrow(/component is required/);
  });
});

// ── 3. requires `id` ─────────────────────────────────────────────────────────

describe('Heartbeat model — requires id', () => {
  it('rejects a doc missing id', async () => {
    const doc = new Heartbeat({ component: 'workspace' });
    await expect(doc.validate()).rejects.toThrow(/id is required/);
  });
});

// ── 4. enforces component enum ────────────────────────────────────────────────

describe('Heartbeat model — component enum', () => {
  it('rejects component value "invalid"', async () => {
    const doc = new Heartbeat({ component: 'invalid', id: 'x' });
    await expect(doc.validate()).rejects.toThrow(/not a valid heartbeat component/);
  });

  it('accepts all valid component values', async () => {
    for (const component of ['bridge', 'workspace', 'rpc', 'scp']) {
      const doc = new Heartbeat({ component, id: `${component}-test` });
      await expect(doc.validate()).resolves.toBeUndefined();
    }
  });
});

// ── 5. defaults `ts` to now when omitted ─────────────────────────────────────

describe('Heartbeat model — ts default', () => {
  it('sets ts to a Date near now when not provided', async () => {
    const before = Date.now();
    const doc = await Heartbeat.create({ component: 'rpc', id: 'sess-1' });
    const after = Date.now();

    expect(doc.ts).toBeInstanceOf(Date);
    expect(doc.ts.getTime()).toBeGreaterThanOrEqual(before);
    expect(doc.ts.getTime()).toBeLessThanOrEqual(after);
  });
});

// ── 6. defaults `healthy` to true ────────────────────────────────────────────

describe('Heartbeat model — healthy default', () => {
  it('sets healthy to true when not provided', async () => {
    const doc = await Heartbeat.create({ component: 'scp', id: 'scp-main' });
    expect(doc.healthy).toBe(true);
  });
});

// ── 7. defaults `details` to {} ──────────────────────────────────────────────

describe('Heartbeat model — details default', () => {
  it('sets details to {} when not provided', async () => {
    const doc = await Heartbeat.create({ component: 'bridge', id: 'b-1' });
    expect(doc.details).toEqual({});
  });
});

// ── 8. compound unique index {component, id} rejects duplicate ───────────────

describe('Heartbeat model — compound unique index', () => {
  it('rejects a second doc with the same component + id', async () => {
    await Heartbeat.create({ component: 'workspace', id: 'ws-abc' });
    await expect(
      Heartbeat.create({ component: 'workspace', id: 'ws-abc' }),
    ).rejects.toThrow();
  });
});

// ── 9. allows same id across different components ─────────────────────────────

describe('Heartbeat model — same id across different components', () => {
  it('allows two docs that share id but differ on component', async () => {
    await Heartbeat.create({ component: 'workspace', id: 'shared-id' });
    await expect(
      Heartbeat.create({ component: 'rpc', id: 'shared-id' }),
    ).resolves.toBeDefined();
  });
});

// ── 10. details stores arbitrary mixed shapes ─────────────────────────────────

describe('Heartbeat model — details mixed shape', () => {
  it('persists arbitrary nested objects in details', async () => {
    const complexDetails = {
      cpu:         0.42,
      memory:      { used: 512, total: 2048 },
      queue_depth: 7,
      tags:        ['alpha', 'beta'],
    };
    const doc = await Heartbeat.create({
      component: 'scp',
      id:        'scp-complex',
      details:   complexDetails,
    });

    const fetched = await Heartbeat.findById(doc._id).lean();
    expect(fetched.details.cpu).toBe(0.42);
    expect(fetched.details.memory).toEqual({ used: 512, total: 2048 });
    expect(fetched.details.queue_depth).toBe(7);
    expect(fetched.details.tags).toEqual(['alpha', 'beta']);
  });
});

// ── Bonus: makeHeartbeatModel returns the same model when called twice ────────

describe('makeHeartbeatModel — idempotent', () => {
  it('returns the exact same model instance on repeated calls', () => {
    const m1 = makeHeartbeatModel(m);
    const m2 = makeHeartbeatModel(m);
    expect(m1).toBe(m2);
  });
});
