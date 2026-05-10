/**
 * @file tests/scp-phase-5/03-supervisor-disabled.test.mjs
 *
 * Acceptance tests for the supervisor-disabled code paths in BridgeDaemon and
 * ScpHttpServer.
 *
 * Strategy
 * ────────
 * • BridgeDaemon tests follow the DI-stub pattern from
 *   tests/scp-phase-3/04-bridge-daemon-config-toggle.test.mjs.
 *   All subsystems except the heartbeat factory are stubbed so no real Slack,
 *   Docker, or MongoDB connections are made.
 * • supervisor.enabled = false is the BRIDGE_CONFIG_DEFAULTS posture.
 * • ScpHttpServer tests create a server WITHOUT heartbeatRepo and verify the
 *   Phase-1 backward-compat shape is returned.
 * • Custom heartbeatFactory that returns null is honoured by BridgeDaemon.
 *
 * Scenarios (4 tests)
 * ────────────────────
 * 1. BridgeDaemon with supervisor.enabled = false → daemon.supervisor === null.
 * 2. ScpHttpServer constructed without heartbeatRepo → /health returns the
 *    Phase-1 shape ({ status:'ok', mode, ts }, no `components` key).
 * 3. Custom heartbeatFactory returning null → daemon.supervisor === null
 *    (custom factory is honoured over default).
 * 4. BridgeDaemon with supervisor.enabled = false starts and stops without
 *    errors even if mongo is unreachable (heartbeats simply disabled).
 *
 * Constraints
 * ───────────
 * • ESM only (.mjs)
 * • No top-level await.
 * • No real Mongo connection needed for any BridgeDaemon test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';

import { BridgeDaemon }       from '../../bridge/index.js';
import { BRIDGE_CONFIG_DEFAULTS } from '../../bridge/config.js';
import { NoopMemoryGateway }  from '../../bridge/core/memory-gateway.js';
import { ScpHttpServer }      from '../../bridge/core/scp-http-server.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Build a minimal NormalizedConfig with supervisor.enabled explicitly set.
 * All other fields inherit BRIDGE_CONFIG_DEFAULTS.
 */
function makeConfig({ supervisorEnabled = false } = {}) {
  return {
    ...BRIDGE_CONFIG_DEFAULTS,
    bridge:     { ...BRIDGE_CONFIG_DEFAULTS.bridge },
    rpc:        { ...BRIDGE_CONFIG_DEFAULTS.rpc },
    platform:   { ...BRIDGE_CONFIG_DEFAULTS.platform },
    memory:     { ...BRIDGE_CONFIG_DEFAULTS.memory },
    identity:   { ...BRIDGE_CONFIG_DEFAULTS.identity },
    creds:      { ...BRIDGE_CONFIG_DEFAULTS.creds },
    supervisor: { ...BRIDGE_CONFIG_DEFAULTS.supervisor, enabled: supervisorEnabled },
    mongodb:    { uri: 'mongodb://127.0.0.1:27099/nonexistent' },
    sources:    {
      slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false },
    },
  };
}

/** Stub VncProxy accepted by ScpHttpServer. */
const stubVncProxy = {
  middleware: () => (_req, _res, next) => next(),
  upgrade:    () => {},
};

/** Silent logger for ScpHttpServer (no vi.fn needed). */
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * Build a BridgeDaemon with all non-supervisor subsystems mocked so no
 * real I/O occurs.  Returns { daemon, logger }.
 */
function buildDaemon({ supervisorEnabled = false, heartbeatFactory = undefined } = {}) {
  const logger = makeLogger();

  const fakeRouter = {
    start:        vi.fn(async () => {}),
    stop:         vi.fn(async () => {}),
    liveSessions: vi.fn(() => []),
    listSessions: vi.fn(async () => []),
    closeSession: vi.fn(async () => {}),
  };

  const fakeSocket = {
    start: vi.fn(async () => {}),
    stop:  vi.fn(async () => {}),
  };

  const fakeGateway = new NoopMemoryGateway();
  vi.spyOn(fakeGateway, 'start').mockResolvedValue(undefined);
  vi.spyOn(fakeGateway, 'stop').mockResolvedValue(undefined);

  const daemonOpts = {
    config:  makeConfig({ supervisorEnabled }),
    logger,
    env:     { SLACK_BOT_TOKEN: 'xoxb-fake', SLACK_APP_TOKEN: 'xapp-fake' },
    sessionRouterFactory: vi.fn(() => fakeRouter),
    slackAdapterFactory:  vi.fn(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) })),
    controlSocketFactory: vi.fn(() => fakeSocket),
    memoryGatewayFactory: () => fakeGateway,
    // identityRouterFactory defaults to NoOp when identity.enabled = false.
    // credBrokerFactory defaults to NoopCredBroker when creds.enabled = false.
  };

  if (heartbeatFactory !== undefined) {
    daemonOpts.heartbeatFactory = heartbeatFactory;
  }

  const daemon = new BridgeDaemon(daemonOpts);
  return { daemon, logger };
}

// ─── 1. supervisor.enabled = false → daemon.supervisor === null ────────────────

describe('BridgeDaemon — supervisor disabled by default', () => {
  let daemon;

  beforeEach(async () => {
    ({ daemon } = buildDaemon({ supervisorEnabled: false }));
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it('daemon.supervisor is null when supervisor.enabled = false', () => {
    expect(daemon.supervisor).toBeNull();
  });
});

// ─── 2. ScpHttpServer without heartbeatRepo → Phase-1 /health shape ───────────

describe('ScpHttpServer — no heartbeatRepo returns Phase-1 /health shape', () => {
  let server;
  let port;

  beforeEach(async () => {
    server = new ScpHttpServer({
      config:   { platform: { mode: 'scp' }, web: { http_port: 0, bind: '127.0.0.1' } },
      vncProxy: stubVncProxy,
      logger:   silent,
      // heartbeatRepo intentionally OMITTED — exercises backward-compat branch.
    });
    ({ port } = await server.start());
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns Phase-1 shape { status:"ok", mode, ts } with no components key', async () => {
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve({ statusCode: res.statusCode, body: JSON.parse(raw) }); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });

    expect(body.statusCode).toBe(200);
    expect(body.body.status).toBe('ok');
    expect(body.body.mode).toBe('scp');
    expect(body.body).toHaveProperty('ts');
    // No component table when repo is absent.
    expect(body.body).not.toHaveProperty('components');
  });
});

// ─── 3. Custom heartbeatFactory returning null is honoured ────────────────────

describe('BridgeDaemon — custom heartbeatFactory returning null', () => {
  let daemon;

  beforeEach(async () => {
    // Inject a factory that always returns null regardless of config.
    const nullFactory = vi.fn().mockResolvedValue(null);
    ({ daemon } = buildDaemon({ supervisorEnabled: true, heartbeatFactory: nullFactory }));
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it('daemon.supervisor is null when custom heartbeatFactory returns null', () => {
    expect(daemon.supervisor).toBeNull();
  });
});

// ─── 4. supervisor.enabled = false — no errors even with unreachable mongo ─────

describe('BridgeDaemon — supervisor disabled, unreachable mongo, no crash', () => {
  it('starts and stops cleanly when supervisor is off and mongo is unreachable', async () => {
    const { daemon, logger } = buildDaemon({ supervisorEnabled: false });

    await expect(daemon.start()).resolves.not.toThrow();
    expect(daemon.supervisor).toBeNull();

    await expect(daemon.stop()).resolves.not.toThrow();

    // No errors should have been logged.
    expect(logger.error).not.toHaveBeenCalled();
  });
});
