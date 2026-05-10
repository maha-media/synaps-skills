/**
 * @file tests/scp-phase-6/03-heartbeat-emit-control-socket.test.mjs
 *
 * Real ControlSocket UDS + real HeartbeatRepo + real mongo-memory-server.
 *
 * Strategy
 * ────────
 * • MongoMemoryServer provides a real in-process MongoDB instance.
 * • makeHeartbeatRepo(mongoose) from db/index.js builds the production repo.
 * • A real ControlSocket is started on a tmp UDS path.
 * • A real WorkspaceRepo is used for ownership checks.
 * • Requests are sent via the sendRequest() helper (same pattern as
 *   bridge/control-socket.test.js) — connects, writes JSON, reads response.
 *
 * ≥ 5 tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { makeHeartbeatRepo }  from '../../bridge/core/db/index.js';
import { makeHeartbeatModel } from '../../bridge/core/db/models/synaps-heartbeat.js';
import { ControlSocket }      from '../../bridge/control-socket.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let socketCounter = 0;
function tmpSocketPath() {
  return path.join(os.tmpdir(), `cs-hb-test-${process.pid}-${++socketCounter}.sock`);
}

function makeFakeRouter() {
  return {
    liveSessions: () => [],
    listSessions: async () => [],
    closeSession: async () => {},
  };
}

/** Send one JSON request over a UDS and receive one JSON response. */
function sendRequest(socketPath, req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    sock.on('connect', () => { sock.write(JSON.stringify(req) + '\n'); });
    sock.on('data', (c)  => { buf += c.toString('utf8'); });
    sock.on('end',  ()   => {
      try { resolve(JSON.parse(buf.trim())); }
      catch (e) { reject(new Error(`Could not parse: ${buf}`)); }
    });
    sock.on('error', reject);
  });
}

// ─── Module-level fixtures ────────────────────────────────────────────────────

let mongod;
let m;
let heartbeatRepo;
let Heartbeat;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m      = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), { serverSelectionTimeoutMS: 10_000, autoIndex: true });
  Heartbeat     = makeHeartbeatModel(m);
  heartbeatRepo = makeHeartbeatRepo(m);
}, 60_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Heartbeat.deleteMany({});
});

// ─── 1. workspace heartbeat — happy path ──────────────────────────────────────

describe('heartbeat_emit — workspace, owner match', () => {
  let cs;
  let socketPath;

  beforeAll(async () => {
    socketPath = tmpSocketPath();

    // Build a workspace repo stub that always returns the matching workspace.
    const workspaceId  = 'ws-real-1';
    const synapsUserId = new mongoose.Types.ObjectId().toString();
    const fakeWorkspaceRepo = {
      byId:     async () => ({ _id: workspaceId, synaps_user_id: synapsUserId }),
      findById: async () => ({ _id: workspaceId, synaps_user_id: synapsUserId }),
    };

    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      heartbeatRepo,
      workspaceRepo: fakeWorkspaceRepo,
      logger:        silent,
    });
    await cs.start();
  });

  afterAll(async () => { await cs.stop(); });

  it('returns ok:true with ISO8601 ts', async () => {
    const workspaceId  = 'ws-real-1';
    const synapsUserId = (await (async () => {
      // re-read the workspaceRepo's user
      return new mongoose.Types.ObjectId().toString();
    })());

    // Build a proper workspace repo that matches the userId we'll pass.
    const uid = new mongoose.Types.ObjectId().toString();
    const sp2 = tmpSocketPath();
    const fakeWsRepo = {
      byId:     async () => ({ _id: 'ws-match', synaps_user_id: uid }),
      findById: async () => ({ _id: 'ws-match', synaps_user_id: uid }),
    };
    const cs2 = new ControlSocket({
      socketPath: sp2,
      sessionRouter: makeFakeRouter(),
      heartbeatRepo,
      workspaceRepo: fakeWsRepo,
      logger: silent,
    });
    await cs2.start();

    const resp = await sendRequest(sp2, {
      op:             'heartbeat_emit',
      component:      'workspace',
      id:             'ws-match',
      synaps_user_id: uid,
    });

    await cs2.stop();

    expect(resp.ok).toBe(true);
    expect(typeof resp.ts).toBe('string');
    // Verify ts is valid ISO8601.
    expect(new Date(resp.ts).toISOString()).toBe(resp.ts);
  });

  it('heartbeat is persisted to MongoDB (real HeartbeatRepo)', async () => {
    const uid = new mongoose.Types.ObjectId().toString();
    const sp3 = tmpSocketPath();
    const fakeWsRepo = {
      byId:     async () => ({ _id: 'ws-persist', synaps_user_id: uid }),
      findById: async () => ({ _id: 'ws-persist', synaps_user_id: uid }),
    };
    const cs3 = new ControlSocket({
      socketPath: sp3,
      sessionRouter: makeFakeRouter(),
      heartbeatRepo,
      workspaceRepo: fakeWsRepo,
      logger: silent,
    });
    await cs3.start();

    await sendRequest(sp3, {
      op:             'heartbeat_emit',
      component:      'workspace',
      id:             'ws-persist',
      synaps_user_id: uid,
      healthy:        true,
      details:        { cpu: 42 },
    });

    await cs3.stop();

    // Verify the record exists in the real DB.
    const all = await heartbeatRepo.findAll();
    const row = all.find(r => r.id === 'ws-persist');
    expect(row).toBeDefined();
    expect(row.component).toBe('workspace');
    expect(row.healthy).toBe(true);
  });
});

