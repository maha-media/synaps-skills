/**
 * @file bridge/core/db/repositories/workspace-repo.test.js
 *
 * Tests for WorkspaceRepo.
 *
 * Uses mongodb-memory-server for an in-process MongoDB instance.
 * Fake timers (vi.useFakeTimers) are used to simulate stale heartbeat
 * scenarios without real sleeps.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getSynapsWorkspaceModel } from '../models/synaps-workspace.js';
import { WorkspaceRepo } from './workspace-repo.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

let mongod;
let m;
let Model;
let repo;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5000,
    autoIndex: true,
  });
  Model = getSynapsWorkspaceModel(m);
  repo  = new WorkspaceRepo({ model: Model, logger: silentLogger });
}, 120_000); // allow time for first-run binary download

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Model.deleteMany({});
  vi.useRealTimers(); // ensure each test starts with real timers
});

// ── create() ─────────────────────────────────────────────────────────────────

describe('WorkspaceRepo.create()', () => {
  it('creates a doc with default state = provisioning', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await repo.create({ synaps_user_id: userId });
    expect(doc._id).toBeDefined();
    expect(doc.state).toBe('provisioning');
    expect(String(doc.synaps_user_id)).toBe(String(userId));
  });

  it('stores custom image and resource_limits', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await repo.create({
      synaps_user_id:  userId,
      image:           'synaps/workspace:1.0.0',
      resource_limits: { cpu: 4, mem_mb: 1024, pids: 200 },
    });
    expect(doc.image).toBe('synaps/workspace:1.0.0');
    expect(doc.resource_limits.cpu).toBe(4);
    expect(doc.resource_limits.mem_mb).toBe(1024);
  });
});

// ── byId() ────────────────────────────────────────────────────────────────────

describe('WorkspaceRepo.byId()', () => {
  it('returns the doc when it exists', async () => {
    const userId = new mongoose.Types.ObjectId();
    const created = await repo.create({ synaps_user_id: userId });
    const found = await repo.byId(created._id);
    expect(found).not.toBeNull();
    expect(String(found._id)).toBe(String(created._id));
  });

  it('returns null for a missing id', async () => {
    const result = await repo.byId(new mongoose.Types.ObjectId());
    expect(result).toBeNull();
  });
});

// ── byUserId() ────────────────────────────────────────────────────────────────

describe('WorkspaceRepo.byUserId()', () => {
  it('returns the latest non-reaped workspace for a user', async () => {
    const userId = new mongoose.Types.ObjectId();
    const first  = await repo.create({ synaps_user_id: userId });
    // Small delay so created_at ordering is deterministic.
    await new Promise((r) => setTimeout(r, 5));
    const second = await repo.create({ synaps_user_id: userId });

    const found = await repo.byUserId(userId);
    expect(String(found._id)).toBe(String(second._id));
  });

  it('excludes reaped workspaces', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await repo.create({ synaps_user_id: userId });
    await repo.setState(doc._id, 'reaped');

    const found = await repo.byUserId(userId);
    expect(found).toBeNull();
  });

  it('returns null when no workspaces exist for the user', async () => {
    const result = await repo.byUserId(new mongoose.Types.ObjectId());
    expect(result).toBeNull();
  });
});

// ── byContainerId() ───────────────────────────────────────────────────────────

describe('WorkspaceRepo.byContainerId()', () => {
  it('returns the doc matching container_id', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await repo.create({ synaps_user_id: userId });
    await repo.setState(doc._id, 'running', { container_id: 'ctr-abc' });

    const found = await repo.byContainerId('ctr-abc');
    expect(found).not.toBeNull();
    expect(found.container_id).toBe('ctr-abc');
  });

  it('returns null for an unknown container_id', async () => {
    const result = await repo.byContainerId('no-such-container');
    expect(result).toBeNull();
  });
});

// ── setState() ────────────────────────────────────────────────────────────────

describe('WorkspaceRepo.setState()', () => {
  it('updates the state of a workspace', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await repo.create({ synaps_user_id: userId });

    const updated = await repo.setState(doc._id, 'running');
    expect(updated.state).toBe('running');

    const fetched = await repo.byId(doc._id);
    expect(fetched.state).toBe('running');
  });

  it('merges extra fields like container_id and vnc_url', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await repo.create({ synaps_user_id: userId });

    await repo.setState(doc._id, 'running', {
      container_id: 'ctr-xyz',
      vnc_url:      'https://vnc.example.com/abc',
    });
    const fetched = await repo.byId(doc._id);
    expect(fetched.container_id).toBe('ctr-xyz');
    expect(fetched.vnc_url).toBe('https://vnc.example.com/abc');
  });

  it('returns null for a missing id', async () => {
    const result = await repo.setState(new mongoose.Types.ObjectId(), 'stopped');
    expect(result).toBeNull();
  });

  it('rejects an invalid state', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await repo.create({ synaps_user_id: userId });
    await expect(repo.setState(doc._id, 'exploded')).rejects.toThrow();
  });
});

// ── heartbeat() ───────────────────────────────────────────────────────────────

describe('WorkspaceRepo.heartbeat()', () => {
  it('sets last_heartbeat to current time', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await repo.create({ synaps_user_id: userId });
    expect(doc.last_heartbeat).toBeNull();

    await repo.heartbeat(doc._id);
    const fetched = await repo.byId(doc._id);
    expect(fetched.last_heartbeat).toBeInstanceOf(Date);
  });

  it('updates last_heartbeat on repeated calls', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await repo.create({ synaps_user_id: userId });

    await repo.heartbeat(doc._id);
    const first = (await repo.byId(doc._id)).last_heartbeat;

    await new Promise((r) => setTimeout(r, 5));
    await repo.heartbeat(doc._id);
    const second = (await repo.byId(doc._id)).last_heartbeat;

    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });
});

// ── listStaleHeartbeat() ──────────────────────────────────────────────────────

describe('WorkspaceRepo.listStaleHeartbeat()', () => {
  it('returns running workspaces whose heartbeat is older than threshold', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const userId = new mongoose.Types.ObjectId();
    const doc = await repo.create({ synaps_user_id: userId });
    // Manually write a stale last_heartbeat via Model directly (repo.heartbeat
    // uses new Date() which respects fake timers).
    await Model.updateOne(
      { _id: doc._id },
      { $set: { state: 'running', last_heartbeat: new Date(now - 60_000) } },
    );

    // Advance clock so "now" is 30 seconds later; threshold is 20 s.
    vi.setSystemTime(now + 30_000);

    const stale = await repo.listStaleHeartbeat(20_000);
    expect(stale.length).toBe(1);
    expect(String(stale[0]._id)).toBe(String(doc._id));

    vi.useRealTimers();
  });

  it('does not return non-running workspaces', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await repo.create({ synaps_user_id: userId });
    await Model.updateOne(
      { _id: doc._id },
      { $set: { state: 'stopped', last_heartbeat: new Date(Date.now() - 60_000) } },
    );

    const stale = await repo.listStaleHeartbeat(1_000);
    expect(stale.length).toBe(0);
  });

  it('does not return running workspaces with a fresh heartbeat', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await repo.create({ synaps_user_id: userId });
    await repo.setState(doc._id, 'running');
    await repo.heartbeat(doc._id); // fresh

    const stale = await repo.listStaleHeartbeat(60_000);
    expect(stale.length).toBe(0);
  });
});

// ── delete() ──────────────────────────────────────────────────────────────────

describe('WorkspaceRepo.delete()', () => {
  it('deletes an existing doc and returns true', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await repo.create({ synaps_user_id: userId });

    const result = await repo.delete(doc._id);
    expect(result).toBe(true);

    const fetched = await repo.byId(doc._id);
    expect(fetched).toBeNull();
  });

  it('returns false when doc does not exist', async () => {
    const result = await repo.delete(new mongoose.Types.ObjectId());
    expect(result).toBe(false);
  });
});
