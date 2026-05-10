/**
 * @file bridge/core/db/models/synaps-mcp-audit.test.js
 *
 * Schema validation and index tests for the SynapsMcpAudit model.
 *
 * Schema-level validation tests do not require a live DB connection.
 * Index verification tests use mongodb-memory-server.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { synapsMcpAuditSchema, getSynapsMcpAuditModel } from './synaps-mcp-audit.js';

// ── Schema-level validation (no DB) ──────────────────────────────────────────

describe('synapsMcpAuditSchema — compilation', () => {
  it('exports a Mongoose Schema instance', () => {
    expect(synapsMcpAuditSchema).toBeInstanceOf(mongoose.Schema);
  });

  it('getSynapsMcpAuditModel is a function', () => {
    expect(typeof getSynapsMcpAuditModel).toBe('function');
  });
});

describe('synapsMcpAuditSchema — required fields & defaults (no DB)', () => {
  let m;
  let Model;

  beforeAll(() => {
    m = new mongoose.Mongoose();
    m.set('strictQuery', true);
    Model = m.model('SynapsMcpAuditValidation', synapsMcpAuditSchema);
  });

  const validBase = () => ({
    method:      'tools/call',
    outcome:     'ok',
    duration_ms: 42,
  });

  it('passes validation with all required fields (ts auto-filled)', async () => {
    const doc = new Model(validBase());
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('ts auto-fills to a Date when omitted', () => {
    const doc = new Model(validBase());
    expect(doc.ts).toBeInstanceOf(Date);
  });

  it('requires method', async () => {
    const { method: _omit, ...rest } = validBase();
    const doc = new Model(rest);
    await expect(doc.validate()).rejects.toThrow(/method is required/);
  });

  it('requires outcome', async () => {
    const { outcome: _omit, ...rest } = validBase();
    const doc = new Model(rest);
    await expect(doc.validate()).rejects.toThrow(/outcome is required/);
  });

  it('requires duration_ms', async () => {
    const { duration_ms: _omit, ...rest } = validBase();
    const doc = new Model(rest);
    await expect(doc.validate()).rejects.toThrow(/duration_ms is required/);
  });

  it('rejects outcome values outside the enum', async () => {
    const doc = new Model({ ...validBase(), outcome: 'forbidden' });
    await expect(doc.validate()).rejects.toThrow(
      /outcome must be one of: ok, denied, error, rate_limited/,
    );
  });

  it('accepts all valid outcome enum values', async () => {
    for (const outcome of ['ok', 'denied', 'error', 'rate_limited']) {
      const doc = new Model({ ...validBase(), outcome });
      await expect(doc.validate()).resolves.toBeUndefined();
    }
  });

  it('defaults tool_name to null', () => {
    const doc = new Model(validBase());
    expect(doc.tool_name).toBeNull();
  });

  it('defaults error_code to null', () => {
    const doc = new Model(validBase());
    expect(doc.error_code).toBeNull();
  });

  it('defaults synaps_user_id to null', () => {
    const doc = new Model(validBase());
    expect(doc.synaps_user_id).toBeNull();
  });

  it('defaults institution_id to null', () => {
    const doc = new Model(validBase());
    expect(doc.institution_id).toBeNull();
  });

  it('defaults client_info.name to null', () => {
    const doc = new Model(validBase());
    expect(doc.client_info.name).toBeNull();
  });

  it('defaults client_info.version to null', () => {
    const doc = new Model(validBase());
    expect(doc.client_info.version).toBeNull();
  });

  it('accepts synaps_user_id as an ObjectId', async () => {
    const doc = new Model({
      ...validBase(),
      synaps_user_id: new mongoose.Types.ObjectId(),
    });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('accepts institution_id as an ObjectId', async () => {
    const doc = new Model({
      ...validBase(),
      institution_id: new mongoose.Types.ObjectId(),
    });
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('rejects duration_ms < 0', async () => {
    const doc = new Model({ ...validBase(), duration_ms: -1 });
    await expect(doc.validate()).rejects.toThrow(/duration_ms must be >= 0/);
  });

  it('accepts duration_ms === 0', async () => {
    const doc = new Model({ ...validBase(), duration_ms: 0 });
    await expect(doc.validate()).resolves.toBeUndefined();
  });
});

// ── Index definitions (schema-level, no DB) ───────────────────────────────────

describe('synapsMcpAuditSchema — index declarations (no DB)', () => {
  it('declares a TTL index on ts with expireAfterSeconds: 30 days', () => {
    const indexes = synapsMcpAuditSchema.indexes();
    const entry = indexes.find(
      ([fields, opts]) =>
        fields.ts === -1 && opts.expireAfterSeconds === 30 * 24 * 60 * 60,
    );
    expect(entry).toBeDefined();
  });

  it('declares a compound index on { synaps_user_id: 1, ts: -1 }', () => {
    const indexes = synapsMcpAuditSchema.indexes();
    const entry = indexes.find(
      ([fields]) => fields.synaps_user_id === 1 && fields.ts === -1,
    );
    expect(entry).toBeDefined();
  });

  it('declares a compound index on { institution_id: 1, ts: -1 }', () => {
    const indexes = synapsMcpAuditSchema.indexes();
    const entry = indexes.find(
      ([fields]) => fields.institution_id === 1 && fields.ts === -1,
    );
    expect(entry).toBeDefined();
  });
});

// ── DB-backed index verification ──────────────────────────────────────────────

describe('SynapsMcpAudit model — indexes in-memory DB', () => {
  let mongod;
  let m;
  let Model;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    m = new mongoose.Mongoose();
    m.set('strictQuery', true);
    await m.connect(mongod.getUri(), {
      serverSelectionTimeoutMS: 5000,
      autoIndex: true,
    });
    Model = getSynapsMcpAuditModel(m);
    // Ensure indexes are built.
    await Model.ensureIndexes();
  }, 120_000);

  afterAll(async () => {
    await m.disconnect();
    await mongod.stop();
  });

  it('TTL index exists on ts (expireAfterSeconds present in getIndexes())', async () => {
    const indexes = await Model.collection.getIndexes({ full: true });
    const ttl = indexes.find(
      (idx) => idx.expireAfterSeconds !== undefined && idx.key && idx.key.ts !== undefined,
    );
    expect(ttl).toBeDefined();
    expect(ttl.expireAfterSeconds).toBe(30 * 24 * 60 * 60);
  });

  it('compound index for synaps_user_id exists', async () => {
    const indexes = await Model.collection.getIndexes({ full: true });
    const idx = indexes.find(
      (i) => i.key && i.key.synaps_user_id === 1 && i.key.ts === -1,
    );
    expect(idx).toBeDefined();
  });

  it('compound index for institution_id exists', async () => {
    const indexes = await Model.collection.getIndexes({ full: true });
    const idx = indexes.find(
      (i) => i.key && i.key.institution_id === 1 && i.key.ts === -1,
    );
    expect(idx).toBeDefined();
  });

  it('getSynapsMcpAuditModel returns the same model when called twice', () => {
    const m1 = getSynapsMcpAuditModel(m);
    const m2 = getSynapsMcpAuditModel(m);
    expect(m1).toBe(m2);
  });
});
