/**
 * @file bridge/core/db/repositories/mcp-tool-acl-repo.test.js
 *
 * Tests for McpToolAclRepo.
 *
 * Uses mongodb-memory-server for an in-process MongoDB instance.
 * The SynapsMcpToolAcl model is imported via the factory function.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getSynapsMcpToolAclModel } from '../models/synaps-mcp-tool-acl.js';
import { McpToolAclRepo } from './mcp-tool-acl-repo.js';

// ── Module-level fixtures ─────────────────────────────────────────────────────

let mongod;
let m;
let Model;
let repo;

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m      = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5000,
    autoIndex: true,
  });

  Model = getSynapsMcpToolAclModel(m);
  await Model.ensureIndexes();
  repo  = new McpToolAclRepo({ model: Model });
}, 120_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

// ── Constructor ───────────────────────────────────────────────────────────────

describe('McpToolAclRepo — constructor', () => {
  it('throws TypeError when model is not provided', () => {
    expect(() => new McpToolAclRepo({})).toThrow(TypeError);
    expect(() => new McpToolAclRepo({})).toThrow('McpToolAclRepo: model is required');
  });
});

// ── upsert() ──────────────────────────────────────────────────────────────────

describe('McpToolAclRepo.upsert()', () => {
  it('inserts a new row and returns the document', async () => {
    const userId = new m.Types.ObjectId();
    const doc    = await repo.upsert({
      synaps_user_id: userId,
      tool_name:      'web_fetch',
      policy:         'deny',
      reason:         'test deny',
    });

    expect(doc).toBeDefined();
    expect(doc.tool_name).toBe('web_fetch');
    expect(doc.policy).toBe('deny');
    expect(doc.reason).toBe('test deny');
    expect(String(doc.synaps_user_id)).toBe(String(userId));

    const stored = await Model.findById(doc._id).lean();
    expect(stored).not.toBeNull();
    expect(stored.policy).toBe('deny');
  });

  it('updates an existing row when composite key already exists', async () => {
    const userId = new m.Types.ObjectId();

    // First upsert — creates
    const first = await repo.upsert({
      synaps_user_id: userId,
      tool_name:      'synaps_chat',
      policy:         'allow',
      reason:         'initial',
    });

    // Second upsert — same key, different policy
    const second = await repo.upsert({
      synaps_user_id: userId,
      tool_name:      'synaps_chat',
      policy:         'deny',
      reason:         'updated',
    });

    // IDs must be the same (same document)
    expect(String(second._id)).toBe(String(first._id));
    expect(second.policy).toBe('deny');
    expect(second.reason).toBe('updated');

    // Only one row in the collection
    const count = await Model.countDocuments({ synaps_user_id: userId });
    expect(count).toBe(1);
  });
});

// ── list() ────────────────────────────────────────────────────────────────────

describe('McpToolAclRepo.list()', () => {
  it("returns only that user's rows sorted by tool_name ascending", async () => {
    const user1 = new m.Types.ObjectId();
    const user2 = new m.Types.ObjectId();

    await repo.upsert({ synaps_user_id: user1, tool_name: 'zzz_tool', policy: 'deny' });
    await repo.upsert({ synaps_user_id: user1, tool_name: 'aaa_tool', policy: 'allow' });
    await repo.upsert({ synaps_user_id: user1, tool_name: 'mmm_tool', policy: 'allow' });
    await repo.upsert({ synaps_user_id: user2, tool_name: 'web_fetch', policy: 'deny' });

    const results = await repo.list({ synaps_user_id: user1 });

    expect(results).toHaveLength(3);
    // Sorted by tool_name ascending
    expect(results[0].tool_name).toBe('aaa_tool');
    expect(results[1].tool_name).toBe('mmm_tool');
    expect(results[2].tool_name).toBe('zzz_tool');

    // Does not include user2's rows
    const names = results.map(r => r.tool_name);
    expect(names).not.toContain('web_fetch');
  });
});

// ── findByUserAndTool() ───────────────────────────────────────────────────────

describe('McpToolAclRepo.findByUserAndTool()', () => {
  it('returns null for a miss (no matching row)', async () => {
    const userId = new m.Types.ObjectId();
    const result = await repo.findByUserAndTool({
      synaps_user_id: userId,
      tool_name:      'nonexistent_tool',
    });
    expect(result).toBeNull();
  });

  it('returns the document for a hit', async () => {
    const userId = new m.Types.ObjectId();
    await repo.upsert({ synaps_user_id: userId, tool_name: 'web_fetch', policy: 'allow', reason: 'approved' });

    const result = await repo.findByUserAndTool({
      synaps_user_id: userId,
      tool_name:      'web_fetch',
    });

    expect(result).not.toBeNull();
    expect(result.tool_name).toBe('web_fetch');
    expect(result.policy).toBe('allow');
    expect(result.reason).toBe('approved');
  });
});

// ── findEffective() ───────────────────────────────────────────────────────────

describe('McpToolAclRepo.findEffective()', () => {
  it('prefers exact match over wildcard (exact deny + wildcard allow → exact)', async () => {
    const userId = new m.Types.ObjectId();
    await repo.upsert({ synaps_user_id: userId, tool_name: '*',         policy: 'allow' });
    await repo.upsert({ synaps_user_id: userId, tool_name: 'web_fetch', policy: 'deny' });

    const result = await repo.findEffective({
      synaps_user_id: userId,
      tool_name:      'web_fetch',
    });

    expect(result).not.toBeNull();
    expect(result.tool_name).toBe('web_fetch');  // exact row returned
    expect(result.policy).toBe('deny');
  });

  it('falls back to wildcard when exact is absent', async () => {
    const userId = new m.Types.ObjectId();
    await repo.upsert({ synaps_user_id: userId, tool_name: '*', policy: 'allow' });

    const result = await repo.findEffective({
      synaps_user_id: userId,
      tool_name:      'web_fetch',
    });

    expect(result).not.toBeNull();
    expect(result.tool_name).toBe('*');
    expect(result.policy).toBe('allow');
  });

  it('ignores expired rows (defence in depth alongside TTL)', async () => {
    const userId  = new m.Types.ObjectId();
    const pastExp = new Date(Date.now() - 10_000);

    await repo.upsert({ synaps_user_id: userId, tool_name: 'web_fetch', policy: 'deny', expires_at: pastExp });
    await repo.upsert({ synaps_user_id: userId, tool_name: '*',         policy: 'deny', expires_at: pastExp });

    const result = await repo.findEffective({
      synaps_user_id: userId,
      tool_name:      'web_fetch',
    });

    // Both expired → null
    expect(result).toBeNull();
  });
});

// ── delete() ─────────────────────────────────────────────────────────────────

describe('McpToolAclRepo.delete()', () => {
  it('removes the row and returns {deleted:true}; second delete returns {deleted:false}', async () => {
    const userId = new m.Types.ObjectId();
    await repo.upsert({ synaps_user_id: userId, tool_name: 'web_fetch', policy: 'deny' });

    // First delete
    const first = await repo.delete({ synaps_user_id: userId, tool_name: 'web_fetch' });
    expect(first).toEqual({ deleted: true });

    // Confirm it's gone
    const stored = await Model.findOne({ synaps_user_id: userId, tool_name: 'web_fetch' });
    expect(stored).toBeNull();

    // Second delete — already gone
    const second = await repo.delete({ synaps_user_id: userId, tool_name: 'web_fetch' });
    expect(second).toEqual({ deleted: false });
  });
});
