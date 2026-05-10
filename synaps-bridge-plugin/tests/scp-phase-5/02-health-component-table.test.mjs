/**
 * @file tests/scp-phase-5/02-health-component-table.test.mjs
 *
 * Acceptance tests for ScpHttpServer /health component-table logic wired to a
 * real HeartbeatRepo + real mongo-memory-server.
 *
 * Strategy
 * ────────
 * • MongoMemoryServer provides a real in-process MongoDB instance.
 * • ScpHttpServer is bound to port 0 (ephemeral) so tests never collide.
 * • VncProxy is stubbed with { middleware: () => null, upgrade: () => null }
 *   — its real implementation needs Docker; we only test /health here.
 * • Heartbeat rows are seeded directly via HeartbeatRepo with an injectable
 *   `now` clock so we can place them in the past without sleeping.
 * • After each test the server is stopped and the collection wiped.
 *
 * Scenarios (5 tests)
 * ────────────────────
 * 1. Empty heartbeats → status:'down', HTTP 503.
 * 2. Bridge fresh + workspace fresh → status:'ok', HTTP 200, components.length 2.
 * 3. Bridge stale (61 s old) → status:'down', HTTP 503.
 * 4. Bridge fresh + workspace stale (61 s old) → status:'degraded', HTTP 200.
 * 5. Bridge healthy but healthy:false flag set → status:'down', HTTP 503.
 *
 * Constraints
 * ───────────
 * • ESM only (.mjs)
 * • beforeAll timeout ≥ 60_000 for mongo-memory-server startup.
 * • No top-level await.
 * • Port 0 (ephemeral) to avoid conflicts.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { makeHeartbeatRepo }  from '../../bridge/core/db/index.js';
import { makeHeartbeatModel } from '../../bridge/core/db/models/synaps-heartbeat.js';
import { ScpHttpServer }      from '../../bridge/core/scp-http-server.js';

// ─── Module-level fixtures ────────────────────────────────────────────────────

let mongod;
let m;

/** Minimal config that satisfies ScpHttpServer needs. */
const baseConfig = {
  platform: { mode: 'scp' },
  web:      { http_port: 0, bind: '127.0.0.1' },
};

/**
 * Stub VncProxy — ScpHttpServer constructor requires vncProxy; we don't
 * exercise VNC routes in these tests so return no-ops.
 */
const stubVncProxy = {
  middleware: () => (_req, _res, next) => next(),
  upgrade:    () => {},
};

/** Silent logger. */
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m      = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), { serverSelectionTimeoutMS: 5_000, autoIndex: true });
}, 60_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  const Heartbeat = makeHeartbeatModel(m);
  await Heartbeat.deleteMany({});
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return a HeartbeatRepo whose clock returns `date`. */
function repoAt(date) {
  return makeHeartbeatRepo(m, { now: () => date });
}

/** Return a HeartbeatRepo using the real clock. */
function freshRepo() {
  return makeHeartbeatRepo(m);
}

/**
 * Build, start, and return a ScpHttpServer together with its ephemeral port.
 * Also returns a teardown helper.
 *
 * @param {object} [opts]
 * @param {number} [opts.bridgeCriticalMs=60_000] - Age threshold for bridge critical.
 * @returns {Promise<{ server: ScpHttpServer, port: number, teardown: Function }>}
 */
async function buildServer({ bridgeCriticalMs = 60_000 } = {}) {
  const heartbeatRepo = freshRepo();

  const server = new ScpHttpServer({
    config:          baseConfig,
    vncProxy:        stubVncProxy,
    logger:          silent,
    heartbeatRepo,
    bridgeCriticalMs,
  });

  const { port } = await server.start();

  return {
    server,
    port,
    async teardown() {
      await server.stop();
    },
  };
}

/**
 * GET /health on the given port, return { statusCode, body }.
 *
 * @param {number} port
 * @returns {Promise<{ statusCode: number, body: object }>}
 */
function getHealth(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          reject(new Error(`Could not parse /health response: ${raw}`));
        }
      });
    }).on('error', reject);
  });
}

// ─── 1. Empty heartbeats → 503 down ───────────────────────────────────────────

