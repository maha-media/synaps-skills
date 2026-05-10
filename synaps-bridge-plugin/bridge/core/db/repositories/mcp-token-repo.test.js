/**
 * @file bridge/core/db/repositories/mcp-token-repo.test.js
 *
 * Tests for McpTokenRepo.
 *
 * Uses mongodb-memory-server for an in-process MongoDB instance.
 * The SynapsMcpToken model is imported directly (not inlined) because
 * the repo test suite owns the full contract.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getSynapsMcpTokenModel } from '../models/synaps-mcp-token.js';
import { McpTokenRepo } from './mcp-token-repo.js';

// ── Module-level fixtures ─────────────────────────────────────────────────────

let mongod;
let m;
let Model;
let repo;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Frozen-clock factory.  Returns a constructor whose instances report a fixed time.
 *
 * @param {number} ts - Milliseconds since epoch.
 * @returns {function} - A constructor that behaves like `new Date()` → frozen Date.
 */
function frozenClock(ts) {
  const frozen = new Date(ts);
  // Act as a constructor: `new frozenClock()` → frozen Date instance.
  function FrozenClock() {
    if (!(this instanceof FrozenClock)) return new FrozenClock();
    Object.setPrototypeOf(this, Date.prototype);
    this._ts = ts;
  }
  FrozenClock.prototype = Object.create(Date.prototype);
  FrozenClock.prototype.getTime = function () { return ts; };
  FrozenClock.now = () => ts;
  // Make `new FrozenClock()` return a real Date with the frozen value.
  // Simpler: just return a plain class.
  class Clock {
    constructor() { return new Date(ts); }
    static now() { return ts; }
  }
  return Clock;
}

/** Build a minimal valid token payload. */
const newToken = (overrides = {}) => ({
  token_hash:     'a'.repeat(64),
  synaps_user_id: new m.Types.ObjectId(),
  institution_id: new m.Types.ObjectId(),
  name:           'test-token',
  ...overrides,
});

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5000,
    autoIndex: true,
  });

  Model = getSynapsMcpTokenModel(m);
  repo  = new McpTokenRepo({ db: Model });
}, 120_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

// ── create() ─────────────────────────────────────────────────────────────────

describe('McpTokenRepo.create()', () => {
  it('returns { _id, name, expires_at, created_at } — no token_hash', async () => {
    const result = await repo.create(newToken());
    expect(result).toHaveProperty('_id');
    expect(result).toHaveProperty('name', 'test-token');
    expect(result).toHaveProperty('expires_at', null);
    expect(result).toHaveProperty('created_at');
    expect(result).not.toHaveProperty('token_hash');
    // Must NOT leak other fields
    expect(result).not.toHaveProperty('synaps_user_id');
    expect(result).not.toHaveProperty('revoked_at');
  });

  it('persists the row with all fields correctly', async () => {
    const uid  = new m.Types.ObjectId();
    const inst = new m.Types.ObjectId();
    const exp  = new Date(Date.now() + 60_000);

    const result = await repo.create({
      token_hash:     'b'.repeat(64),
      synaps_user_id: uid,
      institution_id: inst,
      name:           'my-token',
      expires_at:     exp,
      scopes:         ['read'],
    });

    const stored = await Model.findById(result._id).lean();
    expect(stored.token_hash).toBe('b'.repeat(64));
    expect(String(stored.synaps_user_id)).toBe(String(uid));
    expect(String(stored.institution_id)).toBe(String(inst));
    expect(stored.name).toBe('my-token');
    expect(stored.expires_at.getTime()).toBe(exp.getTime());
    expect(stored.scopes).toEqual(['read']);
    expect(stored.revoked_at).toBeNull();
    expect(stored.last_used_at).toBeNull();
  });

  it('defaults scopes to ["*"] when not provided', async () => {
    const result = await repo.create(newToken());
    const stored = await Model.findById(result._id).lean();
    expect(stored.scopes).toEqual(['*']);
  });

  it('created_at is approximately now', async () => {
    const before = Date.now();
    const result = await repo.create(newToken());
    const after  = Date.now();
    expect(result.created_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.created_at.getTime()).toBeLessThanOrEqual(after);
  });
});

// ── findActive() ─────────────────────────────────────────────────────────────

