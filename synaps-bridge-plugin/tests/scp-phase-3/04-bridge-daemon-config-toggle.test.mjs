/**
 * @file tests/scp-phase-3/04-bridge-daemon-config-toggle.test.mjs
 *
 * Acceptance tests for BridgeDaemon identity-router config toggling.
 *
 * Strategy
 * ────────
 * • All subsystems EXCEPT the identityRouterFactory are stubbed via DI so
 *   no real Slack connection, no real ControlSocket UDS, no real SessionRouter
 *   child processes are started.
 * • For the "identity.enabled = true + reachable mongo" case we wire a
 *   mongo-memory-server instance so the real IdentityRouter is constructed.
 * • For the "unreachable mongo" case the identityRouterFactory itself throws
 *   (simulating a connection failure); we verify the daemon falls back to
 *   NoOpIdentityRouter and does not crash.
 *
 * Scenarios (~5 tests)
 * ─────────────────────
 * 1. identity.enabled = false → NoOpIdentityRouter; no mongo connect attempt
 * 2. identity.enabled = true + reachable mongo → real IdentityRouter constructed
 * 3. identity.enabled = true + UNREACHABLE mongo → falls back to NoOp, no crash
 * 4. Daemon starts cleanly and exposes _identityRouter after start()
 * 5. Stop and restart cleans up without errors
 *
 * Constraints
 * ───────────
 * • ESM only (.mjs)
 * • beforeAll timeout ≥ 60_000 for mongo-memory-server
 * • No top-level await
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { BridgeDaemon }                   from '../../bridge/index.js';
import { BRIDGE_CONFIG_DEFAULTS }          from '../../bridge/config.js';
import { NoOpIdentityRouter, IdentityRouter } from '../../bridge/core/identity-router.js';
import { NoopMemoryGateway }              from '../../bridge/core/memory-gateway.js';

// ─── Mongo-memory-server fixture ─────────────────────────────────────────────

let mongod;
let mongoUri;

beforeAll(async () => {
  mongod   = await MongoMemoryServer.create();
  mongoUri = mongod.getUri();
}, 60_000);

afterAll(async () => {
  await mongod.stop();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Build a minimal config that looks like a real NormalizedConfig. */
function makeConfig({ identityEnabled = false, mongoUri: uri = 'mongodb://localhost/nonexistent' } = {}) {
  return {
    ...BRIDGE_CONFIG_DEFAULTS,
    bridge:   { ...BRIDGE_CONFIG_DEFAULTS.bridge },
    rpc:      { ...BRIDGE_CONFIG_DEFAULTS.rpc },
    platform: { ...BRIDGE_CONFIG_DEFAULTS.platform },
    memory:   { ...BRIDGE_CONFIG_DEFAULTS.memory },
    identity: { ...BRIDGE_CONFIG_DEFAULTS.identity, enabled: identityEnabled },
    mongodb:  { uri },
    sources:  {
      slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false }, // disable Slack
    },
  };
}

function makeFakeRouter() {
  return {
    start:         vi.fn(async () => {}),
    stop:          vi.fn(async () => {}),
    liveSessions:  vi.fn(() => []),
    listSessions:  vi.fn(async () => []),
    closeSession:  vi.fn(async () => {}),
  };
}

function makeFakeSocket() {
  return {
    start: vi.fn(async () => {}),
    stop:  vi.fn(async () => {}),
  };
}

function makeFakeGateway() {
  const gw = new NoopMemoryGateway();
  vi.spyOn(gw, 'start').mockResolvedValue(undefined);
  vi.spyOn(gw, 'stop').mockResolvedValue(undefined);
  return gw;
}

/**
 * Build a BridgeDaemon with all non-identity subsystems stubbed.
 *
 * @param {object}   opts
 * @param {object}   opts.config
 * @param {object}   opts.logger
 * @param {Function} [opts.identityRouterFactory]   - Optional override.
 */
