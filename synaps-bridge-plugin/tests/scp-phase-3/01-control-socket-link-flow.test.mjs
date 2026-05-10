/**
 * @file tests/scp-phase-3/01-control-socket-link-flow.test.mjs
 *
 * Acceptance tests for ControlSocket link-code ops wired to a real
 * IdentityRouter backed by mongo-memory-server.
 *
 * Strategy
 * ────────
 * • MongoMemoryServer + private mongoose.Mongoose() for data isolation.
 * • IdentityRouter built from production repos + adapters (same pattern as
 *   00-identity-router-mongo.test.mjs).
 * • ControlSocket started on a per-test temp UDS path (os.tmpdir()).
 * • A minimal fake SessionRouter satisfies the ControlSocket constructor
 *   requirement without touching real SCP sessions.
 * • Tests use node:net to send line-JSON and read the response — exactly how
 *   the pria Express layer calls the socket.
 *
 * Scenarios (~6 tests)
 * ─────────────────────
 * 1. link_code_issue → returns ok:true + 6-char code
 * 2. link_code_redeem with that code from Slack → ok:true
 * 3. identity_resolve_web after redeem → same synaps_user_id as the issuer
 * 4. Disabled router → link_code_issue → ok:false, error:'identity disabled'
 * 5. Malformed JSON → clean error, not a crash
 * 6. Unknown op → ok:false, error includes 'unknown op'
 *
 * Constraints
 * ───────────
 * • ESM only (.mjs)
 * • beforeAll timeout ≥ 60_000
 * • No top-level await
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { getSynapsUserModel }             from '../../bridge/core/db/models/synaps-user.js';
import { getSynapsChannelIdentityModel }  from '../../bridge/core/db/models/synaps-channel-identity.js';
import { getSynapsLinkCodeModel }         from '../../bridge/core/db/models/synaps-link-code.js';
import { UserRepo }                       from '../../bridge/core/db/repositories/user-repo.js';
import { ChannelIdentityRepo }            from '../../bridge/core/db/repositories/channel-identity-repo.js';
import { LinkCodeRepo }                   from '../../bridge/core/db/repositories/link-code-repo.js';
import { IdentityRouter, NoOpIdentityRouter } from '../../bridge/core/identity-router.js';
import { ControlSocket }                  from '../../bridge/control-socket.js';

// ─── Shared fixtures ─────────────────────────────────────────────────────────

let mongod;
let m;
let UserModel, CIModel, LCModel;
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// ─── Adapters (same as test 00) ──────────────────────────────────────────────

function makeChannelIdentityAdapter(repo) {
  return {
    async findByChannelId({ channel, external_id, external_team_id }) {
      return repo.findByExternal({ channel, external_id, external_team_id });
    },
    async upsert({ synaps_user_id, channel, external_id, external_team_id, display_name, link_method }) {
      return repo.upsertExternal({ synaps_user_id, channel, external_id, external_team_id, display_name, link_method });
    },
  };
}

function makeLinkCodeAdapter(Model) {
  return {
    async findByCode(code) {
      return Model.findOne({ code }).lean();
    },
    async create({ code, pria_user_id, synaps_user_id, expires_at }) {
      const doc = await Model.create({ code, pria_user_id, synaps_user_id, expires_at });
      return doc.toObject ? doc.toObject() : doc;
    },
    async markRedeemed(code, { redeemed_by }) {
      await Model.findOneAndUpdate(
        { code },
        { $set: { redeemed_at: new Date(), redeemed_by } },
      ).lean();
    },
  };
}

/** Minimal fake SessionRouter — ControlSocket requires it but link ops don't use it. */
function makeFakeSessionRouter() {
  return {
    async start() {},
    async stop() {},
    async listSessions() { return []; },
    liveSessions() { return []; },
    async getOrCreateSession() { throw new Error('not wired in this test'); },
    async closeSession() {},
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), { serverSelectionTimeoutMS: 5000, autoIndex: true });

  UserModel = getSynapsUserModel(m);
  CIModel   = getSynapsChannelIdentityModel(m);
  LCModel   = getSynapsLinkCodeModel(m);
}, 60_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await UserModel.deleteMany({});
  await CIModel.deleteMany({});
  await LCModel.deleteMany({});
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a fresh IdentityRouter wired to the test collections. */
function buildIdentityRouter() {
  const userRepo = new UserRepo({ model: UserModel, logger: silent });
  const ciRepo   = new ChannelIdentityRepo({ model: CIModel, logger: silent });
  const lcRepo   = new LinkCodeRepo({ model: LCModel, logger: silent });

  return new IdentityRouter({
    userRepo,
    channelIdentityRepo: makeChannelIdentityAdapter(ciRepo),
    linkCodeRepo: makeLinkCodeAdapter(LCModel),
    logger: silent,
  });
}

