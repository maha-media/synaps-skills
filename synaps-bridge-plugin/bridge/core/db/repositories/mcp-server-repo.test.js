/**
 * @file bridge/core/db/repositories/mcp-server-repo.test.js
 *
 * Tests for McpServerRepo.
 *
 * Uses mongodb-memory-server for an in-process MongoDB instance.
 * Documents are inserted via raw collection ops (no Mongoose schema) to mirror
 * the read-only, schema-agnostic nature of the repo itself.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { McpServerRepo } from './mcp-server-repo.js';

// ── Module-level fixtures ─────────────────────────────────────────────────────

let mongod;
let conn;
let repo;
let coll;

const COLLECTION = 'mcpservers';

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  conn   = await mongoose.createConnection(mongod.getUri(), {
    serverSelectionTimeoutMS: 5_000,
  }).asPromise();

  repo = new McpServerRepo({ db: conn });
  coll = conn.collection(COLLECTION);
}, 120_000);

afterAll(async () => {
  await conn.close();
  await mongod.stop();
});

beforeEach(async () => {
  await coll.deleteMany({});
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeOid = () => new mongoose.Types.ObjectId();

/** Insert a raw mcpserver-shaped document */
async function insertRow(overrides = {}) {
  const institutionId = overrides.institution ?? makeOid();
  const doc = {
    name:        'synaps-control-plane',
    institution: institutionId,
    status:      'active',
    require_approval: { enabled: false, skip_approval_tools: [] },
    tool_configuration: { enabled: true, allowed_tools: [] },
    ...overrides,
  };
  await coll.insertOne(doc);
  return doc;
}

// ── Constructor ───────────────────────────────────────────────────────────────

describe('McpServerRepo — constructor', () => {
  it('throws TypeError when db is missing', () => {
    expect(() => new McpServerRepo({})).toThrow(TypeError);
    expect(() => new McpServerRepo({})).toThrow('McpServerRepo: db required');
  });

  it('defaults collection name to "mcpservers"', () => {
    const r = new McpServerRepo({ db: conn });
    expect(r._coll.collectionName).toBe('mcpservers');
  });

  it('allows collection name to be overridden via constructor', () => {
    const r = new McpServerRepo({ db: conn, collection: 'custom_mcpservers' });
    expect(r._coll.collectionName).toBe('custom_mcpservers');
  });
});

// ── findActiveByName() ────────────────────────────────────────────────────────

describe('McpServerRepo.findActiveByName()', () => {
  it('returns the row when name + institution match and status is active', async () => {
    const instId = makeOid();
    await insertRow({ institution: instId, name: 'synaps-control-plane', status: 'active' });

    const result = await repo.findActiveByName({
      institution_id: instId,
      name: 'synaps-control-plane',
    });

    expect(result).not.toBeNull();
    expect(result.name).toBe('synaps-control-plane');
    expect(result.institution.toString()).toBe(instId.toString());
  });

  it('returns null when no row exists for that institution + name', async () => {
    const result = await repo.findActiveByName({
      institution_id: makeOid(),
      name: 'synaps-control-plane',
    });
    expect(result).toBeNull();
  });

  it('returns null when status is "inactive"', async () => {
    const instId = makeOid();
    await insertRow({ institution: instId, status: 'inactive' });

    const result = await repo.findActiveByName({
      institution_id: instId,
      name: 'synaps-control-plane',
    });
    expect(result).toBeNull();
  });

  it('returns null when status is "deleted"', async () => {
    const instId = makeOid();
    await insertRow({ institution: instId, status: 'deleted' });

    const result = await repo.findActiveByName({
      institution_id: instId,
      name: 'synaps-control-plane',
    });
    expect(result).toBeNull();
  });

  it('returns null when name matches but institution does not', async () => {
    const instId = makeOid();
    await insertRow({ institution: instId, name: 'synaps-control-plane', status: 'active' });

    const result = await repo.findActiveByName({
      institution_id: makeOid(), // different institution
      name: 'synaps-control-plane',
    });
    expect(result).toBeNull();
  });

  it('returns null when institution matches but name does not', async () => {
    const instId = makeOid();
    await insertRow({ institution: instId, name: 'synaps-control-plane', status: 'active' });

    const result = await repo.findActiveByName({
      institution_id: instId,
      name: 'other-policy',
    });
    expect(result).toBeNull();
  });

  it('accepts a string institution_id and converts it to ObjectId for the query', async () => {
    const instId = makeOid();
    await insertRow({ institution: instId, name: 'synaps-control-plane', status: 'active' });

    // Pass as hex string — must still find the document.
    const result = await repo.findActiveByName({
      institution_id: instId.toHexString(),
      name: 'synaps-control-plane',
    });

    expect(result).not.toBeNull();
    expect(result.name).toBe('synaps-control-plane');
  });

  it('accepts an ObjectId institution_id directly', async () => {
    const instId = makeOid();
    await insertRow({ institution: instId, name: 'synaps-control-plane', status: 'active' });

    const result = await repo.findActiveByName({
      institution_id: instId, // ObjectId — no conversion needed
      name: 'synaps-control-plane',
    });

    expect(result).not.toBeNull();
    expect(result.institution.toString()).toBe(instId.toString());
  });

  it('does not return an inactive row even when an active row for a different inst exists', async () => {
    const instA = makeOid();
    const instB = makeOid();
    await insertRow({ institution: instA, name: 'synaps-control-plane', status: 'active' });
    await insertRow({ institution: instB, name: 'synaps-control-plane', status: 'inactive' });

    const result = await repo.findActiveByName({
      institution_id: instB,
      name: 'synaps-control-plane',
    });
    expect(result).toBeNull();
  });
});