describe('ScpHttpServer /health — empty collection → down', () => {
  it('returns HTTP 503 + status:down when no heartbeats exist', async () => {
    const { port, teardown } = await buildServer();
    try {
      const { statusCode, body } = await getHealth(port);
      expect(statusCode).toBe(503);
      expect(body.status).toBe('down');
      expect(body.mode).toBe('scp');
      expect(body).toHaveProperty('ts');
    } finally {
      await teardown();
    }
  });
});

// ─── 2. Bridge fresh + workspace fresh → 200 ok, 2 components ─────────────────

describe('ScpHttpServer /health — all fresh → ok', () => {
  it('returns HTTP 200 + status:ok with 2 components when bridge and workspace are fresh', async () => {
    // Seed both heartbeats with a near-now timestamp (1 s ago).
    const FRESH = new Date(Date.now() - 1_000);
    await repoAt(FRESH).record({ component: 'bridge',    id: 'main',     healthy: true });
    await repoAt(FRESH).record({ component: 'workspace', id: 'ws_fresh', healthy: true });

    const { port, teardown } = await buildServer();
    try {
      const { statusCode, body } = await getHealth(port);
      expect(statusCode).toBe(200);
      expect(body.status).toBe('ok');
      expect(Array.isArray(body.components)).toBe(true);
      expect(body.components).toHaveLength(2);

      const bridge = body.components.find((c) => c.component === 'bridge');
      expect(bridge).toBeDefined();
      expect(bridge.healthy).toBe(true);
      expect(bridge.ageMs).toBeLessThan(5_000);

      const ws = body.components.find((c) => c.component === 'workspace');
      expect(ws).toBeDefined();
      expect(ws.id).toBe('ws_fresh');
    } finally {
      await teardown();
    }
  });
});

// ─── 3. Bridge stale (61 s) → 503 down ────────────────────────────────────────

describe('ScpHttpServer /health — stale bridge → down', () => {
  it('returns HTTP 503 + status:down when bridge heartbeat is 61 s old', async () => {
    const STALE_BRIDGE = new Date(Date.now() - 61_000); // 61 s ago > 60 s threshold
    await repoAt(STALE_BRIDGE).record({ component: 'bridge', id: 'main', healthy: true });

    // Use bridgeCriticalMs = 60_000 (default).
    const { port, teardown } = await buildServer({ bridgeCriticalMs: 60_000 });
    try {
      const { statusCode, body } = await getHealth(port);
      expect(statusCode).toBe(503);
      expect(body.status).toBe('down');
    } finally {
      await teardown();
    }
  });
});

// ─── 4. Bridge fresh + workspace stale → 200 degraded ─────────────────────────

describe('ScpHttpServer /health — fresh bridge + stale workspace → degraded', () => {
  it('returns HTTP 200 + status:degraded when non-critical component is stale', async () => {
    const FRESH        = new Date(Date.now() - 1_000);
    const STALE_WS     = new Date(Date.now() - 61_000); // stale relative to 60 s threshold
    await repoAt(FRESH).record({ component: 'bridge',    id: 'main',     healthy: true });
    await repoAt(STALE_WS).record({ component: 'workspace', id: 'ws_stale', healthy: true });

    const { port, teardown } = await buildServer({ bridgeCriticalMs: 60_000 });
    try {
      const { statusCode, body } = await getHealth(port);
      expect(statusCode).toBe(200);
      expect(body.status).toBe('degraded');
    } finally {
      await teardown();
    }
  });
});

// ─── 5. Bridge healthy:false → 503 down ───────────────────────────────────────

describe('ScpHttpServer /health — bridge healthy:false → down', () => {
  it('returns HTTP 503 + status:down when bridge reports healthy:false', async () => {
    const FRESH = new Date(Date.now() - 1_000);
    await repoAt(FRESH).record({ component: 'bridge', id: 'main', healthy: false });

    const { port, teardown } = await buildServer();
    try {
      const { statusCode, body } = await getHealth(port);
      expect(statusCode).toBe(503);
      expect(body.status).toBe('down');
    } finally {
      await teardown();
    }
  });
});
