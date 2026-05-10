/**
 * @file bridge/core/db/models/synaps-user.test.js
 *
 * Schema validation and round-trip tests for the SynapsUser model.
 *
 * Schema-level validation tests do not require a live DB connection.
 * Round-trip tests use mongodb-memory-server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { synapsUserSchema, getSynapsUserModel } from './synaps-user.js';

// ── Schema-level validation (no DB) ─────────────────────────────────────────

describe('synapsUserSchema — validation (no DB)', () => {
  let m;
  let Model;

  beforeAll(() => {
    m = new mongoose.Mongoose();
    m.set('strictQuery', true);
    Model = m.model('SynapsUserValidation', synapsUserSchema);
  });

  it('allows pria_user_id to be null (synthetic / channel-only users)', async () => {
    // IdentityRouter.resolve() creates SynapsUsers with pria_user_id: null for
    // inbound channel identities before a pria account is linked.
    const doc = new Model({ pria_user_id: null, memory_namespace: 'u_abc' });
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('requires memory_namespace', async () => {
    const doc = new Model({});
    await expect(doc.validate()).rejects.toThrow(/memory_namespace is required/);
  });

  it('rejects an invalid default_channel enum value', async () => {
    const doc = new Model({
      memory_namespace: 'u_abc',
      default_channel:  'pigeon',
    });
    await expect(doc.validate()).rejects.toThrow(/not a valid channel/);
  });

  it('accepts all valid channel enum values', async () => {
    const channels = ['slack', 'web', 'discord', 'telegram', 'teams'];
    for (const channel of channels) {
      const doc = new Model({
        memory_namespace: 'u_abc',
        default_channel:  channel,
      });
      await expect(doc.validate()).resolves.toBeUndefined();
    }
  });

  it('defaults default_channel to "web"', () => {
    const doc = new Model({
      memory_namespace: 'u_abc',
    });
    expect(doc.default_channel).toBe('web');
  });

  it('passes validation with only memory_namespace (pria_user_id is optional)', async () => {
    const doc = new Model({
      memory_namespace: 'u_507f1f77bcf86cd799439011',
    });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('accepts optional institution_id and workspace_id', async () => {
    const doc = new Model({
      memory_namespace: 'u_abc',
      institution_id:   new mongoose.Types.ObjectId(),
      workspace_id:     new mongoose.Types.ObjectId(),
      display_name:     'Jane Doe',
    });
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.display_name).toBe('Jane Doe');
  });
});

// ── Index definitions (no DB) ────────────────────────────────────────────────

describe('synapsUserSchema — indexes (no DB)', () => {
  it('declares a partial unique index on pria_user_id (only when set)', () => {
    const indexes = synapsUserSchema.indexes();
    const entry = indexes.find(
      ([fields, opts]) =>
        fields.pria_user_id === 1 &&
        opts.unique === true &&
        opts.partialFilterExpression != null,
    );
    expect(entry).toBeDefined();
    // Confirm the partial filter only applies when field is an actual ObjectId.
    expect(entry[1].partialFilterExpression).toEqual({
      pria_user_id: { $type: 'objectId' },
    });
  });

  it('declares a non-unique index on institution_id', () => {
    const indexes = synapsUserSchema.indexes();
    const entry = indexes.find(
      ([fields, opts]) => fields.institution_id === 1 && !opts.unique,
    );
    expect(entry).toBeDefined();
  });
});

// ── Round-trip tests (in-memory MongoDB) ────────────────────────────────────

describe('SynapsUser model — round-trip (in-memory DB)', () => {
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
    Model = getSynapsUserModel(m);
  }, 120_000);

  afterAll(async () => {
    await m.disconnect();
    await mongod.stop();
  });

  it('creates a document and fetches it back', async () => {
    const priaId = new mongoose.Types.ObjectId();
    const created = await Model.create({
      pria_user_id:     priaId,
      memory_namespace: `u_${priaId.toHexString()}`,
    });
    expect(created._id).toBeDefined();
    expect(created.default_channel).toBe('web');

    const fetched = await Model.findById(created._id).lean();
    expect(fetched).not.toBeNull();
    expect(String(fetched.pria_user_id)).toBe(String(priaId));
  });

  it('sets timestamps created_at and updated_at', async () => {
    const priaId = new mongoose.Types.ObjectId();
    const doc = await Model.create({
      pria_user_id:     priaId,
      memory_namespace: `u_${priaId.toHexString()}`,
    });
    expect(doc.created_at).toBeInstanceOf(Date);
    expect(doc.updated_at).toBeInstanceOf(Date);
  });

  it('enforces unique pria_user_id index (only for real ObjectId values)', async () => {
    const priaId = new mongoose.Types.ObjectId();
    await Model.create({
      pria_user_id:     priaId,
      memory_namespace: `u_${priaId.toHexString()}`,
    });
    await expect(
      Model.create({
        pria_user_id:     priaId,
        memory_namespace: `u_${priaId.toHexString()}_dup`,
      }),
    ).rejects.toThrow();
  });

  it('allows multiple documents with pria_user_id: null (partial index)', async () => {
    // Synthetic/channel-only SynapsUsers created by IdentityRouter.resolve()
    // all have null pria_user_id — the partial index must not reject them.
    await Model.create({ pria_user_id: null, memory_namespace: 'u_null_a' });
    await Model.create({ pria_user_id: null, memory_namespace: 'u_null_b' });
    const count = await Model.countDocuments({ pria_user_id: null });
    expect(count).toBe(2);
  });

  it('getSynapsUserModel returns the same model when called twice', () => {
    const m1 = getSynapsUserModel(m);
    const m2 = getSynapsUserModel(m);
    expect(m1).toBe(m2);
  });
});
