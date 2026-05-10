/**
 * @file bridge/core/db/models/synaps-mcp-tool-acl.test.js
 *
 * Schema validation and index tests for the SynapsMcpToolAcl model.
 *
 * Schema-level validation tests do not require a live DB connection.
 * Index enforcement tests use mongodb-memory-server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { synapsMcpToolAclSchema, getSynapsMcpToolAclModel } from './synaps-mcp-tool-acl.js';

// ── Schema-level validation (no DB) ──────────────────────────────────────────

describe('synapsMcpToolAclSchema — validation (no DB)', () => {
  let m;
  let Model;

  beforeAll(() => {
    m = new mongoose.Mongoose();
    m.set('strictQuery', true);
    Model = m.model('SynapsMcpToolAclValidation', synapsMcpToolAclSchema);
  });

  const validBase = () => ({
    synaps_user_id: new mongoose.Types.ObjectId(),
    tool_name:      'web_fetch',
    policy:         'allow',
  });

  it('schema compiles and required fields are enforced', async () => {
    // Valid doc passes
    const doc = new Model(validBase());
    await expect(doc.validate()).resolves.toBeUndefined();

    // Missing synaps_user_id
    const { synaps_user_id: _u, ...noUser } = validBase();
    await expect(new Model(noUser).validate()).rejects.toThrow(/synaps_user_id is required/);

    // Missing tool_name
    const { tool_name: _t, ...noTool } = validBase();
    await expect(new Model(noTool).validate()).rejects.toThrow(/tool_name is required/);

    // Missing policy
    const { policy: _p, ...noPolicy } = validBase();
    await expect(new Model(noPolicy).validate()).rejects.toThrow(/policy is required/);
  });

  it('enum on policy rejects invalid values', async () => {
    const doc = new Model({ ...validBase(), policy: 'maybe' });
    await expect(doc.validate()).rejects.toThrow(/policy must be one of: allow, deny/);
  });

  it('defaults: reason="", expires_at=null, created_at≈now', () => {
    const before = Date.now();
    const doc    = new Model(validBase());
    const after  = Date.now();

    expect(doc.reason).toBe('');
    expect(doc.expires_at).toBeNull();
    expect(doc.created_at).toBeInstanceOf(Date);
    expect(doc.created_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(doc.created_at.getTime()).toBeLessThanOrEqual(after);
  });
});

// ── Index definitions (no DB) ─────────────────────────────────────────────────

describe('synapsMcpToolAclSchema — compound unique index (no DB)', () => {
  it('declares compound unique index on { synaps_user_id, tool_name }', () => {
    const indexes = synapsMcpToolAclSchema.indexes();
    const entry   = indexes.find(([fields, opts]) =>
      fields.synaps_user_id === 1 &&
      fields.tool_name === 1 &&
      opts.unique === true,
    );
    expect(entry).toBeDefined();
  });

  it('declares sparse TTL index on expires_at', () => {
    const indexes = synapsMcpToolAclSchema.indexes();
    const entry   = indexes.find(([fields, opts]) =>
      fields.expires_at === 1 &&
      opts.expireAfterSeconds === 0 &&
      opts.sparse === true,
    );
    expect(entry).toBeDefined();
  });
});

// ── Round-trip + index enforcement (in-memory MongoDB) ───────────────────────

describe('SynapsMcpToolAcl model — compound unique index enforcement (in-memory DB)', () => {
  let mongod;
  let m;
  let Model;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    m      = new mongoose.Mongoose();
    m.set('strictQuery', true);
    await m.connect(mongod.getUri(), {
      serverSelectionTimeoutMS: 5000,
      autoIndex: true,
    });
    Model = getSynapsMcpToolAclModel(m);
    // Ensure indexes are fully built before any write tests run.
    await Model.ensureIndexes();
  }, 120_000);

  afterAll(async () => {
    await m.disconnect();
    await mongod.stop();
  });

  it('rejects duplicate (synaps_user_id, tool_name) with a duplicate-key error', async () => {
    const userId = new mongoose.Types.ObjectId();

    await Model.create({ synaps_user_id: userId, tool_name: 'web_fetch', policy: 'allow' });

    await expect(
      Model.create({ synaps_user_id: userId, tool_name: 'web_fetch', policy: 'deny' }),
    ).rejects.toThrow();
  });

  it('allows same tool_name for different users', async () => {
    const user1 = new mongoose.Types.ObjectId();
    const user2 = new mongoose.Types.ObjectId();

    await Model.create({ synaps_user_id: user1, tool_name: 'synaps_chat', policy: 'deny' });
    await expect(
      Model.create({ synaps_user_id: user2, tool_name: 'synaps_chat', policy: 'allow' }),
    ).resolves.toBeDefined();
  });

  it('getSynapsMcpToolAclModel returns the same model when called twice', () => {
    const m1 = getSynapsMcpToolAclModel(m);
    const m2 = getSynapsMcpToolAclModel(m);
    expect(m1).toBe(m2);
  });
});