describe('McpTokenRepo.findActive()', () => {
  it('returns the row when not expired and not revoked', async () => {
    const hash = 'c'.repeat(64);
    await repo.create(newToken({ token_hash: hash }));

    const found = await repo.findActive(hash);
    expect(found).not.toBeNull();
    expect(found.name).toBe('test-token');
  });

  it('returned row contains _id, synaps_user_id, institution_id, name, scopes', async () => {
    const hash = 'c1'.padEnd(64, '0');
    const uid  = new m.Types.ObjectId();
    const inst = new m.Types.ObjectId();
    await repo.create(newToken({ token_hash: hash, synaps_user_id: uid, institution_id: inst }));

    const found = await repo.findActive(hash);
    expect(found).toHaveProperty('_id');
    expect(found).toHaveProperty('synaps_user_id');
    expect(found).toHaveProperty('institution_id');
    expect(found).toHaveProperty('name');
    expect(found).toHaveProperty('scopes');
  });

  it('returns null for unknown hash', async () => {
    const found = await repo.findActive('0'.repeat(64));
    expect(found).toBeNull();
  });

  it('returns null when revoked_at is set', async () => {
    const hash = 'd'.repeat(64);
    const result = await repo.create(newToken({ token_hash: hash }));
    await Model.findByIdAndUpdate(result._id, { $set: { revoked_at: new Date() } });

    const found = await repo.findActive(hash);
    expect(found).toBeNull();
  });

  it('returns null when expires_at is in the past', async () => {
    const hash    = 'e'.repeat(64);
    const pastExp = new Date(Date.now() - 1_000);
    await repo.create(newToken({ token_hash: hash, expires_at: pastExp }));

    const found = await repo.findActive(hash);
    expect(found).toBeNull();
  });

  it('returns the row when expires_at is in the future', async () => {
    const hash    = 'f'.repeat(64);
    const futExp  = new Date(Date.now() + 60_000);
    await repo.create(newToken({ token_hash: hash, expires_at: futExp }));

    const found = await repo.findActive(hash);
    expect(found).not.toBeNull();
  });

  it('returns the row when expires_at is null (never expires)', async () => {
    const hash = 'f1'.padEnd(64, '1');
    await repo.create(newToken({ token_hash: hash, expires_at: null }));

    const found = await repo.findActive(hash);
    expect(found).not.toBeNull();
  });

  it('does NOT update last_used_at on findActive', async () => {
    const hash   = 'f2'.padEnd(64, '2');
    const result = await repo.create(newToken({ token_hash: hash }));

    await repo.findActive(hash);

    const stored = await Model.findById(result._id).lean();
    expect(stored.last_used_at).toBeNull();
  });
});

// ── touch() ───────────────────────────────────────────────────────────────────

describe('McpTokenRepo.touch()', () => {
  it('updates last_used_at', async () => {
    const result = await repo.create(newToken({ token_hash: 'g'.repeat(64) }));

    const before = Date.now();
    await repo.touch(result._id);
    const after = Date.now();

    const stored = await Model.findById(result._id).lean();
    expect(stored.last_used_at).not.toBeNull();
    expect(stored.last_used_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored.last_used_at.getTime()).toBeLessThanOrEqual(after);
  });

  it('second touch overwrites last_used_at', async () => {
    const t1 = Date.now() - 5_000;
    const t2 = Date.now();
    const clock1 = frozenClock(t1);
    const clock2 = frozenClock(t2);

    const result = await repo.create(newToken({ token_hash: 'h'.repeat(64) }));

    const repo1 = new McpTokenRepo({ db: Model, clock: clock1 });
    await repo1.touch(result._id);
    const stored1 = await Model.findById(result._id).lean();
    expect(stored1.last_used_at.getTime()).toBe(t1);

    const repo2 = new McpTokenRepo({ db: Model, clock: clock2 });
    await repo2.touch(result._id);
    const stored2 = await Model.findById(result._id).lean();
    expect(stored2.last_used_at.getTime()).toBe(t2);
  });

  it('does not throw for an unknown token_id', async () => {
    const fakeId = new m.Types.ObjectId();
    await expect(repo.touch(fakeId)).resolves.toBeUndefined();
  });

  it('updates last_used_at even on a revoked token', async () => {
    const hash   = 'i'.repeat(64);
    const result = await repo.create(newToken({ token_hash: hash }));
    await repo.revoke(result._id);

    await repo.touch(result._id);

    const stored = await Model.findById(result._id).lean();
    // last_used_at should have been set even though revoked
    expect(stored.last_used_at).not.toBeNull();
  });
});

// ── list() ────────────────────────────────────────────────────────────────────

