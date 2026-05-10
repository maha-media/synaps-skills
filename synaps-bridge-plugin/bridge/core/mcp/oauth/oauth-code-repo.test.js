/**
 * @file bridge/core/mcp/oauth/oauth-code-repo.test.js
 *
 * Tests for OauthCodeRepo — the repository wrapper for synaps_oauth_codes.
 *
 * Uses mongodb-memory-server for an in-process MongoDB instance.
 * Pattern mirrors mcp-token-repo.test.js.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getSynapsOauthCodeModel } from '../../db/models/synaps-oauth-code.js';
import { OauthCodeRepo } from './oauth-code-repo.js';

let mongod;
let m;
let Model;
let repo;

// ── helpers ───────────────────────────────────────────────────────────────────

const TTL_MS = 600_000; // 10 min

const newParams = (overrides = {}) => ({
  client_id:      'test-client',
  synaps_user_id: new m.Types.ObjectId(),
  institution_id: new m.Types.ObjectId(),
  redirect_uri:   'http://localhost:3000/callback',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  ttl_ms:         TTL_MS,
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
  repo  = new OauthCodeRepo({ model: Model });
}, 120_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

// ── constructor ───────────────────────────────────────────────────────────────

describe('OauthCodeRepo constructor', () => {
  it('throws if model is missing', () => {
    expect(() => new OauthCodeRepo({})).toThrow(/model is required/);
  });
});

// ── create() ─────────────────────────────────────────────────────────────────

describe('OauthCodeRepo.create()', () => {
  it('returns { code, doc } with a non-empty code string', async () => {
    const result = await repo.create(newParams());
    expect(typeof result.code).toBe('string');
    expect(result.code.length).toBeGreaterThan(0);
    expect(result.doc).toBeDefined();
  });

  it('generates a base64url-safe code (no +, /, = characters)', async () => {
    const { code } = await repo.create(newParams());
    expect(code).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('persists all supplied fields in the database', async () => {
    const uid  = new m.Types.ObjectId();
    const inst = new m.Types.ObjectId();
    const { code } = await repo.create(newParams({
      client_id:      'client-abc',
      synaps_user_id: uid,
      institution_id: inst,
      redirect_uri:   'https://example.com/cb',
      scope:          'openid profile',
      ttl_ms:         60_000,
    }));

    const stored = await Model.findOne({ code }).lean();
    expect(stored.client_id).toBe('client-abc');
    expect(String(stored.synaps_user_id)).toBe(String(uid));
    expect(String(stored.institution_id)).toBe(String(inst));
    expect(stored.redirect_uri).toBe('https://example.com/cb');
    expect(stored.scope).toBe('openid profile');
    expect(stored.redeemed_at).toBeNull();
    expect(stored.expires_at).toBeInstanceOf(Date);
  });

  it('sets expires_at = now + ttl_ms', async () => {
    const now = Date.now();
    const ttl = 60_000;
    const fakeNow = () => now;
    const r = new OauthCodeRepo({ model: Model, clock: fakeNow });
    const { code } = await r.create(newParams({ ttl_ms: ttl }));

    const stored = await Model.findOne({ code }).lean();
    expect(stored.expires_at.getTime()).toBe(now + ttl);
  });
});

// ── findActive() ──────────────────────────────────────────────────────────────

describe('OauthCodeRepo.findActive()', () => {
  it('returns the doc for an unredeemed, unexpired code', async () => {
    const { code } = await repo.create(newParams());
    const doc = await repo.findActive(code);
    expect(doc).not.toBeNull();
    expect(doc.code).toBe(code);
  });

  it('returns null for an unknown code', async () => {
    const doc = await repo.findActive('does-not-exist');
    expect(doc).toBeNull();
  });

  it('returns null for an expired code', async () => {
    const pastClock = () => Date.now() - 700_000; // code was created 700s ago → expired
    const pastRepo  = new OauthCodeRepo({ model: Model, clock: pastClock });
    const { code }  = await pastRepo.create(newParams({ ttl_ms: 600_000 }));

    // findActive uses current real time, which is after the (fake past) expiry
    const doc = await repo.findActive(code);
    expect(doc).toBeNull();
  });

  it('returns null for a redeemed code', async () => {
    const { code } = await repo.create(newParams());
    await repo.redeem(code);

    const doc = await repo.findActive(code);
    expect(doc).toBeNull();
  });
});

// ── redeem() ──────────────────────────────────────────────────────────────────

describe('OauthCodeRepo.redeem()', () => {
  it('returns the updated doc with redeemed_at set', async () => {
    const { code } = await repo.create(newParams());
    const doc = await repo.redeem(code);

    expect(doc).not.toBeNull();
    expect(doc.code).toBe(code);
    expect(doc.redeemed_at).toBeInstanceOf(Date);
  });

  it('sets redeemed_at to approximately now', async () => {
    const before   = Date.now();
    const { code } = await repo.create(newParams());
    const doc      = await repo.redeem(code);
    const after    = Date.now();

    expect(doc.redeemed_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(doc.redeemed_at.getTime()).toBeLessThanOrEqual(after);
  });

  it('returns null when code does not exist', async () => {
    const doc = await repo.redeem('nonexistent-code-xyz');
    expect(doc).toBeNull();
  });

  it('returns null on replay — second redeem of same code returns null', async () => {
    const { code } = await repo.create(newParams());
    const first    = await repo.redeem(code);
    expect(first).not.toBeNull();

    const second = await repo.redeem(code);
    expect(second).toBeNull();
  });
});
