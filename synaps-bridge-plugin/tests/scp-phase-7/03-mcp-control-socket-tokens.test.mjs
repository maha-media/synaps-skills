/**
 * @file tests/scp-phase-7/03-mcp-control-socket-tokens.test.mjs
 *
 * UDS round-trip with mongo-memory-server + real McpTokenRepo + real ControlSocket.
 *
 * Tests:
 *  1.  connect to UDS, send mcp_token_issue → ok:true, token 64-char hex
 *  2.  issue → mcp_token_list → entry present, token_hash NOT in response
 *  3.  issue same name twice → both succeed (no unique constraint on name)
 *  4.  mcp_token_revoke valid id → ok:true
 *  5.  after revoke, findActive returns null (via repo directly)
 *  6.  mcp_token_issue missing synaps_user_id → ok:false missing_fields
 *  7.  mcp_token_issue missing institution_id → ok:false missing_fields
 *  8.  mcp_token_issue missing name → ok:false missing_fields
 *  9.  mcp_token_list with synaps_user_id filter → only that user
 * 10.  mcp_token_revoke unknown id → ok:false
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { getSynapsMcpTokenModel } from '../../bridge/core/db/models/synaps-mcp-token.js';
import { McpTokenRepo }           from '../../bridge/core/db/repositories/mcp-token-repo.js';
import { ControlSocket }          from '../../bridge/control-socket.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let socketCounter = 0;
function tmpSocketPath() {
  return path.join(os.tmpdir(), `cs-mcp-test-${process.pid}-${++socketCounter}.sock`);
}

function makeFakeRouter() {
  return {
    liveSessions:  () => [],
    listSessions:  async () => [],
    closeSession:  async () => {},
  };
}

/** Send one JSON request over a UDS and receive one JSON response. */
function sendRequest(socketPath, req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    sock.on('connect', () => { sock.write(JSON.stringify(req) + '\n'); });
    sock.on('data',  (c) => { buf += c.toString('utf8'); });
    sock.on('end',   ()  => {
      try { resolve(JSON.parse(buf.trim())); }
      catch (e) { reject(new Error(`Could not parse: ${buf}`)); }
    });
    sock.on('error', reject);
  });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let mongod;
let m;
let Model;
let repo;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m      = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), { serverSelectionTimeoutMS: 10_000, autoIndex: true });
  Model = getSynapsMcpTokenModel(m);
  repo  = new McpTokenRepo({ db: Model });
}, 60_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Model.deleteMany({});
});

// ─── Shared per-test ControlSocket ────────────────────────────────────────────

