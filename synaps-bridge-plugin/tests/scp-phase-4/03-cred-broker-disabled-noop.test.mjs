/**
 * @file tests/scp-phase-4/03-cred-broker-disabled-noop.test.mjs
 *
 * Acceptance tests — disabled/noop credential broker.
 *
 * Strategy
 * ────────
 * • A real BridgeDaemon is built for each test but all heavy subsystems
 *   (session router, slack adapter, memory gateway, identity router) are
 *   replaced with minimal fakes.
 * • A REAL ControlSocket is created by the daemon's controlSocketFactory so
 *   we can exercise the full wire path.
 * • The credBrokerFactory (or config) is varied per test group:
 *     A) creds.enabled = false → NoopCredBroker → op returns 'creds_disabled'
 *     B) creds.enabled = true, broker = 'noop' → same result
 *     C) unknown broker → NoopCredBroker + warn log + same result
 * • Each test starts the daemon, sends a cred_broker_use op via net.connect,
 *   asserts the response, then stops the daemon.
 *
 * Scenarios (5 tests)
 * ─────────────────────
 * 1. creds.enabled = false → daemon._credBroker is NoopCredBroker.
 * 2. creds.enabled = false → cred_broker_use op → { ok:false, code:'creds_disabled' }.
 * 3. creds.enabled = true, broker = 'noop' → same result.
 * 4. creds.enabled = true, broker = 'unknown_broker' → NoopCredBroker + warn logged.
 * 5. Daemon starts and stops cleanly (no unhandled rejections) in all cases.
 *
 * Constraints
 * ───────────
 * • ESM only (.mjs)
 * • No top-level await
 * • Real ControlSocket + UDS per test
 * • All sockets / daemon resources cleaned up in afterEach
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { BridgeDaemon, defaultCredBrokerFactory } from '../../bridge/index.js';
import { BRIDGE_CONFIG_DEFAULTS }                  from '../../bridge/config.js';
import { NoopCredBroker }                          from '../../bridge/core/cred-broker.js';
import { ControlSocket }                           from '../../bridge/control-socket.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let sockCounter = 0;

function tmpSocketPath() {
  return path.join(
    os.tmpdir(),
    `cs-phase4-noop-${process.pid}-${++sockCounter}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Minimal fake session router (ControlSocket requires it). */
function makeFakeSessionRouter() {
  return {
    start:              vi.fn(async () => {}),
    stop:               vi.fn(async () => {}),
    listSessions:       vi.fn(async () => []),
    liveSessions:       vi.fn(() => []),
    getOrCreateSession: vi.fn(async () => { throw new Error('not wired'); }),
    closeSession:       vi.fn(async () => {}),
  };
}

/** Minimal fake memory gateway. */
function makeFakeGateway() {
  return { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), enabled: false };
}

/** Minimal fake identity router. */
function makeFakeIdentityRouter() {
  return { enabled: false };
}

/**
 * Build a config with the specified [creds] overrides.
 * Slack, memory, identity are all disabled to keep the daemon minimal.
 */
function makeCredsConfig(credsOverrides = {}) {
  return {
    ...BRIDGE_CONFIG_DEFAULTS,
    bridge:   { ...BRIDGE_CONFIG_DEFAULTS.bridge },
    rpc:      { ...BRIDGE_CONFIG_DEFAULTS.rpc },
    sources:  { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false } },
    memory:   { ...BRIDGE_CONFIG_DEFAULTS.memory, enabled: false },
    identity: { ...BRIDGE_CONFIG_DEFAULTS.identity, enabled: false },
    creds:    { ...BRIDGE_CONFIG_DEFAULTS.creds, ...credsOverrides },
  };
}

/**
 * Build and start a BridgeDaemon wired for creds tests.
 *
 * - All heavy subsystems are faked.
 * - A REAL ControlSocket is created so we can exercise the wire path.
 * - Returns { daemon, socketPath, logger, stop }.
 */
async function buildAndStartDaemon({ config, credBrokerFactory = undefined } = {}) {
  const socketPath   = tmpSocketPath();
  const logger       = makeLogger();
  const _config      = config ?? makeCredsConfig();
  const fakeRouter   = makeFakeSessionRouter();
  const fakeGateway  = makeFakeGateway();
  const fakeIdRouter = makeFakeIdentityRouter();

  // Real ControlSocket — capture it so we can assert against it later.
  let builtSocket = null;
  const controlSocketFactory = (opts) => {
    builtSocket = new ControlSocket({
      socketPath,
      sessionRouter:  opts.sessionRouter,
      identityRouter: opts.identityRouter,
      credBroker:     opts.credBroker,
      logger,
    });
    return builtSocket;
  };

  const daemon = new BridgeDaemon({
    config:   _config,
    logger,
    env:      {},
    // Minimal fakes:
    sessionRouterFactory:  vi.fn(() => fakeRouter),
    slackAdapterFactory:   vi.fn(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) })),
    controlSocketFactory,
    memoryGatewayFactory:  vi.fn(() => fakeGateway),
    identityRouterFactory: vi.fn(async () => fakeIdRouter),
    // Cred broker factory (default or injected):
    credBrokerFactory,
  });

  await daemon.start();

  return {
    daemon,
    socketPath,
    logger,
    getSocket: () => builtSocket,
    async stop() {
      await daemon.stop();
      try { fs.rmSync(socketPath, { force: true }); } catch { /* best-effort */ }
    },
  };
}