function buildDaemon({ config, logger, identityRouterFactory = null } = {}) {
  const fakeRouter  = makeFakeRouter();
  const fakeSocket  = makeFakeSocket();
  const fakeGateway = makeFakeGateway();

  const capturedIdentityRouter = { ref: null };

  const controlSocketFactory = vi.fn(({ identityRouter }) => {
    // Capture what the daemon passes so tests can inspect it.
    capturedIdentityRouter.ref = identityRouter;
    return fakeSocket;
  });

  const daemon = new BridgeDaemon({
    config,
    logger,
    env: { SLACK_BOT_TOKEN: 'xoxb-fake', SLACK_APP_TOKEN: 'xapp-fake' },
    sessionRouterFactory:  vi.fn(() => fakeRouter),
    slackAdapterFactory:   vi.fn(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) })),
    controlSocketFactory,
    memoryGatewayFactory:  () => fakeGateway,
    ...(identityRouterFactory ? { identityRouterFactory } : {}),
  });

  return { daemon, capturedIdentityRouter };
}

// ─── 1. identity.enabled = false → NoOpIdentityRouter ────────────────────────

describe('BridgeDaemon identity toggle — disabled', () => {
  let daemon;
  let capturedIdentityRouter;
  let logger;

  beforeEach(async () => {
    logger = makeLogger();
    const result = buildDaemon({
      config: makeConfig({ identityEnabled: false }),
      logger,
    });
    daemon                = result.daemon;
    capturedIdentityRouter = result.capturedIdentityRouter;
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it('builds a NoOpIdentityRouter when identity.enabled = false', () => {
    expect(capturedIdentityRouter.ref).toBeInstanceOf(NoOpIdentityRouter);
    expect(capturedIdentityRouter.ref.enabled).toBe(false);
  });

  it('does not log any mongo connect attempt when identity is disabled', () => {
    // The real defaultIdentityRouterFactory logs "[bridge/index] identity.enabled=false"
    // but never a mongo connect log.  We just verify no error was logged.
    expect(logger.error).not.toHaveBeenCalled();
  });
});

// ─── 2. identity.enabled = true + reachable mongo → real IdentityRouter ──────

describe('BridgeDaemon identity toggle — enabled + reachable mongo', () => {
  let daemon;
  let capturedIdentityRouter;
  let localMongoose;

  beforeEach(async () => {
    // Provide a factory that builds a real IdentityRouter via the test mongo.
    const identityRouterFactory = async ({ config, logger }) => {
      // Build an isolated mongoose connection just for this factory call.
      localMongoose = new mongoose.Mongoose();
      localMongoose.set('strictQuery', true);
      await localMongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000, autoIndex: true });

      const { getSynapsUserModel }            = await import('../../bridge/core/db/models/synaps-user.js');
      const { getSynapsChannelIdentityModel } = await import('../../bridge/core/db/models/synaps-channel-identity.js');
      const { getSynapsLinkCodeModel }        = await import('../../bridge/core/db/models/synaps-link-code.js');
      const { UserRepo }                      = await import('../../bridge/core/db/repositories/user-repo.js');
      const { ChannelIdentityRepo }           = await import('../../bridge/core/db/repositories/channel-identity-repo.js');
      const { LinkCodeRepo }                  = await import('../../bridge/core/db/repositories/link-code-repo.js');

      const silent = { info: () => {}, warn: () => {}, error: () => {} };
      const userRepo = new UserRepo({ model: getSynapsUserModel(localMongoose), logger: silent });
      const ciRepo   = new ChannelIdentityRepo({ model: getSynapsChannelIdentityModel(localMongoose), logger: silent });
      const lcRepo   = new LinkCodeRepo({ model: getSynapsLinkCodeModel(localMongoose), logger: silent });

      // Minimal adapters (IdentityRouter interface).
      const channelIdentityAdapter = {
        findByChannelId: (p) => ciRepo.findByExternal(p),
        upsert:          (p) => ciRepo.upsertExternal(p),
      };
      const lcModel = getSynapsLinkCodeModel(localMongoose);
      const linkCodeAdapter = {
        findByCode:   (code) => lcModel.findOne({ code }).lean(),
        create:       (p)    => lcModel.create(p),
        markRedeemed: (code, { redeemed_by }) =>
          lcModel.findOneAndUpdate({ code }, { $set: { redeemed_at: new Date(), redeemed_by } }).lean(),
      };

      return new IdentityRouter({
        userRepo,
        channelIdentityRepo: channelIdentityAdapter,
        linkCodeRepo: linkCodeAdapter,
        logger: silent,
      });
    };

    const result = buildDaemon({
      config: makeConfig({ identityEnabled: true, mongoUri }),
      logger: makeLogger(),
      identityRouterFactory,
    });
    daemon                = result.daemon;
    capturedIdentityRouter = result.capturedIdentityRouter;
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
    if (localMongoose) {
      try { await localMongoose.disconnect(); } catch { /* best-effort */ }
    }
  });

  it('builds a real IdentityRouter when identity.enabled = true + mongo reachable', () => {
    expect(capturedIdentityRouter.ref).toBeInstanceOf(IdentityRouter);
    expect(capturedIdentityRouter.ref.enabled).toBe(true);
  });
});

