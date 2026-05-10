/**
 * @file bridge/core/db/models/synaps-mcp-token.test.js
 *
 * Schema validation and index tests for the SynapsMcpToken model.
 *
 * Schema-level validation tests do not require a live DB connection.
 * Index enforcement tests use mongodb-memory-server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { synapsMcpTokenSchema, getSynapsMcpTokenModel } from './synaps-mcp-token.js';

// ── Schema-level validation (no DB) ──────────────────────────────────────────

describe('synapsMcpTokenSchema — validation (no DB)', () => {
  let m;
  let Model;

  beforeAll(() => {
    m = new mongoose.Mongoose();
    m.set('strictQuery', true);
    Model = m.model('SynapsMcpTokenValidation', synapsMcpTokenSchema);
  });

  const validBase = () => ({
    token_hash:     'a'.repeat(64),
    synaps_user_id: new mongoose.Types.ObjectId(),
    institution_id: new mongoose.Types.ObjectId(),
    name:           'claude-desktop-laptop',
  });

  it('passes validation with all required fields', async () => {
    const doc = new Model(validBase());
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('requires token_hash', async () => {
    const { token_hash: _omit, ...rest } = validBase();
    const doc = new Model(rest);
    await expect(doc.validate()).rejects.toThrow(/token_hash is required/);
  });

  it('requires synaps_user_id', async () => {
    const { synaps_user_id: _omit, ...rest } = validBase();
    const doc = new Model(rest);
    await expect(doc.validate()).rejects.toThrow(/synaps_user_id is required/);
  });

  it('requires institution_id', async () => {
    const { institution_id: _omit, ...rest } = validBase();
    const doc = new Model(rest);
    await expect(doc.validate()).rejects.toThrow(/institution_id is required/);
  });

  it('requires name', async () => {
    const { name: _omit, ...rest } = validBase();
    const doc = new Model(rest);
    await expect(doc.validate()).rejects.toThrow(/name is required/);
  });

  it('defaults scopes to ["*"]', () => {
    const doc = new Model(validBase());
    expect(doc.scopes).toEqual(['*']);
  });

  it('defaults created_at to approximately now', () => {
    const before = Date.now();
    const doc = new Model(validBase());
    const after = Date.now();
    expect(doc.created_at).toBeInstanceOf(Date);
    expect(doc.created_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(doc.created_at.getTime()).toBeLessThanOrEqual(after);
  });

  it('defaults last_used_at to null', () => {
    const doc = new Model(validBase());
    expect(doc.last_used_at).toBeNull();
  });

  it('defaults expires_at to null', () => {
    const doc = new Model(validBase());
    expect(doc.expires_at).toBeNull();
  });

  it('defaults revoked_at to null', () => {
    const doc = new Model(validBase());
    expect(doc.revoked_at).toBeNull();
  });

  it('lowercases token_hash on set', () => {
    const doc = new Model({ ...validBase(), token_hash: 'A'.repeat(64) });
    expect(doc.token_hash).toBe('a'.repeat(64));
  });

  it('accepts custom scopes array', async () => {
    const doc = new Model({ ...validBase(), scopes: ['read', 'write'] });
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.scopes).toEqual(['read', 'write']);
  });
});

// ── Index definitions (no DB) ─────────────────────────────────────────────────

describe('synapsMcpTokenSchema — indexes (no DB)', () => {
  it('declares a unique+partial index on token_hash where revoked_at is null', () => {
    const indexes = synapsMcpTokenSchema.indexes();
    const entry = indexes.find(([fields, opts]) =>
      fields.token_hash === 1 &&
      opts.unique === true &&
      opts.partialFilterExpression?.revoked_at === null,
    );
    expect(entry).toBeDefined();
  });

  it('declares an index on synaps_user_id', () => {
    const indexes = synapsMcpTokenSchema.indexes();
    const entry = indexes.find(([fields]) => fields.synaps_user_id === 1);
    expect(entry).toBeDefined();
  });

  it('declares an index on institution_id', () => {
    const indexes = synapsMcpTokenSchema.indexes();
    const entry = indexes.find(([fields]) => fields.institution_id === 1);
    expect(entry).toBeDefined();
  });
});

// ── Round-trip + index enforcement (in-memory MongoDB) ───────────────────────

describe('SynapsMcpToken model — round-trip + index enforcement (in-memory DB)', () => {
  let mongod;
  let m;
  let Model;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    m = new mongoose.Mongoose();
    m.set('strictQuery', true);
    await m.connect(mongod.getUri(), {
      serverSelectionTimeoutMS: 5000,
      autoIndex: true,
    });
    Model = getSynapsMcpTokenModel(m);
  }, 120_000);

  afterAll(async () => {
    await m.disconnect();
    await mongod.stop();
  });

  const baseDoc = () => ({
    token_hash:     'b'.repeat(64),
    synaps_user_id: new mongoose.Types.ObjectId(),
    institution_id: new mongoose.Types.ObjectId(),
    name:           'test-token',
  });

  it('creates a document and fetches it back', async () => {
    const created = await Model.create(baseDoc());
    expect(created._id).toBeDefined();
    expect(created.revoked_at).toBeNull();

    const fetched = await Model.findById(created._id).lean();
    expect(fetched).not.toBeNull();
    expect(fetched.name).toBe('test-token');
  });

  it('getSynapsMcpTokenModel returns the same model when called twice', () => {
    const m1 = getSynapsMcpTokenModel(m);
    const m2 = getSynapsMcpTokenModel(m);
    expect(m1).toBe(m2);
  });

  it('unique+partial index: two non-revoked rows with same token_hash → duplicate-key error', async () => {
    const hash = 'c'.repeat(64);
    await Model.create({ ...baseDoc(), token_hash: hash });
    await expect(
      Model.create({ ...baseDoc(), token_hash: hash }),
    ).rejects.toThrow();
  });

  it('unique+partial index: one revoked + one non-revoked with same token_hash → allowed', async () => {
    const hash = 'd'.repeat(64);
    // First token: insert then revoke it
    const first = await Model.create({ ...baseDoc(), token_hash: hash });
    await Model.findByIdAndUpdate(first._id, { $set: { revoked_at: new Date() } });

    // Second token with the same hash — revoked_at is null, first is revoked, so no conflict
    await expect(
      Model.create({ ...baseDoc(), token_hash: hash }),
    ).resolves.toBeDefined();
  });
});
