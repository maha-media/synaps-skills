/**
 * @file bridge/core/db/models/synaps-workspace.test.js
 *
 * Schema validation and round-trip tests for the SynapsWorkspace model.
 *
 * Schema-level validation tests do not require a live DB connection.
 * Round-trip tests use mongodb-memory-server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { synapsWorkspaceSchema, getSynapsWorkspaceModel } from './synaps-workspace.js';

// ── Schema-level validation (no DB) ─────────────────────────────────────────

describe('synapsWorkspaceSchema — validation (no DB)', () => {
  // Use a fresh local mongoose instance with a no-op connection so that
  // `doc.validate()` works without a real DB.
  let m;
  let Model;

  beforeAll(() => {
    m = new mongoose.Mongoose();
    m.set('strictQuery', true);
    Model = m.model('SynapsWorkspaceValidation', synapsWorkspaceSchema);
  });

  it('requires synaps_user_id', async () => {
    const doc = new Model({ image: 'synaps/workspace:0.1.0' });
    await expect(doc.validate()).rejects.toThrow(/synaps_user_id is required/);
  });

  it('rejects an invalid state enum value', async () => {
    const doc = new Model({
      synaps_user_id: new mongoose.Types.ObjectId(),
      state: 'exploded',
    });
    await expect(doc.validate()).rejects.toThrow(/not a valid workspace state/);
  });

  it('accepts all valid state enum values', async () => {
    const states = ['provisioning', 'running', 'stopped', 'failed', 'reaped'];
    for (const state of states) {
      const doc = new Model({
        synaps_user_id: new mongoose.Types.ObjectId(),
        state,
      });
      await expect(doc.validate()).resolves.toBeUndefined();
    }
  });

  it('defaults state to "provisioning"', () => {
    const doc = new Model({ synaps_user_id: new mongoose.Types.ObjectId() });
    expect(doc.state).toBe('provisioning');
  });

  it('defaults image to "synaps/workspace:0.1.0"', () => {
    const doc = new Model({ synaps_user_id: new mongoose.Types.ObjectId() });
    expect(doc.image).toBe('synaps/workspace:0.1.0');
  });

  it('defaults last_heartbeat to null', () => {
    const doc = new Model({ synaps_user_id: new mongoose.Types.ObjectId() });
    expect(doc.last_heartbeat).toBeNull();
  });

  it('stores resource_limits sub-document', async () => {
    const doc = new Model({
      synaps_user_id: new mongoose.Types.ObjectId(),
      resource_limits: { cpu: 2, mem_mb: 512, pids: 100 },
    });
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.resource_limits.cpu).toBe(2);
    expect(doc.resource_limits.mem_mb).toBe(512);
    expect(doc.resource_limits.pids).toBe(100);
  });
});

// ── Round-trip tests (in-memory MongoDB) ────────────────────────────────────

describe('SynapsWorkspace model — round-trip (in-memory DB)', () => {
  let mongod;
  let m;
  let Model;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    m = new mongoose.Mongoose();
    m.set('strictQuery', true);
    await m.connect(mongod.getUri(), {
      serverSelectionTimeoutMS: 5000,
      autoIndex: true, // enable for tests so unique index is built
    });
    Model = getSynapsWorkspaceModel(m);
  }, 120_000); // allow time for first-run binary download

  afterAll(async () => {
    await m.disconnect();
    await mongod.stop();
  });

  it('creates a document and fetches it back', async () => {
    const userId = new mongoose.Types.ObjectId();
    const created = await Model.create({ synaps_user_id: userId });
    expect(created._id).toBeDefined();
    expect(created.state).toBe('provisioning');

    const fetched = await Model.findById(created._id).lean();
    expect(fetched).not.toBeNull();
    expect(String(fetched.synaps_user_id)).toBe(String(userId));
  });

  it('updates state and persists the change', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await Model.create({ synaps_user_id: userId });

    await Model.findByIdAndUpdate(doc._id, { state: 'running' });
    const updated = await Model.findById(doc._id).lean();
    expect(updated.state).toBe('running');
  });

  it('sets timestamps created_at and updated_at', async () => {
    const userId = new mongoose.Types.ObjectId();
    const doc = await Model.create({ synaps_user_id: userId });
    expect(doc.created_at).toBeInstanceOf(Date);
    expect(doc.updated_at).toBeInstanceOf(Date);
  });

  it('enforces unique container_id (sparse index)', async () => {
    const uid1 = new mongoose.Types.ObjectId();
    const uid2 = new mongoose.Types.ObjectId();
    await Model.create({ synaps_user_id: uid1, container_id: 'abc123' });
    await expect(
      Model.create({ synaps_user_id: uid2, container_id: 'abc123' }),
    ).rejects.toThrow();
  });

  it('getSynapsWorkspaceModel returns the same model when called twice', () => {
    const m1 = getSynapsWorkspaceModel(m);
    const m2 = getSynapsWorkspaceModel(m);
    expect(m1).toBe(m2);
  });
});
