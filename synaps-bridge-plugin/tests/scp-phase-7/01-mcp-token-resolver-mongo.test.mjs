/**
 * @file tests/scp-phase-7/01-mcp-token-resolver-mongo.test.mjs
 *
 * Live mongo-memory-server. End-to-end token lifecycle:
 *   - create → resolve → returns user context
 *   - create + immediate resolve uses a freshly-hashed lookup
 *   - expired token → resolve returns null
 *   - revoked token → resolve returns null
 *   - two non-revoked rows with identical hash → unique index violation
 *   - a revoked row plus a new non-revoked row with same hash → allowed
 *   - resolve touches last_used_at
 *   - resolve does NOT touch when token not found
 *   - generateRawToken → hashToken → repo.create → resolver.resolve → same _id
 *   - token.scopes defaults to ['*']
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { getSynapsMcpTokenModel } from '../../bridge/core/db/models/synaps-mcp-token.js';
import { McpTokenRepo }           from '../../bridge/core/db/repositories/mcp-token-repo.js';
import { McpTokenResolver, generateRawToken, hashToken } from '../../bridge/core/mcp/mcp-token-resolver.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Fake ObjectId-like string that passes Mongoose ObjectId validation. */
function fakeOid() {
  return new mongoose.Types.ObjectId().toString();
}

// ─── Module-level fixtures ────────────────────────────────────────────────────

let mongod;
let m;         // test-local mongoose instance
let Model;     // SynapsMcpToken model
let repo;      // McpTokenRepo
let resolver;  // McpTokenResolver

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m      = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), { serverSelectionTimeoutMS: 10_000, autoIndex: true });
  Model    = getSynapsMcpTokenModel(m);
  repo     = new McpTokenRepo({ db: Model });
  resolver = new McpTokenResolver({ tokenRepo: repo, logger: silent });
}, 60_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpTokenResolver — end-to-end with real Mongo', () => {

  it('create → resolve → returns user context', async () => {
    const raw            = generateRawToken();
    const hash           = hashToken(raw);
    const synaps_user_id = fakeOid();
    const institution_id = fakeOid();

    await repo.create({ token_hash: hash, synaps_user_id, institution_id, name: 'test' });

    const ctx = await resolver.resolve(raw);
    expect(ctx).not.toBeNull();
    expect(String(ctx.synaps_user_id)).toBe(synaps_user_id);
    expect(String(ctx.institution_id)).toBe(institution_id);
  });

  it('create + immediate resolve uses freshly-hashed lookup', async () => {
    const raw  = generateRawToken();
    const hash = hashToken(raw);

    await repo.create({ token_hash: hash, synaps_user_id: fakeOid(), institution_id: fakeOid(), name: 'immediate' });

    const ctx = await resolver.resolve(raw);
    expect(ctx).not.toBeNull();
  });

  it('expired token → resolve returns null', async () => {
    const raw  = generateRawToken();
    const hash = hashToken(raw);

    // Set expires_at in the past
    await repo.create({
      token_hash:     hash,
      synaps_user_id: fakeOid(),
      institution_id: fakeOid(),
      name:           'expired',
      expires_at:     new Date(Date.now() - 1_000),
    });

    const ctx = await resolver.resolve(raw);
    expect(ctx).toBeNull();
  });

  it('revoked token → resolve returns null', async () => {
    const raw  = generateRawToken();
    const hash = hashToken(raw);

    const row = await repo.create({ token_hash: hash, synaps_user_id: fakeOid(), institution_id: fakeOid(), name: 'to-revoke' });
    await repo.revoke(row._id);

    const ctx = await resolver.resolve(raw);
    expect(ctx).toBeNull();
  });

  it('two non-revoked rows with identical hash → unique index violation', async () => {
    const raw  = generateRawToken();
    const hash = hashToken(raw);

    await repo.create({ token_hash: hash, synaps_user_id: fakeOid(), institution_id: fakeOid(), name: 'first' });

    await expect(
      repo.create({ token_hash: hash, synaps_user_id: fakeOid(), institution_id: fakeOid(), name: 'duplicate' }),
    ).rejects.toThrow();
  });

  it('revoked row + new non-revoked row with same hash → both allowed (partial index)', async () => {
    const raw  = generateRawToken();
    const hash = hashToken(raw);

    const first = await repo.create({ token_hash: hash, synaps_user_id: fakeOid(), institution_id: fakeOid(), name: 'first' });
    await repo.revoke(first._id);

    // Re-inserting the same hash should NOT throw now that first is revoked.
    await expect(
      repo.create({ token_hash: hash, synaps_user_id: fakeOid(), institution_id: fakeOid(), name: 'second' }),
    ).resolves.not.toThrow();
  });

  it('resolve touches last_used_at; check it is a Date roughly now', async () => {
    const raw  = generateRawToken();
    const hash = hashToken(raw);

    const row = await repo.create({ token_hash: hash, synaps_user_id: fakeOid(), institution_id: fakeOid(), name: 'touch-test' });

    // Before resolve, last_used_at should be null
    const before = await Model.findById(row._id).lean();
    expect(before.last_used_at).toBeNull();

    await resolver.resolve(raw);

    // Allow a small delay for the best-effort touch to complete
    await new Promise((r) => setTimeout(r, 50));

    const after = await Model.findById(row._id).lean();
    expect(after.last_used_at).toBeInstanceOf(Date);
    expect(Math.abs(after.last_used_at.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('resolve does NOT touch when token not found', async () => {
    const nonExistentRaw = generateRawToken(); // not inserted

    // Should not throw, should return null
    const ctx = await resolver.resolve(nonExistentRaw);
    expect(ctx).toBeNull();

    // No documents at all
    const count = await Model.countDocuments({});
    expect(count).toBe(0);
  });

  it('generateRawToken → hashToken → repo.create → resolver.resolve → same _id', async () => {
    const raw            = generateRawToken();
    const hash           = hashToken(raw);
    const synaps_user_id = fakeOid();

    const created = await repo.create({ token_hash: hash, synaps_user_id, institution_id: fakeOid(), name: 'chain-test' });

    const ctx = await resolver.resolve(raw);
    expect(ctx).not.toBeNull();
    expect(String(ctx.token_id)).toBe(String(created._id));
  });

  it('token.scopes defaults to [\'*\']', async () => {
    const raw  = generateRawToken();
    const hash = hashToken(raw);

    await repo.create({ token_hash: hash, synaps_user_id: fakeOid(), institution_id: fakeOid(), name: 'scopes-test' });

    const doc = await Model.findOne({ token_hash: hash }).lean();
    expect(doc.scopes).toEqual(['*']);
  });
});