async function makeCs() {
  const socketPath = tmpSocketPath();
  const cs = new ControlSocket({
    socketPath,
    sessionRouter: makeFakeRouter(),
    mcpTokenRepo:  repo,
    logger:        silent,
  });
  await cs.start();
  return { cs, socketPath };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ControlSocket ↔ McpTokenRepo UDS round-trip', () => {

  it('1. mcp_token_issue → ok:true, token 64-char hex', async () => {
    const { cs, socketPath } = await makeCs();
    try {
      const resp = await sendRequest(socketPath, {
        op:             'mcp_token_issue',
        synaps_user_id: new mongoose.Types.ObjectId().toString(),
        institution_id: new mongoose.Types.ObjectId().toString(),
        name:           'round-trip-test',
      });
      expect(resp.ok).toBe(true);
      expect(resp.token).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof resp._id).toBe('string');
    } finally { await cs.stop(); }
  });

  it('2. issue → list → entry present, token_hash NOT in response', async () => {
    const { cs, socketPath } = await makeCs();
    try {
      const userId = new mongoose.Types.ObjectId().toString();
      const instId = new mongoose.Types.ObjectId().toString();
      await sendRequest(socketPath, {
        op: 'mcp_token_issue', synaps_user_id: userId, institution_id: instId, name: 'list-test',
      });
      const listResp = await sendRequest(socketPath, { op: 'mcp_token_list' });
      expect(listResp.ok).toBe(true);
      expect(listResp.tokens).toHaveLength(1);
      expect(listResp.tokens[0]).not.toHaveProperty('token_hash');
      expect(listResp.tokens[0].name).toBe('list-test');
    } finally { await cs.stop(); }
  });

  it('3. issue same name twice → both succeed (no unique constraint on name)', async () => {
    const { cs, socketPath } = await makeCs();
    try {
      const userId = new mongoose.Types.ObjectId().toString();
      const instId = new mongoose.Types.ObjectId().toString();
      const r1 = await sendRequest(socketPath, { op: 'mcp_token_issue', synaps_user_id: userId, institution_id: instId, name: 'dup-name' });
      const r2 = await sendRequest(socketPath, { op: 'mcp_token_issue', synaps_user_id: userId, institution_id: instId, name: 'dup-name' });
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r1._id).not.toBe(r2._id); // different documents
      const listResp = await sendRequest(socketPath, { op: 'mcp_token_list' });
      expect(listResp.tokens).toHaveLength(2);
    } finally { await cs.stop(); }
  });

  it('4. mcp_token_revoke valid id → ok:true', async () => {
    const { cs, socketPath } = await makeCs();
    try {
      const issued = await sendRequest(socketPath, {
        op: 'mcp_token_issue', synaps_user_id: new mongoose.Types.ObjectId().toString(),
        institution_id: new mongoose.Types.ObjectId().toString(), name: 'revoke-valid',
      });
      const revokeResp = await sendRequest(socketPath, { op: 'mcp_token_revoke', token_id: issued._id });
      expect(revokeResp.ok).toBe(true);
    } finally { await cs.stop(); }
  });

  it('5. after revoke, findActive returns null (verified via repo)', async () => {
    const { cs, socketPath } = await makeCs();
    try {
      const issued = await sendRequest(socketPath, {
        op: 'mcp_token_issue', synaps_user_id: new mongoose.Types.ObjectId().toString(),
        institution_id: new mongoose.Types.ObjectId().toString(), name: 'revoke-find-check',
      });
      const hash = createHash('sha256').update(issued.token).digest('hex');

      // Verify findable before revoke
      const before = await repo.findActive(hash);
      expect(before).not.toBeNull();

      await sendRequest(socketPath, { op: 'mcp_token_revoke', token_id: issued._id });

      const after = await repo.findActive(hash);
      expect(after).toBeNull();
    } finally { await cs.stop(); }
  });

  it('6. mcp_token_issue missing synaps_user_id → ok:false missing_fields', async () => {
    const { cs, socketPath } = await makeCs();
    try {
      const resp = await sendRequest(socketPath, {
        op: 'mcp_token_issue', institution_id: new mongoose.Types.ObjectId().toString(), name: 'missing-user',
      });
      expect(resp.ok).toBe(false);
      expect(resp.error).toBe('missing_fields');
    } finally { await cs.stop(); }
  });

  it('7. mcp_token_issue missing institution_id → ok:false missing_fields', async () => {
    const { cs, socketPath } = await makeCs();
    try {
      const resp = await sendRequest(socketPath, {
        op: 'mcp_token_issue', synaps_user_id: new mongoose.Types.ObjectId().toString(), name: 'missing-inst',
      });
      expect(resp.ok).toBe(false);
      expect(resp.error).toBe('missing_fields');
    } finally { await cs.stop(); }
  });

  it('8. mcp_token_issue missing name → ok:false missing_fields', async () => {
    const { cs, socketPath } = await makeCs();
    try {
      const resp = await sendRequest(socketPath, {
        op: 'mcp_token_issue', synaps_user_id: new mongoose.Types.ObjectId().toString(),
        institution_id: new mongoose.Types.ObjectId().toString(),
      });
      expect(resp.ok).toBe(false);
      expect(resp.error).toBe('missing_fields');
    } finally { await cs.stop(); }
  });

  it('9. mcp_token_list with synaps_user_id filter → only that user', async () => {
    const { cs, socketPath } = await makeCs();
    try {
      const userA = new mongoose.Types.ObjectId().toString();
      const userB = new mongoose.Types.ObjectId().toString();
      const instId = new mongoose.Types.ObjectId().toString();
      await sendRequest(socketPath, { op: 'mcp_token_issue', synaps_user_id: userA, institution_id: instId, name: 'a-tok' });
      await sendRequest(socketPath, { op: 'mcp_token_issue', synaps_user_id: userB, institution_id: instId, name: 'b-tok' });

      const listA = await sendRequest(socketPath, { op: 'mcp_token_list', synaps_user_id: userA });
      expect(listA.ok).toBe(true);
      expect(listA.tokens).toHaveLength(1);
      expect(listA.tokens[0].name).toBe('a-tok');
    } finally { await cs.stop(); }
  });

  it('10. mcp_token_revoke unknown id → ok:false', async () => {
    const { cs, socketPath } = await makeCs();
    try {
      const resp = await sendRequest(socketPath, {
        op: 'mcp_token_revoke', token_id: new mongoose.Types.ObjectId().toString(),
      });
      expect(resp.ok).toBe(false);
    } finally { await cs.stop(); }
  });

});