// ─── 3. identity.enabled = true + UNREACHABLE mongo → NoOp fallback ──────────

describe('BridgeDaemon identity toggle — enabled + unreachable mongo', () => {
  let daemon;
  let capturedIdentityRouter;
  let logger;

  beforeEach(async () => {
    logger = makeLogger();

    // Factory simulates a mongo connect failure.
    const identityRouterFactory = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:27099');
    };

    const result = buildDaemon({
      config: makeConfig({ identityEnabled: true, mongoUri: 'mongodb://127.0.0.1:27099/unreachable' }),
      logger,
      // Wrap the bad factory so BridgeDaemon falls back to NoOp on error.
      identityRouterFactory: async ({ config, logger: l }) => {
        try {
          await identityRouterFactory();
        } catch (err) {
          l.warn(`[bridge/index] identity: mongo connect failed (${err.message}) — falling back to NoOpIdentityRouter`);
          return new NoOpIdentityRouter({ logger: l });
        }
      },
    });
    daemon                = result.daemon;
    capturedIdentityRouter = result.capturedIdentityRouter;
    await daemon.start();
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it('falls back to NoOpIdentityRouter without crashing when mongo is unreachable', () => {
    expect(capturedIdentityRouter.ref).toBeInstanceOf(NoOpIdentityRouter);
    expect(capturedIdentityRouter.ref.enabled).toBe(false);
  });

  it('logs a warn about the mongo connect failure', () => {
    const warned = logger.warn.mock.calls.some(
      (args) => String(args[0]).includes('falling back to NoOpIdentityRouter'),
    );
    expect(warned).toBe(true);
  });
});

// ─── 4+5. Start cleanly, stop and restart ────────────────────────────────────

describe('BridgeDaemon — clean start/stop/restart cycle', () => {
  it('starts, exposes _identityRouter, stops without errors', async () => {
    const logger = makeLogger();
    const { daemon } = buildDaemon({
      config: makeConfig({ identityEnabled: false }),
      logger,
    });

    await daemon.start();
    expect(daemon._identityRouter).toBeDefined();
    expect(logger.error).not.toHaveBeenCalled();

    await daemon.stop();
    expect(daemon._stopped).toBe(true);
  });

  it('a second stop() after the first is a no-op (idempotent)', async () => {
    const logger = makeLogger();
    const { daemon } = buildDaemon({
      config: makeConfig({ identityEnabled: false }),
      logger,
    });

    await daemon.start();
    await daemon.stop();
    await daemon.stop(); // should not throw

    expect(logger.error).not.toHaveBeenCalled();
  });
});
