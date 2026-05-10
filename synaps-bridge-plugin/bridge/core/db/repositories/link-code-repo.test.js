/**
 * @file bridge/core/db/repositories/link-code-repo.test.js
 *
 * Tests for LinkCodeRepo.
 *
 * Uses mongodb-memory-server for an in-process MongoDB instance.
 * Inline schema mirrors the SynapsLinkCode contract so these tests run
 * independently of Wave A1's model files.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { LinkCodeRepo } from './link-code-repo.js';

// ── Silence default logger ────────────────────────────────────────────────────

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ── Module-level fixtures ─────────────────────────────────────────────────────

let mongod;
let m;
let Model;
let repo;

// ── Inline schema (mirrors PLATFORM.SPEC.md § 14.1 synaps_link_code) ─────────

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5000,
    autoIndex: true,
  });

  const linkCodeSchema = new Schema(
    {
      code:          { type: String, required: true, unique: true },
      pria_user_id:  { type: Schema.Types.ObjectId, required: true },
      synaps_user_id:{ type: Schema.Types.ObjectId, required: true },
      expires_at:    { type: Date, required: true },
      redeemed_at:   { type: Date, default: null },
      redeemed_by:   {
        channel:          String,
        external_id:      String,
        external_team_id: String,
      },
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
  );

  // TTL index + unique code index.
  linkCodeSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

  Model = m.model('SynapsLinkCode_test', linkCodeSchema);
  repo  = new LinkCodeRepo({ model: Model, logger: silentLogger });
}, 120_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

// ── _generateCode() ───────────────────────────────────────────────────────────

describe('LinkCodeRepo._generateCode()', () => {
  it('produces a 6-character string', () => {
    const code = repo._generateCode();
    expect(code).toHaveLength(6);
  });

  it('only contains safe alphabet characters (no I/O/0/1)', () => {
    for (let i = 0; i < 200; i++) {
      const code = repo._generateCode();
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });
});

// ── issue() ───────────────────────────────────────────────────────────────────

describe('LinkCodeRepo.issue()', () => {
  it('returns { doc, code } with a 6-char code', async () => {
    const { doc, code } = await repo.issue({
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      ttl_ms:         300_000,
    });

    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(doc._id).toBeDefined();
    expect(doc.code).toBe(code);
  });

  it('stores expires_at in the future', async () => {
    const before = Date.now();
    const { doc } = await repo.issue({
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      ttl_ms:         60_000,
    });
    const after = Date.now();

    expect(doc.expires_at.getTime()).toBeGreaterThan(before);
    expect(doc.expires_at.getTime()).toBeLessThanOrEqual(after + 60_000);
  });

  it('redeemed_at is null on a fresh code', async () => {
    const { doc } = await repo.issue({
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      ttl_ms:         300_000,
    });
    expect(doc.redeemed_at).toBeNull();
  });

  it('retries on duplicate-key collision and eventually succeeds', async () => {
    // Intercept _generateCode so the first 2 calls return a colliding code,
    // then return a unique one.
    const priaId   = new m.Types.ObjectId();
    const synapsId = new m.Types.ObjectId();

    // Pre-insert the "colliding" code.
    const collidingCode = 'AAAAA1'; // won't collide with a real code in practice

    // Temporarily override with a deterministic sequence.
    const originalGenerate = repo._generateCode.bind(repo);
    let callCount = 0;
    repo._generateCode = () => {
      callCount++;
      if (callCount <= 2) return collidingCode;
      return originalGenerate();
    };

    await Model.create({
      code:           collidingCode,
      pria_user_id:   priaId,
      synaps_user_id: synapsId,
      expires_at:     new Date(Date.now() + 300_000),
    });

    const loggerWithWarn = { info: () => {}, warn: vi.fn(), error: () => {} };
    const retryRepo = new LinkCodeRepo({ model: Model, logger: loggerWithWarn });
    retryRepo._generateCode = repo._generateCode;

    const { doc, code } = await retryRepo.issue({ pria_user_id: priaId, synaps_user_id: synapsId, ttl_ms: 300_000 });

    expect(code).not.toBe(collidingCode);
    expect(doc.code).toBe(code);
    expect(loggerWithWarn.warn).toHaveBeenCalled();

    // Restore
    repo._generateCode = originalGenerate;
  });
});

// ── findActiveByCode() ────────────────────────────────────────────────────────

describe('LinkCodeRepo.findActiveByCode()', () => {
  it('returns a valid non-redeemed non-expired code', async () => {
    const { code } = await repo.issue({
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      ttl_ms:         300_000,
    });

    const found = await repo.findActiveByCode(code);
    expect(found).not.toBeNull();
    expect(found.code).toBe(code);
  });

  it('returns null for an unknown code', async () => {
    const result = await repo.findActiveByCode('XXXXXX');
    expect(result).toBeNull();
  });

  it('returns null for an expired code', async () => {
    const priaId   = new m.Types.ObjectId();
    const synapsId = new m.Types.ObjectId();
    const code     = 'EXPIR1';

    await Model.create({
      code,
      pria_user_id:   priaId,
      synaps_user_id: synapsId,
      expires_at:     new Date(Date.now() - 1_000), // already expired
    });

    const result = await repo.findActiveByCode(code);
    expect(result).toBeNull();
  });

  it('returns null for a redeemed code', async () => {
    const { code } = await repo.issue({
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      ttl_ms:         300_000,
    });

    await repo.redeem({
      code,
      redeemed_by: { channel: 'slack', external_id: 'U1', external_team_id: 'T1' },
    });

    const result = await repo.findActiveByCode(code);
    expect(result).toBeNull();
  });
});

// ── redeem() ─────────────────────────────────────────────────────────────────

describe('LinkCodeRepo.redeem()', () => {
  it('happy path — returns ok: true and sets redeemed_at', async () => {
    const { code } = await repo.issue({
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      ttl_ms:         300_000,
    });

    const result = await repo.redeem({
      code,
      redeemed_by: { channel: 'slack', external_id: 'U1', external_team_id: 'T1' },
    });

    expect(result.ok).toBe(true);
    expect(result.doc.redeemed_at).toBeInstanceOf(Date);
    expect(result.doc.redeemed_by.channel).toBe('slack');
    expect(result.doc.redeemed_by.external_id).toBe('U1');
  });

  it('second redeem of same code returns already_redeemed', async () => {
    const { code } = await repo.issue({
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      ttl_ms:         300_000,
    });

    await repo.redeem({
      code,
      redeemed_by: { channel: 'slack', external_id: 'U1', external_team_id: 'T1' },
    });

    const second = await repo.redeem({
      code,
      redeemed_by: { channel: 'slack', external_id: 'U1', external_team_id: 'T1' },
    });

    expect(second.ok).toBe(false);
    expect(second.reason).toBe('already_redeemed');
  });

  it('returns unknown for a code that does not exist', async () => {
    const result = await repo.redeem({
      code:        'NOSUCH',
      redeemed_by: { channel: 'slack', external_id: 'U1', external_team_id: 'T1' },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown');
  });

  it('returns expired for a code past its expires_at', async () => {
    const priaId   = new m.Types.ObjectId();
    const synapsId = new m.Types.ObjectId();
    const code     = 'EXPRRD';

    await Model.create({
      code,
      pria_user_id:   priaId,
      synaps_user_id: synapsId,
      expires_at:     new Date(Date.now() - 1_000), // already expired
    });

    const result = await repo.redeem({
      code,
      redeemed_by: { channel: 'slack', external_id: 'U1', external_team_id: 'T1' },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });
});

// ── Logger is invoked appropriately ──────────────────────────────────────────

describe('LinkCodeRepo logger', () => {
  it('calls logger.info on successful issue()', async () => {
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const loggingRepo = new LinkCodeRepo({ model: Model, logger: fakeLogger });

    await loggingRepo.issue({
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      ttl_ms:         300_000,
    });

    expect(fakeLogger.info).toHaveBeenCalledWith(
      expect.stringMatching(/\[LinkCodeRepo\] Issued code/),
    );
  });

  it('calls logger.info on successful redeem()', async () => {
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const loggingRepo = new LinkCodeRepo({ model: Model, logger: fakeLogger });

    const { code } = await loggingRepo.issue({
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      ttl_ms:         300_000,
    });

    await loggingRepo.redeem({
      code,
      redeemed_by: { channel: 'slack', external_id: 'U1', external_team_id: 'T1' },
    });

    expect(fakeLogger.info).toHaveBeenCalledWith(
      expect.stringMatching(/\[LinkCodeRepo\] Redeemed code/),
    );
  });

  it('calls logger.error when issue() encounters a non-duplicate error', async () => {
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const brokenModel = {
      create: vi.fn().mockRejectedValue(new Error('network timeout')),
    };
    const badRepo = new LinkCodeRepo({ model: brokenModel, logger: fakeLogger });

    await expect(
      badRepo.issue({ pria_user_id: new m.Types.ObjectId(), synaps_user_id: new m.Types.ObjectId(), ttl_ms: 300_000 }),
    ).rejects.toThrow('network timeout');

    expect(fakeLogger.error).toHaveBeenCalledWith(
      '[LinkCodeRepo] issue() error:',
      'network timeout',
    );
  });
});

// ── IdentityRouter aliases ────────────────────────────────────────────────────

describe('LinkCodeRepo.findByCode() — IdentityRouter alias', () => {
  it('returns a fresh (non-expired, non-redeemed) code', async () => {
    const { code } = await repo.issue({
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      ttl_ms:         300_000,
    });

    const found = await repo.findByCode(code);
    expect(found).not.toBeNull();
    expect(found.code).toBe(code);
  });

  it('returns an EXPIRED code (unlike findActiveByCode which would return null)', async () => {
    const priaId   = new m.Types.ObjectId();
    const synapsId = new m.Types.ObjectId();
    const code     = 'EXPIRY1';

    await Model.create({
      code,
      pria_user_id:   priaId,
      synaps_user_id: synapsId,
      expires_at:     new Date(Date.now() - 5_000), // already expired
    });

    // findActiveByCode would return null here — findByCode must return the doc.
    const fromActive = await repo.findActiveByCode(code);
    expect(fromActive).toBeNull();

    const fromAlias = await repo.findByCode(code);
    expect(fromAlias).not.toBeNull();
    expect(fromAlias.code).toBe(code);
  });

  it('returns a REDEEMED code (unlike findActiveByCode which would return null)', async () => {
    const { code } = await repo.issue({
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      ttl_ms:         300_000,
    });

    await repo.redeem({
      code,
      redeemed_by: { channel: 'slack', external_id: 'U_RED', external_team_id: 'T_RED' },
    });

    const fromActive = await repo.findActiveByCode(code);
    expect(fromActive).toBeNull();

    const fromAlias = await repo.findByCode(code);
    expect(fromAlias).not.toBeNull();
    expect(fromAlias.redeemed_at).toBeInstanceOf(Date);
  });

  it('returns null for an unknown code', async () => {
    const result = await repo.findByCode('NOSUCH');
    expect(result).toBeNull();
  });
});

describe('LinkCodeRepo.create() — IdentityRouter alias', () => {
  it('inserts a document with the caller-supplied code (no auto-generation)', async () => {
    const priaId   = new m.Types.ObjectId();
    const synapsId = new m.Types.ObjectId();
    const code     = 'PRESET';
    const expiresAt = new Date(Date.now() + 300_000);

    const doc = await repo.create({ code, pria_user_id: priaId, synaps_user_id: synapsId, expires_at: expiresAt });

    expect(doc).not.toBeNull();
    expect(doc.code).toBe(code);
    expect(String(doc.pria_user_id)).toBe(String(priaId));
    expect(String(doc.synaps_user_id)).toBe(String(synapsId));
    expect(doc.redeemed_at).toBeNull();
  });

  it('doc is retrievable via findByCode after create()', async () => {
    const code = 'FETCH1';
    await repo.create({
      code,
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      expires_at:     new Date(Date.now() + 300_000),
    });

    const found = await repo.findByCode(code);
    expect(found).not.toBeNull();
    expect(found.code).toBe(code);
  });

  it('calls logger.info with create alias message', async () => {
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const loggingRepo = new LinkCodeRepo({ model: Model, logger: fakeLogger });

    const code = 'LOGME1';
    await loggingRepo.create({
      code,
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      expires_at:     new Date(Date.now() + 300_000),
    });

    expect(fakeLogger.info).toHaveBeenCalledWith(
      expect.stringMatching(/\[LinkCodeRepo\] Created code LOGME1/),
    );
  });
});

describe('LinkCodeRepo.markRedeemed() — IdentityRouter alias', () => {
  it('sets redeemed_at and redeemed_by on the document', async () => {
    const { code } = await repo.issue({
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      ttl_ms:         300_000,
    });

    const updated = await repo.markRedeemed(code, {
      redeemed_by: { channel: 'slack', external_id: 'U_MR', external_team_id: 'T_MR' },
    });

    expect(updated).not.toBeNull();
    expect(updated.redeemed_at).toBeInstanceOf(Date);
    expect(updated.redeemed_by.channel).toBe('slack');
    expect(updated.redeemed_by.external_id).toBe('U_MR');
    expect(updated.redeemed_by.external_team_id).toBe('T_MR');
  });

  it('returns null when the code does not exist', async () => {
    const result = await repo.markRedeemed('NOSUCH', {
      redeemed_by: { channel: 'slack', external_id: 'X', external_team_id: '' },
    });
    expect(result).toBeNull();
  });

  it('updated doc is reflected in subsequent findByCode call', async () => {
    const { code } = await repo.issue({
      pria_user_id:   new m.Types.ObjectId(),
      synaps_user_id: new m.Types.ObjectId(),
      ttl_ms:         300_000,
    });

    await repo.markRedeemed(code, {
      redeemed_by: { channel: 'web', external_id: 'W_CHECK', external_team_id: '' },
    });

    const fetched = await repo.findByCode(code);
    expect(fetched.redeemed_at).toBeInstanceOf(Date);
    expect(fetched.redeemed_by.external_id).toBe('W_CHECK');
  });
});