describe('McpTokenRepo.list()', () => {
  it('list({ synaps_user_id }) returns only that user\'s tokens', async () => {
    const uid1 = new m.Types.ObjectId();
    const uid2 = new m.Types.ObjectId();
    const inst  = new m.Types.ObjectId();

    await repo.create(newToken({ token_hash: 'j1'.padEnd(64, '1'), synaps_user_id: uid1, institution_id: inst, name: 'tok-A' }));
    await repo.create(newToken({ token_hash: 'j2'.padEnd(64, '2'), synaps_user_id: uid1, institution_id: inst, name: 'tok-B' }));
    await repo.create(newToken({ token_hash: 'j3'.padEnd(64, '3'), synaps_user_id: uid2, institution_id: inst, name: 'tok-C' }));

    const results = await repo.list({ synaps_user_id: uid1 });
    expect(results).toHaveLength(2);
    const names = results.map(r => r.name);
    expect(names).toContain('tok-A');
    expect(names).toContain('tok-B');
    expect(names).not.toContain('tok-C');
  });

  it('list({ institution_id }) returns only that institution\'s tokens', async () => {
    const uid  = new m.Types.ObjectId();
    const inst1 = new m.Types.ObjectId();
    const inst2 = new m.Types.ObjectId();

    await repo.create(newToken({ token_hash: 'k1'.padEnd(64, '1'), synaps_user_id: uid, institution_id: inst1, name: 'tok-X' }));
    await repo.create(newToken({ token_hash: 'k2'.padEnd(64, '2'), synaps_user_id: uid, institution_id: inst2, name: 'tok-Y' }));

    const results = await repo.list({ institution_id: inst1 });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('tok-X');
  });

  it('list({ synaps_user_id, institution_id }) ANDs the filter', async () => {
    const uid1  = new m.Types.ObjectId();
    const uid2  = new m.Types.ObjectId();
    const inst1 = new m.Types.ObjectId();
    const inst2 = new m.Types.ObjectId();

    await repo.create(newToken({ token_hash: 'l1'.padEnd(64, '1'), synaps_user_id: uid1, institution_id: inst1, name: 'match' }));
    await repo.create(newToken({ token_hash: 'l2'.padEnd(64, '2'), synaps_user_id: uid1, institution_id: inst2, name: 'wrong-inst' }));
    await repo.create(newToken({ token_hash: 'l3'.padEnd(64, '3'), synaps_user_id: uid2, institution_id: inst1, name: 'wrong-user' }));

    const results = await repo.list({ synaps_user_id: uid1, institution_id: inst1 });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('match');
  });

  it('list results are sorted by created_at descending', async () => {
    const uid  = new m.Types.ObjectId();
    const inst = new m.Types.ObjectId();

    const t1 = new Date(Date.now() - 2_000);
    const t2 = new Date(Date.now() - 1_000);
    const t3 = new Date(Date.now());

    await Model.create({ token_hash: 'm1'.padEnd(64, '1'), synaps_user_id: uid, institution_id: inst, name: 'oldest',  created_at: t1 });
    await Model.create({ token_hash: 'm2'.padEnd(64, '2'), synaps_user_id: uid, institution_id: inst, name: 'middle',  created_at: t2 });
    await Model.create({ token_hash: 'm3'.padEnd(64, '3'), synaps_user_id: uid, institution_id: inst, name: 'newest',  created_at: t3 });

    const results = await repo.list({ synaps_user_id: uid });
    expect(results[0].name).toBe('newest');
    expect(results[1].name).toBe('middle');
    expect(results[2].name).toBe('oldest');
  });

  it('list result rows do NOT include token_hash', async () => {
    const uid  = new m.Types.ObjectId();
    const inst = new m.Types.ObjectId();
    await repo.create(newToken({ token_hash: 'n'.repeat(64), synaps_user_id: uid, institution_id: inst }));

    const results = await repo.list({ synaps_user_id: uid });
    expect(results).toHaveLength(1);
    expect(results[0]).not.toHaveProperty('token_hash');
  });
});

// ── revoke() ──────────────────────────────────────────────────────────────────

describe('McpTokenRepo.revoke()', () => {
  it('sets revoked_at to approximately now', async () => {
    const result = await repo.create(newToken({ token_hash: 'o'.repeat(64) }));

    const before = Date.now();
    const { ok } = await repo.revoke(result._id);
    const after  = Date.now();

    expect(ok).toBe(true);

    const stored = await Model.findById(result._id).lean();
    expect(stored.revoked_at).not.toBeNull();
    expect(stored.revoked_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored.revoked_at.getTime()).toBeLessThanOrEqual(after);
  });

  it('revoke is idempotent — second call does not update revoked_at', async () => {
    const ts   = Date.now() - 5_000;
    const clock = frozenClock(ts);
    const frozenRepo = new McpTokenRepo({ db: Model, clock });

    const result = await frozenRepo.create(newToken({ token_hash: 'p'.repeat(64) }));
    await frozenRepo.revoke(result._id);

    // Second revoke — unfreeze clock to a later time; revoked_at must stay at ts.
    const { ok: ok2 } = await repo.revoke(result._id);
    expect(ok2).toBe(true);

    const stored = await Model.findById(result._id).lean();
    expect(stored.revoked_at.getTime()).toBe(ts);
  });

  it('returns { ok: false } for an unknown token_id', async () => {
    const fakeId = new m.Types.ObjectId();
    const result = await repo.revoke(fakeId);
    expect(result).toEqual({ ok: false });
  });

  it('after revoke, findActive returns null', async () => {
    const hash   = 'q'.repeat(64);
    const result = await repo.create(newToken({ token_hash: hash }));

    // Confirm active before revoke
    const before = await repo.findActive(hash);
    expect(before).not.toBeNull();

    await repo.revoke(result._id);

    const after = await repo.findActive(hash);
    expect(after).toBeNull();
  });
});