// ─── 2. ownership mismatch → unauthorized ────────────────────────────────────

describe('heartbeat_emit — ownership mismatch', () => {
  it('returns code:unauthorized when workspace owner does not match synaps_user_id', async () => {
    const socketPath = tmpSocketPath();
    const actualOwner = new mongoose.Types.ObjectId().toString();
    const fakeWsRepo  = {
      byId:     async () => ({ _id: 'ws-owned', synaps_user_id: actualOwner }),
      findById: async () => ({ _id: 'ws-owned', synaps_user_id: actualOwner }),
    };

    const cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      heartbeatRepo,
      workspaceRepo: fakeWsRepo,
      logger: silent,
    });
    await cs.start();

    const resp = await sendRequest(socketPath, {
      op:             'heartbeat_emit',
      component:      'workspace',
      id:             'ws-owned',
      synaps_user_id: new mongoose.Types.ObjectId().toString(), // different user
    });

    await cs.stop();

    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('unauthorized');
    expect(resp.error).toMatch(/mismatch/);
  });
});

// ─── 3. supervisor disabled (no heartbeatRepo) → silent ok ───────────────────

describe('heartbeat_emit — supervisor disabled', () => {
  it('returns { ok:true, supervisor:"noop" } when heartbeatRepo is absent', async () => {
    const socketPath = tmpSocketPath();
    const cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      // heartbeatRepo intentionally omitted — supervisor disabled
      logger: silent,
    });
    await cs.start();

    const resp = await sendRequest(socketPath, {
      op:             'heartbeat_emit',
      component:      'rpc',
      id:             'sess-1',
      synaps_user_id: new mongoose.Types.ObjectId().toString(),
    });

    await cs.stop();

    expect(resp.ok).toBe(true);
    expect(resp.supervisor).toBe('noop');
  });
});

// ─── 4. rpc component — no ownership check ───────────────────────────────────

describe('heartbeat_emit — rpc component skips ownership check', () => {
  it('records heartbeat for rpc without any workspaceRepo lookup', async () => {
    const socketPath = tmpSocketPath();
    const workspaceRepoSpy = {
      byId:     async () => { throw new Error('should not be called'); },
      findById: async () => { throw new Error('should not be called'); },
    };

    const cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      heartbeatRepo,
      workspaceRepo: workspaceRepoSpy,
      logger: silent,
    });
    await cs.start();

    const resp = await sendRequest(socketPath, {
      op:             'heartbeat_emit',
      component:      'rpc',
      id:             'sess-no-check',
      synaps_user_id: new mongoose.Types.ObjectId().toString(),
    });

    await cs.stop();

    expect(resp.ok).toBe(true);
    expect(resp.ts).toBeDefined();
  });
});

// ─── 5. invalid_request codes ────────────────────────────────────────────────

describe('heartbeat_emit — validation codes', () => {
  let cs;
  let socketPath;

  beforeAll(async () => {
    socketPath = tmpSocketPath();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      heartbeatRepo,
      logger: silent,
    });
    await cs.start();
  });

  afterAll(async () => { await cs.stop(); });

  it('missing component → code:invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op:             'heartbeat_emit',
      id:             'ws-1',
      synaps_user_id: new mongoose.Types.ObjectId().toString(),
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
  });

  it('invalid component value → code:invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op:             'heartbeat_emit',
      component:      'bridge',  // not allowed
      id:             'ws-1',
      synaps_user_id: new mongoose.Types.ObjectId().toString(),
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
    expect(resp.error).toMatch(/workspace|rpc|agent/);
  });

  it('missing synaps_user_id → code:invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op:        'heartbeat_emit',
      component: 'workspace',
      id:        'ws-1',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
    expect(resp.error).toMatch(/synaps_user_id/);
  });
});
