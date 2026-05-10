/**
 * @file bridge/core/db/models/synaps-link-code.test.js
 *
 * Schema validation and round-trip tests for the SynapsLinkCode model.
 *
 * Schema-level validation tests do not require a live DB connection.
 * Round-trip tests use mongodb-memory-server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { synapsLinkCodeSchema, getSynapsLinkCodeModel } from './synaps-link-code.js';

// ── Schema-level validation (no DB) ─────────────────────────────────────────

describe('synapsLinkCodeSchema — validation (no DB)', () => {
  let m;
  let Model;

  beforeAll(() => {
    m = new mongoose.Mongoose();
    m.set('strictQuery', true);
    Model = m.model('SynapsLinkCodeValidation', synapsLinkCodeSchema);
  });

  const validBase = () => ({
    code:           'ABC123',
    pria_user_id:   new mongoose.Types.ObjectId(),
    synaps_user_id: new mongoose.Types.ObjectId(),
    expires_at:     new Date(Date.now() + 5 * 60 * 1000),
  });

  it('requires code', async () => {
    const { code: _omit, ...rest } = validBase();
    const doc = new Model(rest);
    await expect(doc.validate()).rejects.toThrow(/code is required/);
  });

  it('requires pria_user_id', async () => {
    const { pria_user_id: _omit, ...rest } = validBase();
    const doc = new Model(rest);
    await expect(doc.validate()).rejects.toThrow(/pria_user_id is required/);
  });

  it('requires synaps_user_id', async () => {
    const { synaps_user_id: _omit, ...rest } = validBase();
    const doc = new Model(rest);
    await expect(doc.validate()).rejects.toThrow(/synaps_user_id is required/);
  });

  it('requires expires_at', async () => {
    const { expires_at: _omit, ...rest } = validBase();
    const doc = new Model(rest);
    await expect(doc.validate()).rejects.toThrow(/expires_at is required/);
  });

  it('passes validation with all required fields', async () => {
    const doc = new Model(validBase());
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('defaults redeemed_at to null', () => {
    const doc = new Model(validBase());
    expect(doc.redeemed_at).toBeNull();
  });

  it('defaults created_at to a Date', () => {
    const doc = new Model(validBase());
    expect(doc.created_at).toBeInstanceOf(Date);
  });

  it('accepts redeemed_by sub-document', async () => {
    const doc = new Model({
      ...validBase(),
      redeemed_at: new Date(),
      redeemed_by: {
        channel:          'slack',
        external_id:      'U123',
        external_team_id: 'T456',
      },
    });
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.redeemed_by.channel).toBe('slack');
    expect(doc.redeemed_by.external_id).toBe('U123');
    expect(doc.redeemed_by.external_team_id).toBe('T456');
  });

  it('accepts partial redeemed_by sub-document (all fields optional)', async () => {
    const doc = new Model({
      ...validBase(),
      redeemed_by: { channel: 'web' },
    });
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.redeemed_by.channel).toBe('web');
    expect(doc.redeemed_by.external_id).toBeUndefined();
  });
});

// ── Index definitions (no DB) ────────────────────────────────────────────────

describe('synapsLinkCodeSchema — indexes (no DB)', () => {
  it('declares a unique index on code', () => {
    const indexes = synapsLinkCodeSchema.indexes();
    const entry = indexes.find(
      ([fields, opts]) => fields.code === 1 && opts.unique === true,
    );
    expect(entry).toBeDefined();
  });

  it('declares a TTL index on expires_at with expireAfterSeconds: 0', () => {
    const indexes = synapsLinkCodeSchema.indexes();
    const entry = indexes.find(
      ([fields, opts]) =>
        fields.expires_at === 1 && opts.expireAfterSeconds === 0,
    );
    expect(entry).toBeDefined();
  });
});

// ── Round-trip tests (in-memory MongoDB) ────────────────────────────────────

describe('SynapsLinkCode model — round-trip (in-memory DB)', () => {
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
    Model = getSynapsLinkCodeModel(m);
  }, 120_000);

  afterAll(async () => {
    await m.disconnect();
    await mongod.stop();
  });

  it('creates a document and fetches it back', async () => {
    const priaId    = new mongoose.Types.ObjectId();
    const synapsId  = new mongoose.Types.ObjectId();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const created = await Model.create({
      code:           'XYZ789',
      pria_user_id:   priaId,
      synaps_user_id: synapsId,
      expires_at:     expiresAt,
    });
    expect(created._id).toBeDefined();
    expect(created.redeemed_at).toBeNull();

    const fetched = await Model.findById(created._id).lean();
    expect(fetched).not.toBeNull();
    expect(fetched.code).toBe('XYZ789');
  });

  it('enforces unique index on code', async () => {
    const base = {
      pria_user_id:   new mongoose.Types.ObjectId(),
      synaps_user_id: new mongoose.Types.ObjectId(),
      expires_at:     new Date(Date.now() + 60_000),
    };
    await Model.create({ ...base, code: 'DUPCO1' });
    await expect(
      Model.create({ ...base, code: 'DUPCO1' }),
    ).rejects.toThrow();
  });

  it('stores and retrieves redeemed_by sub-document', async () => {
    const doc = await Model.create({
      code:           'RDM001',
      pria_user_id:   new mongoose.Types.ObjectId(),
      synaps_user_id: new mongoose.Types.ObjectId(),
      expires_at:     new Date(Date.now() + 60_000),
      redeemed_at:    new Date(),
      redeemed_by:    { channel: 'slack', external_id: 'U777', external_team_id: 'T888' },
    });
    const fetched = await Model.findById(doc._id).lean();
    expect(fetched.redeemed_by.channel).toBe('slack');
    expect(fetched.redeemed_by.external_id).toBe('U777');
    expect(fetched.redeemed_by.external_team_id).toBe('T888');
  });

  it('getSynapsLinkCodeModel returns the same model when called twice', () => {
    const m1 = getSynapsLinkCodeModel(m);
    const m2 = getSynapsLinkCodeModel(m);
    expect(m1).toBe(m2);
  });
});
