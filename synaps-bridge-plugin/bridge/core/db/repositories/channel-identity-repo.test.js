/**
 * @file bridge/core/db/repositories/channel-identity-repo.test.js
 *
 * Tests for ChannelIdentityRepo.
 *
 * Uses mongodb-memory-server for an in-process MongoDB instance.
 * Inline schema mirrors the SynapsChannelIdentity contract so these tests
 * run independently of Wave A1's model files.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ChannelIdentityRepo } from './channel-identity-repo.js';

// ── Silence default logger ────────────────────────────────────────────────────

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ── Module-level fixtures ─────────────────────────────────────────────────────

let mongod;
let m;
let Model;
let repo;

// ── Inline schema (mirrors PLATFORM.SPEC.md § 3.2 synaps_channel_identity) ───

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5000,
    autoIndex: true,
  });

  const channelIdentitySchema = new Schema(
    {
      synaps_user_id:   { type: Schema.Types.ObjectId, required: true },
      channel:          {
        type:     String,
        required: true,
        enum:     ['slack', 'web', 'discord', 'telegram', 'teams'],
      },
      external_id:      { type: String, required: true },
      external_team_id: { type: String, default: '' },
      display_name:     String,
      linked_at:        Date,
      link_method:      {
        type: String,
        enum: ['oauth', 'magic_code', 'admin', 'inferred'],
      },
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
  );

  // Unique compound index mirrors the spec constraint.
  channelIdentitySchema.index(
    { channel: 1, external_id: 1, external_team_id: 1 },
    { unique: true },
  );

  Model = m.model('SynapsChannelIdentity_test', channelIdentitySchema);
  repo  = new ChannelIdentityRepo({ model: Model, logger: silentLogger });
}, 120_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

// ── create() ─────────────────────────────────────────────────────────────────

describe('ChannelIdentityRepo.create()', () => {
  it('creates a new document with all fields', async () => {
    const synapsUserId = new m.Types.ObjectId();
    const doc = await repo.create({
      synaps_user_id:   synapsUserId,
      channel:          'slack',
      external_id:      'U111',
      external_team_id: 'T111',
      display_name:     'Alice',
      link_method:      'inferred',
    });

    expect(doc._id).toBeDefined();
    expect(String(doc.synaps_user_id)).toBe(String(synapsUserId));
    expect(doc.channel).toBe('slack');
    expect(doc.external_id).toBe('U111');
    expect(doc.external_team_id).toBe('T111');
    expect(doc.display_name).toBe('Alice');
    expect(doc.link_method).toBe('inferred');
    expect(doc.linked_at).toBeInstanceOf(Date);
  });

  it('throws on duplicate compound key', async () => {
    const synapsUserId = new m.Types.ObjectId();
    const params = {
      synaps_user_id:   synapsUserId,
      channel:          'slack',
      external_id:      'U222',
      external_team_id: 'T222',
    };
    await repo.create(params);
    await expect(repo.create(params)).rejects.toThrow();
  });
});

// ── findByExternal() ──────────────────────────────────────────────────────────

describe('ChannelIdentityRepo.findByExternal()', () => {
  it('returns the matching document', async () => {
    const synapsUserId = new m.Types.ObjectId();
    await repo.create({
      synaps_user_id:   synapsUserId,
      channel:          'web',
      external_id:      'web-user-1',
      external_team_id: '',
    });

    const found = await repo.findByExternal({ channel: 'web', external_id: 'web-user-1', external_team_id: '' });
    expect(found).not.toBeNull();
    expect(String(found.synaps_user_id)).toBe(String(synapsUserId));
  });

  it('returns null when no match', async () => {
    const result = await repo.findByExternal({ channel: 'slack', external_id: 'nobody', external_team_id: 'T0' });
    expect(result).toBeNull();
  });
});

// ── listByUser() ──────────────────────────────────────────────────────────────

describe('ChannelIdentityRepo.listByUser()', () => {
  it('returns all identities for a user', async () => {
    const userId = new m.Types.ObjectId();
    await repo.create({ synaps_user_id: userId, channel: 'slack', external_id: 'U1', external_team_id: 'T1' });
    await repo.create({ synaps_user_id: userId, channel: 'web',   external_id: 'W1', external_team_id: '' });

    const list = await repo.listByUser(userId);
    expect(list).toHaveLength(2);
  });

  it('returns empty array for a user with no identities', async () => {
    const list = await repo.listByUser(new m.Types.ObjectId());
    expect(list).toEqual([]);
  });

  it('does not return identities from other users', async () => {
    const userA = new m.Types.ObjectId();
    const userB = new m.Types.ObjectId();
    await repo.create({ synaps_user_id: userA, channel: 'slack', external_id: 'UA', external_team_id: 'T0' });
    await repo.create({ synaps_user_id: userB, channel: 'slack', external_id: 'UB', external_team_id: 'T0' });

    const listA = await repo.listByUser(userA);
    expect(listA).toHaveLength(1);
    expect(String(listA[0].synaps_user_id)).toBe(String(userA));
  });
});

// ── upsertExternal() ──────────────────────────────────────────────────────────

describe('ChannelIdentityRepo.upsertExternal()', () => {
  it('returns isNew: true on first call', async () => {
    const synapsUserId = new m.Types.ObjectId();
    const { doc, isNew } = await repo.upsertExternal({
      synaps_user_id:   synapsUserId,
      channel:          'slack',
      external_id:      'U300',
      external_team_id: 'T300',
      display_name:     'FirstName',
      link_method:      'magic_code',
    });

    expect(isNew).toBe(true);
    expect(doc._id).toBeDefined();
    expect(doc.display_name).toBe('FirstName');
    expect(String(doc.synaps_user_id)).toBe(String(synapsUserId));
  });

  it('returns isNew: false on second call with same key', async () => {
    const synapsUserId = new m.Types.ObjectId();
    await repo.upsertExternal({
      synaps_user_id:   synapsUserId,
      channel:          'slack',
      external_id:      'U400',
      external_team_id: 'T400',
      display_name:     'OriginalName',
      link_method:      'inferred',
    });

    const { doc: second, isNew } = await repo.upsertExternal({
      synaps_user_id:   synapsUserId,
      channel:          'slack',
      external_id:      'U400',
      external_team_id: 'T400',
      display_name:     'UpdatedName',
      link_method:      'magic_code', // ignored on update ($setOnInsert)
    });

    expect(isNew).toBe(false);
    expect(second.display_name).toBe('UpdatedName');
  });

  it('does not overwrite synaps_user_id on second upsert', async () => {
    const userId1 = new m.Types.ObjectId();
    const userId2 = new m.Types.ObjectId();

    await repo.upsertExternal({
      synaps_user_id:   userId1,
      channel:          'slack',
      external_id:      'U500',
      external_team_id: 'T500',
      display_name:     'Name',
      link_method:      'inferred',
    });

    const { doc } = await repo.upsertExternal({
      synaps_user_id:   userId2, // should be ignored on update
      channel:          'slack',
      external_id:      'U500',
      external_team_id: 'T500',
      display_name:     'Name2',
    });

    // synaps_user_id must still be userId1 (it was $setOnInsert only).
    expect(String(doc.synaps_user_id)).toBe(String(userId1));
  });

  it('linked_at is refreshed on every upsert', async () => {
    const synapsUserId = new m.Types.ObjectId();
    const { doc: first } = await repo.upsertExternal({
      synaps_user_id: synapsUserId, channel: 'web', external_id: 'W9', external_team_id: '',
    });

    await new Promise((r) => setTimeout(r, 5));

    const { doc: second } = await repo.upsertExternal({
      synaps_user_id: synapsUserId, channel: 'web', external_id: 'W9', external_team_id: '',
    });

    expect(second.linked_at.getTime()).toBeGreaterThanOrEqual(first.linked_at.getTime());
  });
});

// ── Logger is invoked on errors ───────────────────────────────────────────────

describe('ChannelIdentityRepo logger', () => {
  it('logs an error when create() throws', async () => {
    const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const brokenModel = {
      create: vi.fn().mockRejectedValue(new Error('disk full')),
    };
    const badRepo = new ChannelIdentityRepo({ model: brokenModel, logger: fakeLogger });

    await expect(
      badRepo.create({ synaps_user_id: new m.Types.ObjectId(), channel: 'web', external_id: 'x', external_team_id: '' }),
    ).rejects.toThrow('disk full');
  });
});

// ── IdentityRouter aliases ────────────────────────────────────────────────────

describe('ChannelIdentityRepo.findByChannelId() — IdentityRouter alias', () => {
  it('returns the same doc as findByExternal() for the same key', async () => {
    const synapsUserId = new m.Types.ObjectId();
    await repo.create({
      synaps_user_id:   synapsUserId,
      channel:          'slack',
      external_id:      'ALIAS_U1',
      external_team_id: 'ALIAS_T1',
      display_name:     'AliasUser',
      link_method:      'inferred',
    });

    const viaAlias    = await repo.findByChannelId({ channel: 'slack', external_id: 'ALIAS_U1', external_team_id: 'ALIAS_T1' });
    const viaDirect   = await repo.findByExternal({ channel: 'slack', external_id: 'ALIAS_U1', external_team_id: 'ALIAS_T1' });

    expect(viaAlias).not.toBeNull();
    expect(String(viaAlias._id)).toBe(String(viaDirect._id));
    expect(viaAlias.display_name).toBe(viaDirect.display_name);
  });

  it('returns null when no matching document exists', async () => {
    const result = await repo.findByChannelId({ channel: 'web', external_id: 'nosuch', external_team_id: '' });
    expect(result).toBeNull();
  });
});

describe('ChannelIdentityRepo.upsert() — IdentityRouter alias', () => {
  it('returns the doc directly (not the {doc,isNew} tuple)', async () => {
    const synapsUserId = new m.Types.ObjectId();
    const result = await repo.upsert({
      synaps_user_id:   synapsUserId,
      channel:          'discord',
      external_id:      'D001',
      external_team_id: '',
      display_name:     'DiscordUser',
      link_method:      'inferred',
    });

    // Must be the doc itself — not { doc, isNew }.
    expect(result).not.toBeNull();
    expect(result._id).toBeDefined();
    expect(result.isNew).toBeUndefined();
    expect(String(result.synaps_user_id)).toBe(String(synapsUserId));
    expect(result.channel).toBe('discord');
  });

  it('is idempotent — second call also returns just the doc', async () => {
    const synapsUserId = new m.Types.ObjectId();
    const params = {
      synaps_user_id:   synapsUserId,
      channel:          'teams',
      external_id:      'MS001',
      external_team_id: '',
      display_name:     'TeamsUser',
      link_method:      'oauth',
    };

    const first  = await repo.upsert(params);
    const second = await repo.upsert({ ...params, display_name: 'TeamsUserUpdated' });

    expect(first._id).toBeDefined();
    expect(second._id).toBeDefined();
    expect(String(first._id)).toBe(String(second._id)); // same document
    expect(second.isNew).toBeUndefined();
  });
});

