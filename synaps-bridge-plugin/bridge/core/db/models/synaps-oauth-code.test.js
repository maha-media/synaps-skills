/**
 * @file bridge/core/db/models/synaps-oauth-code.test.js
 *
 * Tests for synapsOauthCodeSchema + getSynapsOauthCodeModel.
 *
 * Uses mongodb-memory-server for an in-process MongoDB instance so we can
 * verify schema constraints and index creation without a real server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { synapsOauthCodeSchema, getSynapsOauthCodeModel } from './synaps-oauth-code.js';

let mongod;
let m;
let Model;

// ── helpers ───────────────────────────────────────────────────────────────────

const newCode = (overrides = {}) => ({
  code:            'abc123def456ghij78901234567890ab',
  client_id:       'my-client',
  synaps_user_id:  new m.Types.ObjectId(),
  institution_id:  new m.Types.ObjectId(),
  redirect_uri:    'http://localhost:3000/callback',
  code_challenge:  'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  expires_at:      new Date(Date.now() + 600_000),
  ...overrides,
});

// ── setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5000,
    autoIndex: true,
  });
  Model = getSynapsOauthCodeModel(m);
}, 120_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

// ── Schema shape ──────────────────────────────────────────────────────────────

describe('synapsOauthCodeSchema — field defaults and validation', () => {
  it('creates a document with required fields and correct defaults', async () => {
    const doc = await Model.create(newCode());

    expect(doc.code).toBe('abc123def456ghij78901234567890ab');
    expect(doc.client_id).toBe('my-client');
    expect(doc.code_challenge_method).toBe('S256'); // default
    expect(doc.scope).toBe('');                      // default
    expect(doc.redeemed_at).toBeNull();              // default
    expect(doc.created_at).toBeInstanceOf(Date);
    expect(doc.expires_at).toBeInstanceOf(Date);
  });

  it('rejects a document missing required fields', async () => {
    await expect(Model.create({ client_id: 'x' })).rejects.toThrow();
  });

  it('rejects code_challenge_method values other than S256', async () => {
    await expect(
      Model.create(newCode({ code_challenge_method: 'plain' })),
    ).rejects.toThrow();
  });
});

// ── Factory ───────────────────────────────────────────────────────────────────

describe('getSynapsOauthCodeModel()', () => {
  it('returns the same model when called twice on the same mongoose instance', () => {
    const m1 = getSynapsOauthCodeModel(m);
    const m2 = getSynapsOauthCodeModel(m);
    expect(m1).toBe(m2);
  });

  it('returns a different model for a different mongoose instance', async () => {
    const m2 = new mongoose.Mongoose();
    m2.set('strictQuery', true);
    await m2.connect(mongod.getUri(), { serverSelectionTimeoutMS: 5000 });
    try {
      const model2 = getSynapsOauthCodeModel(m2);
      expect(model2).not.toBe(Model);
    } finally {
      await m2.disconnect();
    }
  });
});

// ── Collection name ───────────────────────────────────────────────────────────

describe('collection name', () => {
  it('uses the synaps_oauth_codes collection', () => {
    expect(Model.collection.name).toBe('synaps_oauth_codes');
  });
});