/**
 * Send one JSON line over a UDS, collect the JSON response.
 */
function sendRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';

    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload) + '\n');
    });
    sock.on('data',  (c) => { buf += c; });
    sock.on('end',   () => {
      try {
        resolve(JSON.parse(buf.trim()));
      } catch {
        reject(new Error(`Bad JSON: ${buf}`));
      }
    });
    sock.on('error', reject);
  });
}

const CRED_OP = Object.freeze({
  op:             'cred_broker_use',
  synaps_user_id: 'u_noop_test',
  institution_id: 'inst_noop_001',
  key:            'github.token',
  request: { method: 'GET', url: 'https://api.github.com/user' },
});

// ─── Test 1+2: creds.enabled = false ─────────────────────────────────────────

describe('BridgeDaemon with creds.enabled = false', () => {
  let ctx;
  afterEach(async () => { if (ctx) await ctx.stop(); ctx = null; });

  it('daemon._credBroker is an instance of NoopCredBroker', async () => {
    ctx = await buildAndStartDaemon({
      config: makeCredsConfig({ enabled: false }),
    });
    expect(ctx.daemon._credBroker).toBeInstanceOf(NoopCredBroker);
  });

  it('cred_broker_use op returns { ok:false, code:"creds_disabled" } via ControlSocket', async () => {
    ctx = await buildAndStartDaemon({
      config: makeCredsConfig({ enabled: false }),
    });
    const resp = await sendRequest(ctx.socketPath, CRED_OP);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('creds_disabled');
  });
});

// ─── Test 3: creds.enabled = true, broker = 'noop' ───────────────────────────

describe('BridgeDaemon with creds.enabled = true && broker = "noop"', () => {
  let ctx;
  afterEach(async () => { if (ctx) await ctx.stop(); ctx = null; });

  it('cred_broker_use op returns { ok:false, code:"creds_disabled" }', async () => {
    ctx = await buildAndStartDaemon({
      config: makeCredsConfig({ enabled: true, broker: 'noop' }),
    });
    // daemon._credBroker must also be NoopCredBroker.
    expect(ctx.daemon._credBroker).toBeInstanceOf(NoopCredBroker);

    const resp = await sendRequest(ctx.socketPath, CRED_OP);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('creds_disabled');
  });
});

// ─── Test 4: unknown broker → NoopCredBroker + warn ──────────────────────────

describe('BridgeDaemon with unknown broker falls back to NoopCredBroker', () => {
  let ctx;
  afterEach(async () => { if (ctx) await ctx.stop(); ctx = null; });

  it('unknown broker emits a warn log mentioning the unknown value', async () => {
    const unknownBrokerConfig = {
      ...makeCredsConfig(),
      // Bypass config validation — build the raw object directly so 'vault'
      // reaches the factory unchanged (validateNormalizedConfig would reject it).
      creds: { ...BRIDGE_CONFIG_DEFAULTS.creds, enabled: true, broker: 'vault' },
    };
    ctx = await buildAndStartDaemon({ config: unknownBrokerConfig });

    // The broker must be Noop.
    expect(ctx.daemon._credBroker).toBeInstanceOf(NoopCredBroker);

    // A warn must have been emitted mentioning the unknown broker name.
    const warnCalls = ctx.logger.warn.mock.calls.map(([msg]) => msg ?? '');
    const hasUnknownWarn = warnCalls.some((msg) => msg.includes('vault') || msg.includes('NoopCredBroker'));
    expect(hasUnknownWarn).toBe(true);
  });

  it('cred_broker_use op with unknown-broker config returns { ok:false, code:"creds_disabled" }', async () => {
    const unknownBrokerConfig = {
      ...makeCredsConfig(),
      creds: { ...BRIDGE_CONFIG_DEFAULTS.creds, enabled: true, broker: 'vault' },
    };
    ctx = await buildAndStartDaemon({ config: unknownBrokerConfig });

    const resp = await sendRequest(ctx.socketPath, CRED_OP);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('creds_disabled');
  });
});

// ─── Test 5: daemon starts and stops cleanly ─────────────────────────────────

describe('BridgeDaemon graceful stop (no unhandled rejections)', () => {
  it('daemon with creds.enabled=false starts and stops without throwing', async () => {
    const ctx = await buildAndStartDaemon({
      config: makeCredsConfig({ enabled: false }),
    });

    let stopError = null;
    try {
      await ctx.stop();
    } catch (err) {
      stopError = err;
    }

    expect(stopError).toBeNull();
  });
});
