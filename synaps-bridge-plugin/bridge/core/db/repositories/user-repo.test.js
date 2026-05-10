/**
 * @file bridge/core/db/repositories/user-repo.test.js
 *
 * Tests for UserRepo.
 *
 * Uses mongodb-memory-server for an in-process MongoDB instance.
 * Inline schema mirrors the SynapsUser contract so these tests run
 * independently of Wave A1's model files.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { UserRepo } from './user-repo.js';

// ── Silence default logger ────────────────────────────────────────────────────

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ── Module-level fixtures ─────────────────────────────────────────────────────

let mongod;
let m;
let Model;
let repo;

// ── Inline schema (mirrors PLATFORM.SPEC.md § 3.2 synaps_user) ───────────────

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5000,
    autoIndex: true,
  });

  const userSchema = new Schema(
    {
      pria_user_id:     { type: Schema.Types.ObjectId, required: true, unique: true },
      institution_id:   { type: Schema.Types.ObjectId },
      display_name:     String,
      workspace_id:     Schema.Types.ObjectId,
      memory_namespace: { type: String, required: true },
      default_channel:  { type: String, default: 'web' },
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
  );

  Model = m.model('SynapsUser_test', userSchema);
  repo  = new UserRepo({ model: Model, logger: silentLogger });
}, 120_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

// ── create() ──────────────────────────────────────────────────────────────────

describe('UserRepo.create()', () => {
  it('returns a doc with all supplied fields', async () => {
    const priaId   = new m.Types.ObjectId();
    const instId   = new m.Types.ObjectId();
    const doc = await repo.create({
      pria_user_id:    priaId,
      institution_id:  instId,
      display_name:    'Alice',
      default_channel: 'slack',
    });

    expect(doc._id).toBeDefined();
    expect(String(doc.pria_user_id)).toBe(String(priaId));
    expect(String(doc.institution_id)).toBe(String(instId));
    expect(doc.display_name).toBe('Alice');
    expect(doc.default_channel).toBe('slack');
  });

  it('memory_namespace matches ^u_[a-f0-9]{24}$ and equals u_<_id>', async () => {
    const priaId = new m.Types.ObjectId();
    const doc    = await repo.create({ pria_user_id: priaId, display_name: 'Bob' });

    expect(doc.memory_namespace).toMatch(/^u_[a-f0-9]{24}$/);
    expect(doc.memory_namespace).toBe(`u_${doc._id.toString()}`);
  });

  it('defaults default_channel to "web" when omitted', async () => {
    const doc = await repo.create({ pria_user_id: new m.Types.ObjectId() });
    expect(doc.default_channel).toBe('web');
  });

  it('throws on duplicate pria_user_id', async () => {
    const priaId = new m.Types.ObjectId();
    await repo.create({ pria_user_id: priaId });
    await expect(repo.create({ pria_user_id: priaId })).rejects.toThrow();
  });
});

// ── findByPriaUserId() ────────────────────────────────────────────────────────

describe('UserRepo.findByPriaUserId()', () => {
  it('returns the doc for a known pria_user_id', async () => {
    const priaId = new m.Types.ObjectId();
    await repo.create({ pria_user_id: priaId, display_name: 'Carol' });

    const found = await repo.findByPriaUserId(priaId);
    expect(found).not.toBeNull();
    expect(String(found.pria_user_id)).toBe(String(priaId));
    expect(found.display_name).toBe('Carol');
  });

  it('returns null for an unknown pria_user_id', async () => {
    const result = await repo.findByPriaUserId(new m.Types.ObjectId());
    expect(result).toBeNull();
  });
});

// ── findById() ────────────────────────────────────────────────────────────────

describe('UserRepo.findById()', () => {
  it('returns the doc for a known _id', async () => {
    const priaId = new m.Types.ObjectId();
    const created = await repo.create({ pria_user_id: priaId });

    const found = await repo.findById(created._id);
    expect(found).not.toBeNull();
    expect(String(found._id)).toBe(String(created._id));
  });

  it('returns null for a missing _id', async () => {
    const result = await repo.findById(new m.Types.ObjectId());
    expect(result).toBeNull();
  });
});

// ── ensure() ─────────────────────────────────────────────────────────────────

describe('UserRepo.ensure()', () => {
  it('creates a new user and returns isNew: true on first call', async () => {
    const priaId = new m.Types.ObjectId();
    const { doc, isNew } = await repo.ensure({
      pria_user_id: priaId,
      display_name: 'Dave',
    });

    expect(isNew).toBe(true);
    expect(doc._id).toBeDefined();
    expect(String(doc.pria_user_id)).toBe(String(priaId));
  });

  it('returns existing user and isNew: false on second call', async () => {
    const priaId = new m.Types.ObjectId();
    const { doc: first } = await repo.ensure({ pria_user_id: priaId, display_name: 'Eve' });

    const { doc: second, isNew } = await repo.ensure({ pria_user_id: priaId, display_name: 'Eve2' });

    expect(isNew).toBe(false);
    expect(String(second._id)).toBe(String(first._id));
    // display_name should NOT be updated (it returned the existing doc)
    expect(second.display_name).toBe('Eve');
  });

  it('returned doc from ensure() has valid memory_namespace', async () => {
    const { doc } = await repo.ensure({ pria_user_id: new m.Types.ObjectId() });
    expect(doc.memory_namespace).toMatch(/^u_[a-f0-9]{24}$/);
  });
});

// ── setWorkspaceId() ──────────────────────────────────────────────────────────

describe('UserRepo.setWorkspaceId()', () => {
  it('updates the workspace_id and returns the updated doc', async () => {
    const priaId  = new m.Types.ObjectId();
    const wsId    = new m.Types.ObjectId();
    const created = await repo.create({ pria_user_id: priaId });

    const updated = await repo.setWorkspaceId(created._id, wsId);
    expect(updated).not.toBeNull();
    expect(String(updated.workspace_id)).toBe(String(wsId));
  });

  it('returns null for an unknown user id', async () => {
    const result = await repo.setWorkspaceId(new m.Types.ObjectId(), new m.Types.ObjectId());
    expect(result).toBeNull();
  });
});

// ── Logger is invoked on errors ───────────────────────────────────────────────

describe('UserRepo logger', () => {
  it('logs an error when create() throws a non-duplicate error', async () => {
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const brokenModel = {
      base: m,
      create: vi.fn().mockRejectedValue(new Error('db exploded')),
    };
    const badRepo = new UserRepo({ model: brokenModel, logger: fakeLogger });

    await expect(badRepo.create({ pria_user_id: new m.Types.ObjectId() })).rejects.toThrow('db exploded');
  });
});
