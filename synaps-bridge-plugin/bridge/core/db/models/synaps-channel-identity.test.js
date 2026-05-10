/**
 * @file bridge/core/db/models/synaps-channel-identity.test.js
 *
 * Schema validation and round-trip tests for the SynapsChannelIdentity model.
 *
 * Schema-level validation tests do not require a live DB connection.
 * Round-trip tests use mongodb-memory-server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  synapsChannelIdentitySchema,
  getSynapsChannelIdentityModel,
} from './synaps-channel-identity.js';

// ── Schema-level validation (no DB) ─────────────────────────────────────────

describe('synapsChannelIdentitySchema — validation (no DB)', () => {
  let m;
  let Model;

  beforeAll(() => {
    m = new mongoose.Mongoose();
    m.set('strictQuery', true);
    Model = m.model('SynapsChannelIdentityValidation', synapsChannelIdentitySchema);
  });

  it('requires synaps_user_id', async () => {
    const doc = new Model({
      channel:     'slack',
      external_id: 'U123',
      link_method: 'oauth',
    });
    await expect(doc.validate()).rejects.toThrow(/synaps_user_id is required/);
  });

  it('requires channel', async () => {
    const doc = new Model({
      synaps_user_id: new mongoose.Types.ObjectId(),
      external_id:    'U123',
      link_method:    'oauth',
    });
    await expect(doc.validate()).rejects.toThrow(/channel is required/);
  });

  it('requires external_id', async () => {
    const doc = new Model({
      synaps_user_id: new mongoose.Types.ObjectId(),
      channel:        'slack',
      link_method:    'oauth',
    });
    await expect(doc.validate()).rejects.toThrow(/external_id is required/);
  });

  it('requires link_method', async () => {
    const doc = new Model({
      synaps_user_id: new mongoose.Types.ObjectId(),
      channel:        'slack',
      external_id:    'U123',
    });
    await expect(doc.validate()).rejects.toThrow(/link_method is required/);
  });

  it('rejects an invalid channel enum value', async () => {
    const doc = new Model({
      synaps_user_id: new mongoose.Types.ObjectId(),
      channel:        'carrier-pigeon',
      external_id:    'U123',
      link_method:    'oauth',
    });
    await expect(doc.validate()).rejects.toThrow(/not a valid channel/);
  });

  it('rejects an invalid link_method enum value', async () => {
    const doc = new Model({
      synaps_user_id: new mongoose.Types.ObjectId(),
      channel:        'slack',
      external_id:    'U123',
      link_method:    'telepathy',
    });
    await expect(doc.validate()).rejects.toThrow(/not a valid link_method/);
  });

  it('accepts all valid channel enum values', async () => {
    const channels = ['slack', 'web', 'discord', 'telegram', 'teams'];
    for (const channel of channels) {
      const doc = new Model({
        synaps_user_id: new mongoose.Types.ObjectId(),
        channel,
        external_id:    'U123',
        link_method:    'oauth',
      });
      await expect(doc.validate()).resolves.toBeUndefined();
    }
  });

  it('accepts all valid link_method enum values', async () => {
    const methods = ['oauth', 'magic_code', 'admin', 'inferred'];
    for (const link_method of methods) {
      const doc = new Model({
        synaps_user_id: new mongoose.Types.ObjectId(),
        channel:        'web',
        external_id:    'U123',
        link_method,
      });
      await expect(doc.validate()).resolves.toBeUndefined();
    }
  });

  it('defaults external_team_id to empty string', () => {
    const doc = new Model({
      synaps_user_id: new mongoose.Types.ObjectId(),
      channel:        'web',
      external_id:    'U123',
      link_method:    'oauth',
    });
    expect(doc.external_team_id).toBe('');
  });

  it('defaults linked_at to a Date', () => {
    const doc = new Model({
      synaps_user_id: new mongoose.Types.ObjectId(),
      channel:        'web',
      external_id:    'U123',
      link_method:    'oauth',
    });
    expect(doc.linked_at).toBeInstanceOf(Date);
  });
});

// ── Index definitions (no DB) ────────────────────────────────────────────────

describe('synapsChannelIdentitySchema — indexes (no DB)', () => {
  it('declares a unique compound index on channel + external_id + external_team_id', () => {
    const indexes = synapsChannelIdentitySchema.indexes();
    const entry = indexes.find(([fields, opts]) =>
      fields.channel === 1 &&
      fields.external_id === 1 &&
      fields.external_team_id === 1 &&
      opts.unique === true,
    );
    expect(entry).toBeDefined();
  });
});

// ── Round-trip tests (in-memory MongoDB) ────────────────────────────────────

describe('SynapsChannelIdentity model — round-trip (in-memory DB)', () => {
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
    Model = getSynapsChannelIdentityModel(m);
  }, 120_000);

  afterAll(async () => {
    await m.disconnect();
    await mongod.stop();
  });

  it('creates a document and fetches it back', async () => {
    const synapsUserId = new mongoose.Types.ObjectId();
    const created = await Model.create({
      synaps_user_id: synapsUserId,
      channel:        'slack',
      external_id:    'U999',
      link_method:    'oauth',
    });
    expect(created._id).toBeDefined();
    expect(created.external_team_id).toBe('');

    const fetched = await Model.findById(created._id).lean();
    expect(fetched).not.toBeNull();
    expect(String(fetched.synaps_user_id)).toBe(String(synapsUserId));
  });

  it('enforces unique compound index (channel + external_id + external_team_id)', async () => {
    const synapsUserId = new mongoose.Types.ObjectId();
    await Model.create({
      synaps_user_id:   synapsUserId,
      channel:          'slack',
      external_id:      'UDUP',
      external_team_id: 'T001',
      link_method:      'oauth',
    });
    await expect(
      Model.create({
        synaps_user_id:   new mongoose.Types.ObjectId(),
        channel:          'slack',
        external_id:      'UDUP',
        external_team_id: 'T001',
        link_method:      'admin',
      }),
    ).rejects.toThrow();
  });

  it('allows same external_id in a different team (compound index boundary)', async () => {
    const uid = new mongoose.Types.ObjectId();
    await Model.create({
      synaps_user_id:   uid,
      channel:          'slack',
      external_id:      'USHARED',
      external_team_id: 'TEAM_A',
      link_method:      'oauth',
    });
    // Different external_team_id → must NOT throw.
    await expect(
      Model.create({
        synaps_user_id:   new mongoose.Types.ObjectId(),
        channel:          'slack',
        external_id:      'USHARED',
        external_team_id: 'TEAM_B',
        link_method:      'oauth',
      }),
    ).resolves.toBeDefined();
  });

  it('getSynapsChannelIdentityModel returns the same model when called twice', () => {
    const m1 = getSynapsChannelIdentityModel(m);
    const m2 = getSynapsChannelIdentityModel(m);
    expect(m1).toBe(m2);
  });
});