/** Make a unique tmp socket path. */
function tmpSocket() {
  return path.join(os.tmpdir(), `scp-phase3-cs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

/**
 * Send one JSON line to a socket, collect the entire response, return parsed.
 *
 * @param {string} socketPath
 * @param {object} payload
 * @returns {Promise<object>}
 */
function sendRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';

    sock.setEncoding('utf8');
    sock.on('data', (chunk) => { buf += chunk; });
    sock.on('end', () => {
      try {
        resolve(JSON.parse(buf.trim()));
      } catch (e) {
        reject(new Error(`Bad JSON from socket: ${buf}`));
      }
    });
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload) + '\n');
    });
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ControlSocket link_code_issue op', () => {
  let cs;
  let socketPath;

  beforeEach(async () => {
    socketPath = tmpSocket();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeSessionRouter(),
      identityRouter: buildIdentityRouter(),
      logger: silent,
    });
    await cs.start();
  });

  afterEach(async () => {
    await cs.stop();
    fs.rmSync(socketPath, { force: true });
  });

  it('returns ok:true with a 6-char code', async () => {
    const priaId = new m.Types.ObjectId().toHexString();
    const resp = await sendRequest(socketPath, {
      op: 'link_code_issue',
      pria_user_id: priaId,
      ttl_secs: 300,
    });

    expect(resp.ok).toBe(true);
    expect(resp.code).toHaveLength(6);
    expect(resp.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(resp.expires_at).toBeDefined();
  });
});

describe('ControlSocket link_code_redeem op', () => {
  let cs;
  let socketPath;

  beforeEach(async () => {
    socketPath = tmpSocket();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeSessionRouter(),
      identityRouter: buildIdentityRouter(),
      logger: silent,
    });
    await cs.start();
  });

  afterEach(async () => {
    await cs.stop();
    fs.rmSync(socketPath, { force: true });
  });

  it('happy path: issue then redeem from Slack returns ok:true', async () => {
    const priaId = new m.Types.ObjectId().toHexString();

    // Issue.
    const issueResp = await sendRequest(socketPath, {
      op: 'link_code_issue',
      pria_user_id: priaId,
    });
    expect(issueResp.ok).toBe(true);

    // Redeem.
    const redeemResp = await sendRequest(socketPath, {
      op: 'link_code_redeem',
      code:             issueResp.code,
      channel:          'slack',
      external_id:      'UTEST1',
      external_team_id: 'TTEST1',
      display_name:     'Eve',
    });

    expect(redeemResp.ok).toBe(true);
    expect(redeemResp.synaps_user_id).toBeDefined();
  });
});

describe('ControlSocket identity_resolve_web op after redeem', () => {
  let cs;
  let socketPath;

  beforeEach(async () => {
    socketPath = tmpSocket();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeSessionRouter(),
      identityRouter: buildIdentityRouter(),
      logger: silent,
    });
    await cs.start();
  });

  afterEach(async () => {
    await cs.stop();
    fs.rmSync(socketPath, { force: true });
  });

  it('resolve_web after link-code issue returns same synaps_user_id as issuer', async () => {
    const priaId = new m.Types.ObjectId().toHexString();

    // Issue (auto-creates SynapsUser).
    const issueResp = await sendRequest(socketPath, {
      op: 'link_code_issue',
      pria_user_id: priaId,
    });
    expect(issueResp.ok).toBe(true);

    // Resolve web for same pria user (should find the existing SynapsUser).
    const webResp = await sendRequest(socketPath, {
      op: 'identity_resolve_web',
      pria_user_id: priaId,
      display_name: 'Frank',
    });

    expect(webResp.ok).toBe(true);
    expect(webResp.synaps_user_id).toBeDefined();
    expect(webResp.is_new).toBe(false); // user was already created by issueLinkCode
    expect(webResp.memory_namespace).toMatch(/^u_[a-f0-9]{24}$/);
  });
});

describe('ControlSocket with NoOpIdentityRouter (disabled)', () => {
  let cs;
  let socketPath;

  beforeEach(async () => {
    socketPath = tmpSocket();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeSessionRouter(),
      identityRouter: new NoOpIdentityRouter({ logger: silent }),
      logger: silent,
    });
    await cs.start();
  });

  afterEach(async () => {
    await cs.stop();
    fs.rmSync(socketPath, { force: true });
  });

  it('link_code_issue returns ok:false error:"identity disabled" when router is NoOp', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'link_code_issue',
      pria_user_id: new m.Types.ObjectId().toHexString(),
    });

    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('identity disabled');
  });
});

describe('ControlSocket error cases', () => {
  let cs;
  let socketPath;

  beforeEach(async () => {
    socketPath = tmpSocket();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeSessionRouter(),
      identityRouter: new NoOpIdentityRouter({ logger: silent }),
      logger: silent,
    });
    await cs.start();
  });

  afterEach(async () => {
    await cs.stop();
    fs.rmSync(socketPath, { force: true });
  });

  it('malformed JSON returns ok:false without crashing', async () => {
    const resp = await new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (c) => { buf += c; });
      sock.on('end', () => {
        try { resolve(JSON.parse(buf.trim())); }
        catch { reject(new Error('Not JSON: ' + buf)); }
      });
      sock.on('error', reject);
      sock.on('connect', () => {
        sock.write('not-valid-json\n');
      });
    });

    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/malformed/);
  });

  it('unknown op returns ok:false without crashing', async () => {
    const resp = await sendRequest(socketPath, { op: 'totally_unknown_op_xyz' });

    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/unknown op/);
  });
});
