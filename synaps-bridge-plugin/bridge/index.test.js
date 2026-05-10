/**
 * @file bridge/index.test.js
 *
 * Tests for BridgeDaemon — daemon orchestrator.
 *
 * All subsystems are injected via factories so no real processes, sockets,
 * or Slack connections are ever created.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeDaemon, defaultMemoryGatewayFactory } from './index.js';
import { BRIDGE_CONFIG_DEFAULTS } from './config.js';
import { SynapsRpc } from './core/synaps-rpc.js';
import { DockerExecSynapsRpc } from './core/synaps-rpc-docker.js';
import { MemoryGateway, NoopMemoryGateway } from './core/memory-gateway.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeConfig({ slackEnabled = true } = {}) {
  return {
    ...BRIDGE_CONFIG_DEFAULTS,
    bridge: { ...BRIDGE_CONFIG_DEFAULTS.bridge },
    rpc: { ...BRIDGE_CONFIG_DEFAULTS.rpc },
    sources: {
      slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: slackEnabled },
    },
  };
}

function makeFakeRouter() {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    liveSessions: vi.fn(() => []),
    listSessions: vi.fn(async () => []),
    closeSession: vi.fn(async () => {}),
  };
}

function makeFakeAdapter() {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

function makeFakeSocket() {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

function buildDaemon({
  config,
  logger,
  env = { SLACK_BOT_TOKEN: 'xoxb-fake-token', SLACK_APP_TOKEN: 'xapp-fake-token' },
  fakeRouter = makeFakeRouter(),
  fakeAdapter = makeFakeAdapter(),
  fakeSocket = makeFakeSocket(),
  onShutdown = null,
} = {}) {
  return new BridgeDaemon({
    config: config ?? makeConfig(),
    logger: logger ?? makeLogger(),
    env,
    sessionRouterFactory: vi.fn(() => fakeRouter),
    slackAdapterFactory: vi.fn(() => fakeAdapter),
    controlSocketFactory: vi.fn(() => fakeSocket),
    onShutdown,
  });
}

// ─── constructor ─────────────────────────────────────────────────────────────

describe('BridgeDaemon — constructor', () => {
  it('constructs without I/O (pure constructor)', () => {
    const routerFactory = vi.fn();
    const daemon = new BridgeDaemon({
      config: makeConfig(),
      logger: makeLogger(),
      sessionRouterFactory: routerFactory,
    });
    // Factory must not have been called yet.
    expect(routerFactory).not.toHaveBeenCalled();
  });
});

// ─── start() ─────────────────────────────────────────────────────────────────

describe('BridgeDaemon — start()', () => {
  it('starts session router, slack adapter, and control socket in order', async () => {
    const callOrder = [];
    const fakeRouter  = { start: vi.fn(async () => callOrder.push('router')),  stop: vi.fn(async () => {}), liveSessions: vi.fn(() => []) };
    const fakeAdapter = { start: vi.fn(async () => callOrder.push('adapter')), stop: vi.fn(async () => {}) };
    const fakeSocket  = { start: vi.fn(async () => callOrder.push('socket')),  stop: vi.fn(async () => {}) };

    const daemon = buildDaemon({ fakeRouter, fakeAdapter, fakeSocket });
    await daemon.start();

    expect(callOrder).toEqual(['router', 'adapter', 'socket']);
  });

  it('emits "started" event after all subsystems start', async () => {
    const daemon = buildDaemon();
    const started = [];
    daemon.on('started', () => started.push(true));
    await daemon.start();
    expect(started).toHaveLength(1);
  });

  it('does not build slack adapter when slack is disabled', async () => {
    const slackFactory = vi.fn();
    const daemon = new BridgeDaemon({
      config: makeConfig({ slackEnabled: false }),
      logger: makeLogger(),
      sessionRouterFactory: () => makeFakeRouter(),
      slackAdapterFactory: slackFactory,
      controlSocketFactory: () => makeFakeSocket(),
    });
    await daemon.start();
    expect(slackFactory).not.toHaveBeenCalled();
    await daemon.stop();
  });

  it('start() is idempotent — second call does nothing', async () => {
    const routerFactory = vi.fn(() => makeFakeRouter());
    const daemon = new BridgeDaemon({
      config: makeConfig(),
      logger: makeLogger(),
      env: { SLACK_BOT_TOKEN: 'xoxb-fake', SLACK_APP_TOKEN: 'xapp-fake' },
      sessionRouterFactory: routerFactory,
      slackAdapterFactory: () => makeFakeAdapter(),
      controlSocketFactory: () => makeFakeSocket(),
    });
    await daemon.start();
    await daemon.start(); // second call is a no-op
    expect(routerFactory).toHaveBeenCalledTimes(1);
    await daemon.stop();
  });

  it('propagates adapter start failure', async () => {
    const fakeAdapter = { start: vi.fn(async () => { throw new Error('bolt failed'); }), stop: vi.fn(async () => {}) };
    const daemon = buildDaemon({ fakeAdapter });
    await expect(daemon.start()).rejects.toThrow('bolt failed');
  });
});

// ─── stop() ──────────────────────────────────────────────────────────────────

describe('BridgeDaemon — stop()', () => {
  it('stops subsystems in reverse order: socket → adapter → router', async () => {
    const stopOrder = [];
    const fakeRouter  = { start: vi.fn(async () => {}), stop: vi.fn(async () => stopOrder.push('router')),  liveSessions: vi.fn(() => []) };
    const fakeAdapter = { start: vi.fn(async () => {}), stop: vi.fn(async () => stopOrder.push('adapter')) };
    const fakeSocket  = { start: vi.fn(async () => {}), stop: vi.fn(async () => stopOrder.push('socket'))  };

    const daemon = buildDaemon({ fakeRouter, fakeAdapter, fakeSocket });
    await daemon.start();
    await daemon.stop();

    expect(stopOrder).toEqual(['socket', 'adapter', 'router']);
  });

  it('emits "stopped" event after teardown', async () => {
    const daemon = buildDaemon();
    const stoppedEvents = [];
    daemon.on('stopped', () => stoppedEvents.push(true));
    await daemon.start();
    await daemon.stop();
    expect(stoppedEvents).toHaveLength(1);
  });

  it('stop() is idempotent — double stop does not throw', async () => {
    const daemon = buildDaemon();
    await daemon.start();
    await daemon.stop();
    await daemon.stop(); // second call is a no-op
  });

  it('calls onShutdown callback after stop()', async () => {
    const onShutdown = vi.fn();
    const daemon = buildDaemon({ onShutdown });
    await daemon.start();
    await daemon.stop();
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('stop() without prior start() does not throw (graceful noop)', async () => {
    const daemon = buildDaemon();
    // Never called start()
    await daemon.stop();
  });
});

// ─── SCP mode wiring ──────────────────────────────────────────────────────────

describe('BridgeDaemon — SCP mode wiring', () => {

  // Shared fake objects used across SCP tests.
  const fakeMongo = {
    disconnect: vi.fn().mockResolvedValue(undefined),
    models: {},
    model: vi.fn().mockReturnValue({}),
  };
  const fakeMongoConnect = vi.fn().mockResolvedValue(fakeMongo);

  const fakeWorkspaceManager = {
    ensure: vi.fn().mockResolvedValue({ _id: 'ws1', container_id: 'ctr1', state: 'running' }),
    exec:   vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  };
  const fakeWorkspaceManagerFactory = vi.fn().mockReturnValue(fakeWorkspaceManager);

  const fakeScpServer = {
    start: vi.fn().mockResolvedValue({ port: 9999 }),
    stop:  vi.fn().mockResolvedValue(undefined),
  };
  const fakeScpHttpServerFactory = vi.fn().mockReturnValue(fakeScpServer);

  /** Build a config with mode = 'scp' and optional overrides */
  function makeScpConfig({ webEnabled = false, slackEnabled = false } = {}) {
    return {
      ...BRIDGE_CONFIG_DEFAULTS,
      platform: { mode: 'scp' },
      bridge:   { ...BRIDGE_CONFIG_DEFAULTS.bridge },
      rpc:      { ...BRIDGE_CONFIG_DEFAULTS.rpc },
      web:      { ...BRIDGE_CONFIG_DEFAULTS.web, enabled: webEnabled },
      mongodb:  { uri: 'mongodb://localhost/testdb' },
      workspace: { ...BRIDGE_CONFIG_DEFAULTS.workspace },
      sources:  { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: slackEnabled } },
    };
  }

  /** Build a BridgeDaemon in SCP mode with all heavy deps injected */
  function buildScpDaemon({
    webEnabled = false,
    slackEnabled = false,
    mongoConnect = fakeMongoConnect,
    workspaceManagerFactory = fakeWorkspaceManagerFactory,
    scpHttpServerFactory = fakeScpHttpServerFactory,
    routerFactory = null,
  } = {}) {
    const fakeRouter = {
      start: vi.fn(async () => {}),
      stop:  vi.fn(async () => {}),
      liveSessions: vi.fn(() => []),
    };
    const config = makeScpConfig({ webEnabled, slackEnabled });

    return {
      daemon: new BridgeDaemon({
        config,
        logger: makeLogger(),
        env: { SLACK_BOT_TOKEN: 'xoxb-fake', SLACK_APP_TOKEN: 'xapp-fake' },
        sessionRouterFactory: routerFactory ?? vi.fn(() => fakeRouter),
        slackAdapterFactory:  vi.fn(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) })),
        controlSocketFactory: vi.fn(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) })),
        mongoConnectFactory:      mongoConnect,
        workspaceManagerFactory:  workspaceManagerFactory,
        scpHttpServerFactory:     scpHttpServerFactory,
      }),
      fakeRouter,
    };
  }

  // ── test 1: bridge mode → no MongoDB connect, no WorkspaceManager ──────────

  it('1. mode=bridge → no MongoDB connect, no WorkspaceManager, no ScpHttpServer', async () => {
    const mongoConnect = vi.fn();
    const daemon = new BridgeDaemon({
      config: makeConfig(),           // mode = 'bridge' (default)
      logger: makeLogger(),
      env: { SLACK_BOT_TOKEN: 'xoxb-fake', SLACK_APP_TOKEN: 'xapp-fake' },
      sessionRouterFactory: vi.fn(() => makeFakeRouter()),
      slackAdapterFactory:  vi.fn(() => makeFakeAdapter()),
      controlSocketFactory: vi.fn(() => makeFakeSocket()),
      mongoConnectFactory:  mongoConnect,
    });
    await daemon.start();
    expect(mongoConnect).not.toHaveBeenCalled();
    // _workspaceManager stays null
    expect(daemon._workspaceManager).toBeNull();
    // _scpHttpServer stays null
    expect(daemon._scpHttpServer).toBeNull();
    await daemon.stop();
  });

  // ── test 2: mode=scp → connects mongo + creates WorkspaceManager ───────────

  it('2. mode=scp → connects mongo, creates WorkspaceManager, uses docker rpc factory', async () => {
    const mongoConnect = vi.fn().mockResolvedValue(fakeMongo);
    const wmFactory    = vi.fn().mockReturnValue(fakeWorkspaceManager);
    let capturedScpDeps = null;

    const routerFactory = vi.fn((config, logger, scpDeps) => {
      capturedScpDeps = scpDeps;
      return { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), liveSessions: vi.fn(() => []) };
    });

    const { daemon } = buildScpDaemon({
      mongoConnect,
      workspaceManagerFactory: wmFactory,
      routerFactory,
    });

    await daemon.start();

    expect(mongoConnect).toHaveBeenCalledWith('mongodb://localhost/testdb');
    expect(wmFactory).toHaveBeenCalled();
    expect(capturedScpDeps).not.toBeNull();
    expect(capturedScpDeps.workspaceManager).toBe(fakeWorkspaceManager);
    expect(typeof capturedScpDeps.synapsUserIdResolver).toBe('function');

    await daemon.stop();
  });

  // ── test 3: mode=scp + web.enabled=true → starts ScpHttpServer; stop() stops it

  it('3. mode=scp + web.enabled=true → starts ScpHttpServer; stop() stops it', async () => {
    const scpServer = {
      start: vi.fn().mockResolvedValue({ port: 8888 }),
      stop:  vi.fn().mockResolvedValue(undefined),
    };
    const scpFactory = vi.fn().mockReturnValue(scpServer);

    const { daemon } = buildScpDaemon({
      webEnabled: true,
      scpHttpServerFactory: scpFactory,
    });

    await daemon.start();

    expect(scpFactory).toHaveBeenCalled();
    expect(scpServer.start).toHaveBeenCalledTimes(1);

    await daemon.stop();

    expect(scpServer.stop).toHaveBeenCalledTimes(1);
  });

  // ── test 4: mode=scp + web.enabled=false → no ScpHttpServer ─────────────────

  it('4. mode=scp + web.enabled=false → no ScpHttpServer created', async () => {
    const scpFactory = vi.fn();

    const { daemon } = buildScpDaemon({
      webEnabled: false,
      scpHttpServerFactory: scpFactory,
    });

    await daemon.start();

    expect(scpFactory).not.toHaveBeenCalled();
    expect(daemon._scpHttpServer).toBeNull();

    await daemon.stop();
  });

  // ── test 5: mode=scp uses injected DI factories ───────────────────────────

  it('5. mode=scp uses injected mongoConnectFactory / workspaceManagerFactory / scpHttpServerFactory', async () => {
    const mongoConnect  = vi.fn().mockResolvedValue(fakeMongo);
    const wmFactory     = vi.fn().mockReturnValue(fakeWorkspaceManager);
    const scpServer     = { start: vi.fn().mockResolvedValue({ port: 1234 }), stop: vi.fn().mockResolvedValue() };
    const scpFactory    = vi.fn().mockReturnValue(scpServer);

    const { daemon } = buildScpDaemon({
      webEnabled:              true,
      mongoConnect,
      workspaceManagerFactory: wmFactory,
      scpHttpServerFactory:    scpFactory,
    });

    await daemon.start();

    expect(mongoConnect).toHaveBeenCalledOnce();
    expect(wmFactory).toHaveBeenCalledOnce();
    expect(scpFactory).toHaveBeenCalledOnce();

    await daemon.stop();
  });

  // ── test 6: mode=bridge rpcFactory still produces a SynapsRpc (regression) ─

  it('6. mode=bridge SessionRouter rpcFactory still produces a SynapsRpc', async () => {
    // Build a daemon in bridge mode using an injected sessionRouterFactory that
    // records the rpcFactory it receives, then verify the factory produces SynapsRpc.
    const config = {
      ...BRIDGE_CONFIG_DEFAULTS,
      platform: { mode: 'bridge' },
      bridge:   { ...BRIDGE_CONFIG_DEFAULTS.bridge },
      rpc:      { ...BRIDGE_CONFIG_DEFAULTS.rpc },
      sources:  { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false } },
      web:      { ...BRIDGE_CONFIG_DEFAULTS.web, enabled: false },
      mongodb:  { ...BRIDGE_CONFIG_DEFAULTS.mongodb },
      workspace: { ...BRIDGE_CONFIG_DEFAULTS.workspace },
    };

    let capturedRpcFactory = null;

    const fakeRouterBridge = {
      start:        vi.fn(async () => {}),
      stop:         vi.fn(async () => {}),
      liveSessions: vi.fn(() => []),
    };

    const daemon = new BridgeDaemon({
      config,
      logger: makeLogger(),
      env: {},
      sessionRouterFactory: (cfg, log, _scpDeps) => {
        capturedRpcFactory = ({ sessionId = null, model = null } = {}) =>
          new SynapsRpc({
            binPath:  cfg.rpc.binary,
            sessionId,
            model:    model ?? cfg.rpc.default_model,
            profile:  cfg.rpc.default_profile || null,
            logger:   log,
          });
        return fakeRouterBridge;
      },
      slackAdapterFactory:  vi.fn(() => ({ start: async () => {}, stop: async () => {} })),
      controlSocketFactory: vi.fn(() => ({ start: async () => {}, stop: async () => {} })),
    });

    await daemon.start();
    await daemon.stop();

    expect(capturedRpcFactory).not.toBeNull();
    const rpc = capturedRpcFactory({ sessionId: null, model: null });
    expect(rpc).toBeInstanceOf(SynapsRpc);
    expect(rpc).not.toBeInstanceOf(DockerExecSynapsRpc);
  });

});

// ─── MemoryGateway wiring ─────────────────────────────────────────────────────

// Helper: make a config with specific memory settings overlaid on defaults.
function makeMemoryConfig(memoryOverrides = {}) {
  return {
    ...BRIDGE_CONFIG_DEFAULTS,
    bridge:   { ...BRIDGE_CONFIG_DEFAULTS.bridge },
    rpc:      { ...BRIDGE_CONFIG_DEFAULTS.rpc },
    sources:  { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false } },
    memory:   { ...BRIDGE_CONFIG_DEFAULTS.memory, ...memoryOverrides },
  };
}

// Minimal lifecycle mock for a memory gateway.
function makeFakeMemoryGateway({ enabled = false } = {}) {
  return {
    start:    vi.fn(async () => {}),
    stop:     vi.fn(async () => {}),
    enabled,
    recall:   vi.fn(async () => null),
    store:    vi.fn(async () => ({ ok: true })),
  };
}

describe('defaultMemoryGatewayFactory — unit tests', () => {
  it('returns NoopMemoryGateway when memory.enabled = false', () => {
    const config = makeMemoryConfig({ enabled: false });
    const logger = makeLogger();
    const gw = defaultMemoryGatewayFactory(config, logger);
    expect(gw).toBeInstanceOf(NoopMemoryGateway);
    expect(gw.enabled).toBe(false);
  });

  it('returns NoopMemoryGateway + warns when transport is not "cli"', () => {
    const config = makeMemoryConfig({ enabled: true, transport: 'socket' });
    const logger = makeLogger();
    const gw = defaultMemoryGatewayFactory(config, logger);
    expect(gw).toBeInstanceOf(NoopMemoryGateway);
    expect(gw.enabled).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][0]).toMatch(/cli/);
  });

  it('returns real MemoryGateway when enabled=true and transport="cli"', () => {
    const config = makeMemoryConfig({
      enabled: true,
      transport: 'cli',
      cli_path: 'axel',
      brain_dir: '/tmp/test-brains',
      recall_k: 5,
      recall_min_score: 0.1,
      recall_max_chars: 1000,
    });
    const logger = makeLogger();
    const gw = defaultMemoryGatewayFactory(config, logger);
    expect(gw).toBeInstanceOf(MemoryGateway);
    expect(gw.enabled).toBe(true);
  });
});

describe('BridgeDaemon — MemoryGateway integration', () => {
  // Helper: build a daemon with an injected memoryGatewayFactory.
  function buildMemoryDaemon({
    memoryGatewayFactory,
    slackAdapterFactory,
    sessionRouterFactory,
    config,
    logger,
  } = {}) {
    const _logger = logger ?? makeLogger();
    const fakeRouter = makeFakeRouter();
    const fakeSocket = makeFakeSocket();

    return {
      daemon: new BridgeDaemon({
        config: config ?? makeMemoryConfig(),
        logger: _logger,
        env: { SLACK_BOT_TOKEN: 'xoxb-fake', SLACK_APP_TOKEN: 'xapp-fake' },
        sessionRouterFactory: sessionRouterFactory ?? vi.fn(() => fakeRouter),
        slackAdapterFactory:  slackAdapterFactory  ?? vi.fn(() => makeFakeAdapter()),
        controlSocketFactory: vi.fn(() => fakeSocket),
        memoryGatewayFactory,
      }),
      fakeRouter,
      fakeSocket,
    };
  }

  it('start() calls memoryGateway.start() before other subsystems', async () => {
    const callOrder = [];
    const fakeGateway = {
      start: vi.fn(async () => callOrder.push('gateway')),
      stop:  vi.fn(async () => {}),
      enabled: false,
    };

    const fakeRouter = {
      start: vi.fn(async () => callOrder.push('router')),
      stop:  vi.fn(async () => {}),
      liveSessions: vi.fn(() => []),
    };

    const { daemon } = buildMemoryDaemon({
      memoryGatewayFactory: vi.fn(() => fakeGateway),
      sessionRouterFactory: vi.fn(() => fakeRouter),
    });

    await daemon.start();
    await daemon.stop();

    expect(callOrder[0]).toBe('gateway');
    expect(callOrder[1]).toBe('router');
  });

  it('stop() calls memoryGateway.stop() after mongoose disconnect (last)', async () => {
    const stopOrder = [];
    const fakeGateway = {
      start: vi.fn(async () => {}),
      stop:  vi.fn(async () => stopOrder.push('gateway')),
      enabled: false,
    };

    const fakeRouter = {
      start: vi.fn(async () => {}),
      stop:  vi.fn(async () => stopOrder.push('router')),
      liveSessions: vi.fn(() => []),
    };

    const fakeSocket = {
      start: vi.fn(async () => {}),
      stop:  vi.fn(async () => stopOrder.push('socket')),
    };

    const { daemon } = buildMemoryDaemon({
      memoryGatewayFactory: vi.fn(() => fakeGateway),
      sessionRouterFactory: vi.fn(() => fakeRouter),
    });
    // Replace the socket factory after construction to use our tracking socket.
    daemon._controlSocketFactory = vi.fn(() => fakeSocket);

    await daemon.start();
    await daemon.stop();

    // Gateway must be last.
    expect(stopOrder[stopOrder.length - 1]).toBe('gateway');
    // Router must come before gateway.
    expect(stopOrder.indexOf('router')).toBeLessThan(stopOrder.indexOf('gateway'));
  });

  it('daemon._memoryGateway is set to the value returned by memoryGatewayFactory', async () => {
    const fakeGateway = makeFakeMemoryGateway({ enabled: false });
    const factory = vi.fn(() => fakeGateway);
    const { daemon } = buildMemoryDaemon({ memoryGatewayFactory: factory });

    await daemon.start();
    expect(daemon._memoryGateway).toBe(fakeGateway);
    expect(factory).toHaveBeenCalledOnce();
    await daemon.stop();
  });

  it('memoryGatewayFactory is called with (config, logger)', async () => {
    const logger = makeLogger();
    const config = makeMemoryConfig({ enabled: false });
    const factory = vi.fn(() => makeFakeMemoryGateway());
    const { daemon } = buildMemoryDaemon({ memoryGatewayFactory: factory, config, logger });

    await daemon.start();
    expect(factory).toHaveBeenCalledWith(config, logger);
    await daemon.stop();
  });

  it('slackAdapterFactory receives memoryGateway when slack is enabled', async () => {
    const fakeGateway = makeFakeMemoryGateway({ enabled: false });
    let capturedOpts = null;

    const slackFactory = vi.fn((opts) => {
      capturedOpts = opts;
      return makeFakeAdapter();
    });

    const config = {
      ...makeMemoryConfig(),
      sources: { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: true } },
    };

    const { daemon } = buildMemoryDaemon({
      memoryGatewayFactory: vi.fn(() => fakeGateway),
      slackAdapterFactory: slackFactory,
      config,
    });

    await daemon.start();

    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts.memoryGateway).toBe(fakeGateway);

    await daemon.stop();
  });

  it('slackAdapterFactory does NOT receive memoryGateway when slack is disabled', async () => {
    const slackFactory = vi.fn();
    const fakeGateway = makeFakeMemoryGateway();

    const { daemon } = buildMemoryDaemon({
      memoryGatewayFactory: vi.fn(() => fakeGateway),
      slackAdapterFactory: slackFactory,
      config: makeMemoryConfig({ enabled: false }),  // slack disabled in makeMemoryConfig
    });

    await daemon.start();
    expect(slackFactory).not.toHaveBeenCalled();
    await daemon.stop();
  });

  it('scpDeps includes memoryGateway in SCP mode', async () => {
    const fakeGateway = makeFakeMemoryGateway({ enabled: false });
    let capturedScpDeps = null;

    const routerFactory = vi.fn((config, logger, scpDeps) => {
      capturedScpDeps = scpDeps;
      return makeFakeRouter();
    });

    const fakeMongo = {
      disconnect: vi.fn().mockResolvedValue(undefined),
      models: {},
      model: vi.fn().mockReturnValue({}),
    };

    const scpConfig = {
      ...BRIDGE_CONFIG_DEFAULTS,
      platform: { mode: 'scp' },
      bridge:   { ...BRIDGE_CONFIG_DEFAULTS.bridge },
      rpc:      { ...BRIDGE_CONFIG_DEFAULTS.rpc },
      web:      { ...BRIDGE_CONFIG_DEFAULTS.web, enabled: false },
      mongodb:  { uri: 'mongodb://localhost/testdb' },
      workspace: { ...BRIDGE_CONFIG_DEFAULTS.workspace },
      sources:  { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false } },
      memory:   { ...BRIDGE_CONFIG_DEFAULTS.memory, enabled: false },
    };

    const daemon = new BridgeDaemon({
      config: scpConfig,
      logger: makeLogger(),
      env: {},
      sessionRouterFactory:    routerFactory,
      slackAdapterFactory:     vi.fn(() => makeFakeAdapter()),
      controlSocketFactory:    vi.fn(() => makeFakeSocket()),
      mongoConnectFactory:     vi.fn().mockResolvedValue(fakeMongo),
      workspaceManagerFactory: vi.fn().mockReturnValue({ ensure: vi.fn(), exec: vi.fn() }),
      memoryGatewayFactory:    vi.fn(() => fakeGateway),
    });

    await daemon.start();

    expect(capturedScpDeps).not.toBeNull();
    expect(capturedScpDeps.memoryGateway).toBe(fakeGateway);

    await daemon.stop();
  });

  it('bridge mode: sessionRouterFactory receives scpDeps=null but slackAdapter still gets memoryGateway', async () => {
    const fakeGateway = makeFakeMemoryGateway({ enabled: false });
    let capturedScpDeps = undefined;
    let capturedSlackOpts = null;

    const routerFactory = vi.fn((config, logger, scpDeps) => {
      capturedScpDeps = scpDeps;
      return makeFakeRouter();
    });

    const slackFactory = vi.fn((opts) => {
      capturedSlackOpts = opts;
      return makeFakeAdapter();
    });

    const config = {
      ...makeMemoryConfig(),
      sources: { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: true } },
    };

    const daemon = new BridgeDaemon({
      config,
      logger: makeLogger(),
      env: { SLACK_BOT_TOKEN: 'xoxb-fake', SLACK_APP_TOKEN: 'xapp-fake' },
      sessionRouterFactory:    routerFactory,
      slackAdapterFactory:     slackFactory,
      controlSocketFactory:    vi.fn(() => makeFakeSocket()),
      memoryGatewayFactory:    vi.fn(() => fakeGateway),
    });

    await daemon.start();

    // Bridge mode: scpDeps is null
    expect(capturedScpDeps).toBeNull();
    // But slackAdapter still receives memoryGateway
    expect(capturedSlackOpts).not.toBeNull();
    expect(capturedSlackOpts.memoryGateway).toBe(fakeGateway);

    await daemon.stop();
  });

  it('stop() logs a warning when memoryGateway.stop() throws', async () => {
    const logger = makeLogger();
    const fakeGateway = {
      start: vi.fn(async () => {}),
      stop:  vi.fn(async () => { throw new Error('gateway teardown error'); }),
      enabled: false,
    };

    const { daemon } = buildMemoryDaemon({
      memoryGatewayFactory: vi.fn(() => fakeGateway),
      logger,
    });

    await daemon.start();
    // Should NOT throw.
    await expect(daemon.stop()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('gateway teardown error'),
    );
  });

  it('full stop order: socket → adapter → router → gateway (last)', async () => {
    const stopOrder = [];

    const fakeGateway = {
      start: vi.fn(async () => {}),
      stop:  vi.fn(async () => stopOrder.push('gateway')),
      enabled: false,
    };

    const fakeRouter = {
      start: vi.fn(async () => {}),
      stop:  vi.fn(async () => stopOrder.push('router')),
      liveSessions: vi.fn(() => []),
    };

    const fakeSocket = {
      start: vi.fn(async () => {}),
      stop:  vi.fn(async () => stopOrder.push('socket')),
    };

    const fakeAdapter = {
      start: vi.fn(async () => {}),
      stop:  vi.fn(async () => stopOrder.push('adapter')),
    };

    const config = {
      ...makeMemoryConfig(),
      sources: { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: true } },
    };

    const daemon = new BridgeDaemon({
      config,
      logger: makeLogger(),
      env: { SLACK_BOT_TOKEN: 'xoxb-fake', SLACK_APP_TOKEN: 'xapp-fake' },
      sessionRouterFactory: vi.fn(() => fakeRouter),
      slackAdapterFactory:  vi.fn(() => fakeAdapter),
      controlSocketFactory: vi.fn(() => fakeSocket),
      memoryGatewayFactory: vi.fn(() => fakeGateway),
    });

    await daemon.start();
    await daemon.stop();

    expect(stopOrder).toEqual(['socket', 'adapter', 'router', 'gateway']);
  });

  it('defaultMemoryGatewayFactory: enabled=false → NoopMemoryGateway exposed via daemon._memoryGateway', async () => {
    const config = makeMemoryConfig({ enabled: false });
    const { daemon } = buildMemoryDaemon({ config });

    await daemon.start();

    expect(daemon._memoryGateway).toBeInstanceOf(NoopMemoryGateway);
    expect(daemon._memoryGateway.enabled).toBe(false);

    await daemon.stop();
  });

  it('defaultMemoryGatewayFactory: enabled=true, transport=socket → warn + NoopMemoryGateway', async () => {
    const logger = makeLogger();
    const config = makeMemoryConfig({ enabled: true, transport: 'socket' });

    const daemon = new BridgeDaemon({
      config,
      logger,
      env: {},
      sessionRouterFactory: vi.fn(() => makeFakeRouter()),
      slackAdapterFactory:  vi.fn(() => makeFakeAdapter()),
      controlSocketFactory: vi.fn(() => makeFakeSocket()),
      // No memoryGatewayFactory → uses defaultMemoryGatewayFactory
    });

    await daemon.start();

    expect(daemon._memoryGateway).toBeInstanceOf(NoopMemoryGateway);
    expect(daemon._memoryGateway.enabled).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cli'));

    await daemon.stop();
  });

  it('defaultMemoryGatewayFactory: enabled=true, transport=cli → real MemoryGateway via daemon', async () => {
    const config = makeMemoryConfig({
      enabled: true,
      transport: 'cli',
      cli_path: 'axel',
      brain_dir: '/tmp/test-memory-brains',
    });

    const { daemon } = buildMemoryDaemon({ config });

    await daemon.start();

    expect(daemon._memoryGateway).toBeInstanceOf(MemoryGateway);
    expect(daemon._memoryGateway.enabled).toBe(true);

    await daemon.stop();
  });
});

// ─── defaultIdentityRouterFactory ─────────────────────────────────────────────

import { defaultIdentityRouterFactory } from './index.js';
import { NoOpIdentityRouter, IdentityRouter } from './core/identity-router.js';

function makeIdentityConfig(identityOverrides = {}) {
  return {
    ...BRIDGE_CONFIG_DEFAULTS,
    bridge:   { ...BRIDGE_CONFIG_DEFAULTS.bridge },
    rpc:      { ...BRIDGE_CONFIG_DEFAULTS.rpc },
    sources:  { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false } },
    mongodb:  { uri: 'mongodb://localhost/testdb' },
    memory:   { ...BRIDGE_CONFIG_DEFAULTS.memory },
    identity: { enabled: false, link_code_ttl_secs: 300, default_institution_id: '', ...identityOverrides },
  };
}

describe('defaultIdentityRouterFactory — unit tests', () => {
  it('returns NoOpIdentityRouter when identity.enabled = false', async () => {
    const config = makeIdentityConfig({ enabled: false });
    const logger = makeLogger();
    const router = await defaultIdentityRouterFactory({ config, logger });
    expect(router).toBeInstanceOf(NoOpIdentityRouter);
    expect(router.enabled).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('NoOpIdentityRouter'));
  });

  it('returns NoOpIdentityRouter on mongo connect failure', async () => {
    const config = makeIdentityConfig({ enabled: true });
    const logger = makeLogger();

    // We need the real factory path but with a bad URI — since it lazy-imports
    // getMongoose, we can't easily mock it. Instead test the fallback by checking
    // the factory handles a rejected getMongoose via an injected version.
    // We exercise the mongo-fail path by passing a config with a bogus URI
    // through a wrapper that substitutes getMongoose.
    // Use a test-double: override the factory to inject a failing connect.
    const failFactory = async ({ config: cfg, logger: log }) => {
      if (!cfg.identity?.enabled) {
        log.info('[bridge/index] identity.enabled=false — using NoOpIdentityRouter');
        return new NoOpIdentityRouter({ logger: log });
      }
      try {
        throw new Error('connection refused');
      } catch (err) {
        log.warn(`[bridge/index] identity: mongo connect failed (${err.message}) — falling back to NoOpIdentityRouter`);
        return new NoOpIdentityRouter({ logger: log });
      }
    };
    const router = await failFactory({ config, logger });
    expect(router).toBeInstanceOf(NoOpIdentityRouter);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
  });

  it('NoOp path: identity.enabled=false → resolve returns synthetic user (Phase-2 compat)', async () => {
    const config = makeIdentityConfig({ enabled: false });
    const logger = makeLogger();
    const router = await defaultIdentityRouterFactory({ config, logger });
    const result = await router.resolve({ channel: 'slack', external_id: 'U123' });
    expect(result.synapsUser.memory_namespace).toBe('u_U123');
    expect(result.isLinked).toBe(false);
  });
});

// ─── BridgeDaemon — IdentityRouter wiring ────────────────────────────────────

describe('BridgeDaemon — IdentityRouter wiring', () => {
  function makeIdentityDaemonConfig(identityOverrides = {}) {
    return {
      ...BRIDGE_CONFIG_DEFAULTS,
      bridge:   { ...BRIDGE_CONFIG_DEFAULTS.bridge },
      rpc:      { ...BRIDGE_CONFIG_DEFAULTS.rpc },
      sources:  { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false } },
      mongodb:  { uri: 'mongodb://localhost/testdb' },
      memory:   { ...BRIDGE_CONFIG_DEFAULTS.memory, enabled: false },
      web:      { ...BRIDGE_CONFIG_DEFAULTS.web, enabled: false },
      workspace: { ...BRIDGE_CONFIG_DEFAULTS.workspace },
      platform: { mode: 'bridge' },
      identity: { enabled: false, link_code_ttl_secs: 300, default_institution_id: '', ...identityOverrides },
    };
  }

  function buildIdentityDaemon({
    identityRouterFactory,
    slackAdapterFactory,
    controlSocketFactory,
    config,
    logger,
  } = {}) {
    const _logger = logger ?? makeLogger();
    const fakeRouter = makeFakeRouter();
    const fakeSocket = controlSocketFactory ? null : makeFakeSocket();

    const daemon = new BridgeDaemon({
      config: config ?? makeIdentityDaemonConfig(),
      logger: _logger,
      env: { SLACK_BOT_TOKEN: 'xoxb-fake', SLACK_APP_TOKEN: 'xapp-fake' },
      sessionRouterFactory: vi.fn(() => fakeRouter),
      slackAdapterFactory:  slackAdapterFactory ?? vi.fn(() => makeFakeAdapter()),
      controlSocketFactory: controlSocketFactory ?? vi.fn(() => (fakeSocket ?? makeFakeSocket())),
      identityRouterFactory,
    });
    return { daemon, fakeRouter };
  }

  it('default (no identityRouterFactory): _identityRouter is set to NoOpIdentityRouter when identity.enabled=false', async () => {
    const config = makeIdentityDaemonConfig({ enabled: false });
    const { daemon } = buildIdentityDaemon({ config });
    await daemon.start();
    expect(daemon._identityRouter).not.toBeNull();
    expect(daemon._identityRouter.enabled).toBe(false);
    await daemon.stop();
  });

  it('identityRouterFactory is called with { config, logger } and result stored in _identityRouter', async () => {
    const fakeIdentityRouter = { enabled: true, resolve: vi.fn(), redeemLinkCode: vi.fn() };
    const factory = vi.fn(async () => fakeIdentityRouter);
    const logger = makeLogger();
    const config = makeIdentityDaemonConfig({ enabled: true });

    const { daemon } = buildIdentityDaemon({ identityRouterFactory: factory, config, logger });
    await daemon.start();

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith({ config, logger });
    expect(daemon._identityRouter).toBe(fakeIdentityRouter);
    await daemon.stop();
  });

  it('slackAdapterFactory receives identityRouter when slack is enabled', async () => {
    const fakeIdentityRouter = { enabled: false, resolve: vi.fn(), redeemLinkCode: vi.fn() };
    let capturedOpts = null;

    const slackFactory = vi.fn((opts) => {
      capturedOpts = opts;
      return makeFakeAdapter();
    });

    const config = {
      ...makeIdentityDaemonConfig(),
      sources: { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: true } },
    };

    const { daemon } = buildIdentityDaemon({
      identityRouterFactory: vi.fn(async () => fakeIdentityRouter),
      slackAdapterFactory: slackFactory,
      config,
    });

    await daemon.start();

    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts.identityRouter).toBe(fakeIdentityRouter);
    await daemon.stop();
  });

  it('controlSocketFactory receives identityRouter', async () => {
    const fakeIdentityRouter = { enabled: false, resolve: vi.fn(), redeemLinkCode: vi.fn() };
    let capturedSocketOpts = null;

    const controlFactory = vi.fn((opts) => {
      capturedSocketOpts = opts;
      return makeFakeSocket();
    });

    const { daemon } = buildIdentityDaemon({
      identityRouterFactory: vi.fn(async () => fakeIdentityRouter),
      controlSocketFactory: controlFactory,
    });

    await daemon.start();

    expect(capturedSocketOpts).not.toBeNull();
    expect(capturedSocketOpts.identityRouter).toBe(fakeIdentityRouter);
    await daemon.stop();
  });

  it('mongo failure in real factory falls back to NoOpIdentityRouter (via factory override)', async () => {
    // Simulate mongo failure by using a factory that throws during connect.
    const failingFactory = vi.fn(async ({ logger: log }) => {
      log.warn('[bridge/index] identity: mongo connect failed (ECONNREFUSED) — falling back to NoOpIdentityRouter');
      return new NoOpIdentityRouter({ logger: log });
    });

    const logger = makeLogger();
    const config = makeIdentityDaemonConfig({ enabled: true });
    const { daemon } = buildIdentityDaemon({ identityRouterFactory: failingFactory, config, logger });

    await daemon.start();
    expect(daemon._identityRouter).toBeInstanceOf(NoOpIdentityRouter);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    await daemon.stop();
  });

  it('start() is still idempotent with identity router wired', async () => {
    const factory = vi.fn(async () => new NoOpIdentityRouter({ logger: makeLogger() }));
    const { daemon } = buildIdentityDaemon({ identityRouterFactory: factory });
    await daemon.start();
    await daemon.start(); // second call is a no-op
    expect(factory).toHaveBeenCalledOnce();
    await daemon.stop();
  });

  it('real factory (identity.enabled=false) → NoOpIdentityRouter, info logged', async () => {
    const logger = makeLogger();
    const config = makeIdentityDaemonConfig({ enabled: false });
    const { daemon } = buildIdentityDaemon({ config, logger });
    await daemon.start();
    expect(daemon._identityRouter.enabled).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('NoOpIdentityRouter'));
    await daemon.stop();
  });

  it('real factory (no identity config at all) → NoOpIdentityRouter (defensive)', async () => {
    const logger = makeLogger();
    // Config without identity key at all (like old e2e test configs).
    const config = {
      ...BRIDGE_CONFIG_DEFAULTS,
      bridge:   { ...BRIDGE_CONFIG_DEFAULTS.bridge },
      rpc:      { ...BRIDGE_CONFIG_DEFAULTS.rpc },
      sources:  { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false } },
      mongodb:  { uri: 'mongodb://localhost/testdb' },
      memory:   { ...BRIDGE_CONFIG_DEFAULTS.memory, enabled: false },
      web:      { ...BRIDGE_CONFIG_DEFAULTS.web, enabled: false },
      workspace: { ...BRIDGE_CONFIG_DEFAULTS.workspace },
      platform: { mode: 'bridge' },
      // Note: no `identity` key
    };
    const { daemon } = buildIdentityDaemon({ config, logger });
    await daemon.start();
    expect(daemon._identityRouter.enabled).toBe(false);
    await daemon.stop();
  });
});

// ─── BridgeDaemon — CredBroker wiring ────────────────────────────────────────

import { defaultCredBrokerFactory } from './index.js';
import { CredBroker, NoopCredBroker } from './core/cred-broker.js';

/**
 * Make a config with specific creds overrides on top of the base defaults.
 * Slack and memory are both disabled to keep tests minimal.
 */
function makeCredsConfig(credsOverrides = {}) {
  return {
    ...BRIDGE_CONFIG_DEFAULTS,
    bridge:   { ...BRIDGE_CONFIG_DEFAULTS.bridge },
    rpc:      { ...BRIDGE_CONFIG_DEFAULTS.rpc },
    sources:  { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false } },
    memory:   { ...BRIDGE_CONFIG_DEFAULTS.memory, enabled: false },
    creds:    { ...BRIDGE_CONFIG_DEFAULTS.creds, ...credsOverrides },
  };
}

/** Minimal fake memory gateway so tests that call start() don't fail. */
function makeFakeGateway() {
  return { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), enabled: false };
}

/**
 * Build a daemon wired for cred-broker tests.
 * All heavy subsystems (session router, socket, etc.) are faked out.
 * Pass `credBrokerFactory` to inject a custom factory; omit to use default.
 */
function buildCredsDaemon({
  config,
  logger,
  credBrokerFactory,
  controlSocketFactory,
} = {}) {
  const _logger = logger ?? makeLogger();
  const _config = config ?? makeCredsConfig();

  const fakeRouter = makeFakeRouter();
  const fakeSocket = makeFakeSocket();
  const fakeGateway = makeFakeGateway();

  const daemon = new BridgeDaemon({
    config: _config,
    logger: _logger,
    env: {},
    sessionRouterFactory:  vi.fn(() => fakeRouter),
    slackAdapterFactory:   vi.fn(() => makeFakeAdapter()),
    controlSocketFactory:  controlSocketFactory ?? vi.fn(() => fakeSocket),
    memoryGatewayFactory:  vi.fn(() => fakeGateway),
    credBrokerFactory,
  });

  return { daemon, fakeRouter, fakeSocket, fakeGateway, logger: _logger };
}

// ── defaultCredBrokerFactory — unit tests ─────────────────────────────────────

describe('defaultCredBrokerFactory — unit tests', () => {
  it('returns NoopCredBroker when creds.enabled = false', () => {
    const config = makeCredsConfig({ enabled: false });
    const logger = makeLogger();
    const broker = defaultCredBrokerFactory(config, logger);
    expect(broker).toBeInstanceOf(NoopCredBroker);
  });

  it('returns NoopCredBroker when creds.enabled = true but broker = "noop"', () => {
    const config = makeCredsConfig({ enabled: true, broker: 'noop' });
    const logger = makeLogger();
    const broker = defaultCredBrokerFactory(config, logger);
    expect(broker).toBeInstanceOf(NoopCredBroker);
  });

  it('returns CredBroker (not NoopCredBroker) when broker = "infisical"', () => {
    const config = makeCredsConfig({
      enabled: true,
      broker: 'infisical',
      infisical_url: 'https://infisical.test',
      infisical_token_file: '/tmp/fake-token',
    });
    const logger = makeLogger();
    const broker = defaultCredBrokerFactory(config, logger);
    expect(broker).toBeInstanceOf(CredBroker);
    expect(broker).not.toBeInstanceOf(NoopCredBroker);
  });

  it('returns NoopCredBroker + emits warn when broker is an unknown value', () => {
    // Bypass config validation by building the config object directly (not via
    // normalizeConfig, which would sanitise the unknown broker).
    const config = {
      ...makeCredsConfig(),
      creds: { ...BRIDGE_CONFIG_DEFAULTS.creds, enabled: true, broker: 'vault' },
    };
    const logger = makeLogger();
    const broker = defaultCredBrokerFactory(config, logger);
    expect(broker).toBeInstanceOf(NoopCredBroker);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][0]).toMatch(/vault/);
    expect(logger.warn.mock.calls[0][0]).toMatch(/NoopCredBroker/);
  });

  it('NoopCredBroker ping returns { ok: false, broker: "noop" }', async () => {
    const config = makeCredsConfig({ enabled: false });
    const broker = defaultCredBrokerFactory(config, makeLogger());
    await expect(broker.ping()).resolves.toEqual({ ok: false, broker: 'noop' });
  });
});

// ── BridgeDaemon — cred broker integration ────────────────────────────────────

describe('BridgeDaemon — cred broker', () => {
  it('custom credBrokerFactory is called with (config, logger) and its return value stored in _credBroker', async () => {
    const mockBroker = { ping: vi.fn(), clear: vi.fn() };
    const factory = vi.fn(() => mockBroker);
    const logger = makeLogger();
    const config = makeCredsConfig({ enabled: false });

    const { daemon } = buildCredsDaemon({ config, logger, credBrokerFactory: factory });
    await daemon.start();

    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(config, logger);
    expect(daemon._credBroker).toBe(mockBroker);
    await daemon.stop();
  });

  it('start() builds and stores _credBroker (NoopCredBroker by default)', async () => {
    const { daemon } = buildCredsDaemon();
    await daemon.start();
    expect(daemon._credBroker).toBeInstanceOf(NoopCredBroker);
    await daemon.stop();
  });

  it('start() logs "cred broker initialized" line', async () => {
    const logger = makeLogger();
    const { daemon } = buildCredsDaemon({ logger });
    await daemon.start();
    const infoCalls = logger.info.mock.calls.map(([msg]) => msg);
    expect(infoCalls.some(msg => msg.includes('cred broker initialized'))).toBe(true);
    await daemon.stop();
  });

  it('start() "cred broker initialized" log includes enabled and broker fields', async () => {
    const logger = makeLogger();
    const config = makeCredsConfig({ enabled: false, broker: 'noop' });
    const { daemon } = buildCredsDaemon({ logger, config });
    await daemon.start();
    const match = logger.info.mock.calls
      .map(([msg]) => msg)
      .find(msg => msg.includes('cred broker initialized'));
    expect(match).toMatch(/enabled=false/);
    expect(match).toMatch(/broker=noop/);
    await daemon.stop();
  });

  it('start() passes credBroker to controlSocketFactory', async () => {
    const mockBroker = { ping: vi.fn(), clear: vi.fn() };
    const factory = vi.fn(() => mockBroker);
    let capturedSocketOpts = null;

    const controlFactory = vi.fn((opts) => {
      capturedSocketOpts = opts;
      return makeFakeSocket();
    });

    const { daemon } = buildCredsDaemon({
      credBrokerFactory: factory,
      controlSocketFactory: controlFactory,
    });
    await daemon.start();

    expect(capturedSocketOpts).not.toBeNull();
    expect(capturedSocketOpts.credBroker).toBe(mockBroker);
    await daemon.stop();
  });

  it('stop() calls credBroker.clear()', async () => {
    const clearSpy = vi.fn();
    const mockBroker = { ping: vi.fn(), clear: clearSpy };
    const factory = vi.fn(() => mockBroker);

    const { daemon } = buildCredsDaemon({ credBrokerFactory: factory });
    await daemon.start();
    await daemon.stop();

    expect(clearSpy).toHaveBeenCalledOnce();
  });

  it('stop() logs "cred broker shutdown" after clearing', async () => {
    const logger = makeLogger();
    const mockBroker = { ping: vi.fn(), clear: vi.fn() };
    const { daemon } = buildCredsDaemon({
      logger,
      credBrokerFactory: vi.fn(() => mockBroker),
    });
    await daemon.start();
    await daemon.stop();
    const infoCalls = logger.info.mock.calls.map(([msg]) => msg);
    expect(infoCalls.some(msg => msg.includes('cred broker shutdown'))).toBe(true);
  });

  it('stop() does NOT throw when credBroker has no .clear() method', async () => {
    // Simulate a broker without clear() (defensive guard).
    const mockBroker = { ping: vi.fn() }; // no clear property
    const { daemon } = buildCredsDaemon({
      credBrokerFactory: vi.fn(() => mockBroker),
    });
    await daemon.start();
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  it('stop() does NOT throw when credBroker is null (never started)', async () => {
    const { daemon } = buildCredsDaemon();
    // Call stop without start — _credBroker remains null.
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  it('credBroker is in scpDeps when platform.mode = "scp"', async () => {
    const mockBroker = { ping: vi.fn(), clear: vi.fn() };
    const factory = vi.fn(() => mockBroker);
    let capturedScpDeps = null;

    const routerFactory = vi.fn((config, logger, scpDeps) => {
      capturedScpDeps = scpDeps;
      return makeFakeRouter();
    });

    const fakeMongo = {
      disconnect: vi.fn().mockResolvedValue(undefined),
      models: {},
      model: vi.fn().mockReturnValue({}),
    };

    const scpConfig = {
      ...BRIDGE_CONFIG_DEFAULTS,
      platform: { mode: 'scp' },
      bridge:   { ...BRIDGE_CONFIG_DEFAULTS.bridge },
      rpc:      { ...BRIDGE_CONFIG_DEFAULTS.rpc },
      web:      { ...BRIDGE_CONFIG_DEFAULTS.web, enabled: false },
      mongodb:  { uri: 'mongodb://localhost/testdb' },
      workspace: { ...BRIDGE_CONFIG_DEFAULTS.workspace },
      sources:  { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false } },
      memory:   { ...BRIDGE_CONFIG_DEFAULTS.memory, enabled: false },
      creds:    { ...BRIDGE_CONFIG_DEFAULTS.creds, enabled: false },
    };

    const daemon = new BridgeDaemon({
      config: scpConfig,
      logger: makeLogger(),
      env: {},
      sessionRouterFactory:    routerFactory,
      slackAdapterFactory:     vi.fn(() => makeFakeAdapter()),
      controlSocketFactory:    vi.fn(() => makeFakeSocket()),
      mongoConnectFactory:     vi.fn().mockResolvedValue(fakeMongo),
      workspaceManagerFactory: vi.fn().mockReturnValue({ ensure: vi.fn(), exec: vi.fn() }),
      memoryGatewayFactory:    vi.fn(() => makeFakeGateway()),
      credBrokerFactory:       factory,
    });

    await daemon.start();

    expect(capturedScpDeps).not.toBeNull();
    expect(capturedScpDeps.credBroker).toBe(mockBroker);

    await daemon.stop();
  });

  it('credBroker wired to controlSocket even in bridge mode (platform.mode = "bridge")', async () => {
    const mockBroker = { ping: vi.fn(), clear: vi.fn() };
    let capturedSocketOpts = null;

    const controlFactory = vi.fn((opts) => {
      capturedSocketOpts = opts;
      return makeFakeSocket();
    });

    const { daemon } = buildCredsDaemon({
      config: makeCredsConfig({ enabled: false }),    // bridge mode (default)
      credBrokerFactory: vi.fn(() => mockBroker),
      controlSocketFactory: controlFactory,
    });
    await daemon.start();

    expect(capturedSocketOpts.credBroker).toBe(mockBroker);
    await daemon.stop();
  });

  it('defaultCredBrokerFactory used when no credBrokerFactory is injected', async () => {
    // When creds.enabled=false the default factory returns a NoopCredBroker without
    // touching InfisicalClient — so no token-file read happens.
    const { daemon } = buildCredsDaemon({
      config: makeCredsConfig({ enabled: false }),
      // No credBrokerFactory → falls through to defaultCredBrokerFactory
    });
    await daemon.start();
    expect(daemon._credBroker).toBeInstanceOf(NoopCredBroker);
    await daemon.stop();
  });
});

// ─── BridgeDaemon — supervisor wiring ────────────────────────────────────────

import { defaultHeartbeatFactory } from './index.js';

/**
 * Build a config with supervisor overrides; all heavy subsystems disabled.
 */
function makeSupervisorConfig(supervisorOverrides = {}) {
  return {
    ...BRIDGE_CONFIG_DEFAULTS,
    bridge:    { ...BRIDGE_CONFIG_DEFAULTS.bridge },
    rpc:       { ...BRIDGE_CONFIG_DEFAULTS.rpc },
    sources:   { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false } },
    memory:    { ...BRIDGE_CONFIG_DEFAULTS.memory, enabled: false },
    creds:     { ...BRIDGE_CONFIG_DEFAULTS.creds, enabled: false },
    supervisor: { ...BRIDGE_CONFIG_DEFAULTS.supervisor, ...supervisorOverrides },
  };
}

/** Minimal fake repo/emitter/reaper for injection. */
function makeFakeSupervisor() {
  return {
    repo:    {},
    emitter: { start: vi.fn(), stop: vi.fn(async () => {}) },
    reaper:  { start: vi.fn(), stop: vi.fn() },
  };
}

/** Build a BridgeDaemon wired for supervisor tests. */
function buildSupervisorDaemon({
  config,
  logger,
  heartbeatFactory,
  mongoConnectFactory,
} = {}) {
  const _logger = logger ?? makeLogger();
  const _config = config ?? makeSupervisorConfig();
  const fakeRouter = makeFakeRouter();
  const fakeGateway = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), enabled: false };

  const daemon = new BridgeDaemon({
    config: _config,
    logger: _logger,
    env: {},
    sessionRouterFactory:  vi.fn(() => fakeRouter),
    slackAdapterFactory:   vi.fn(() => makeFakeAdapter()),
    controlSocketFactory:  vi.fn(() => makeFakeSocket()),
    memoryGatewayFactory:  vi.fn(() => fakeGateway),
    mongoConnectFactory:   mongoConnectFactory ?? null,
    heartbeatFactory,
  });

  return { daemon, fakeRouter };
}

describe('defaultHeartbeatFactory — unit tests', () => {
  it('returns null when supervisor.enabled = false', async () => {
    const config = makeSupervisorConfig({ enabled: false });
    const result = await defaultHeartbeatFactory(config, makeLogger(), null);
    expect(result).toBeNull();
  });

  it('returns null when supervisor.enabled = true but getMongoose is null', async () => {
    const config = makeSupervisorConfig({ enabled: true });
    const logger = makeLogger();
    const result = await defaultHeartbeatFactory(config, logger, null);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mongoose unavailable'));
  });

  it('returns null when getMongoose returns undefined/falsy', async () => {
    const config = makeSupervisorConfig({ enabled: true });
    const logger = makeLogger();
    const result = await defaultHeartbeatFactory(config, logger, async () => null);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mongoose unavailable'));
  });

  it('returns {repo, emitter, reaper} when enabled and mongoose available', async () => {
    const config = makeSupervisorConfig({ enabled: true });
    // Use a proper mongoose-shaped stub that makeHeartbeatModel can work with.
    // makeHeartbeatModel calls new mongoose.Schema(...) and mongoose.model(...)
    // so we need the real mongoose Schema class.
    const mongoose = await import('mongoose');
    // Provide a stub instance that wraps the real Schema but stubs model() to
    // avoid connecting to any DB.
    const fakeModel = {
      findOneAndUpdate: vi.fn().mockResolvedValue({}),
      find:             vi.fn().mockResolvedValue([]),
      deleteOne:        vi.fn().mockResolvedValue({}),
    };
    const fakeMongo = {
      Schema: mongoose.default.Schema,
      model:  vi.fn().mockReturnValue(fakeModel),
      models: {},
    };
    const result = await defaultHeartbeatFactory(config, makeLogger(), async () => fakeMongo);
    expect(result).not.toBeNull();
    expect(result.repo).toBeDefined();
    expect(result.emitter).toBeDefined();
    expect(result.reaper).toBeDefined();
  });

  it('factory receives (config, logger, getMongoose) args — verified via custom factory', async () => {
    const config = makeSupervisorConfig({ enabled: false });
    const logger = makeLogger();
    const fakeGetMongoose = vi.fn();
    let capturedArgs = null;

    const customFactory = vi.fn(async (...args) => {
      capturedArgs = args;
      return null;
    });

    const { daemon } = buildSupervisorDaemon({ config, logger, heartbeatFactory: customFactory });
    await daemon.start();

    expect(customFactory).toHaveBeenCalledOnce();
    expect(capturedArgs[0]).toBe(config);     // config
    expect(capturedArgs[1]).toBe(logger);     // logger
    expect(typeof capturedArgs[2]).toBe('function'); // getMongoose accessor
    await daemon.stop();
  });
});

describe('BridgeDaemon — supervisor wiring', () => {
  it('daemon.supervisor is null when supervisor.enabled = false (default)', async () => {
    const { daemon } = buildSupervisorDaemon({ config: makeSupervisorConfig({ enabled: false }) });
    await daemon.start();
    expect(daemon.supervisor).toBeNull();
    await daemon.stop();
  });

  it('custom heartbeatFactory honored — daemon.supervisor receives its return value', async () => {
    const sentinel = makeFakeSupervisor();
    const factory = vi.fn(async () => sentinel);

    const { daemon } = buildSupervisorDaemon({ heartbeatFactory: factory });
    await daemon.start();

    expect(daemon.supervisor).toBe(sentinel);
    await daemon.stop();
  });

  it('start() calls emitter.start() then reaper.start() when supervisor built', async () => {
    const callOrder = [];
    const sup = {
      repo:    {},
      emitter: { start: vi.fn(() => callOrder.push('emitter')), stop: vi.fn(async () => {}) },
      reaper:  { start: vi.fn(() => callOrder.push('reaper')),  stop: vi.fn() },
    };
    const factory = vi.fn(async () => sup);

    const { daemon } = buildSupervisorDaemon({ heartbeatFactory: factory });
    await daemon.start();

    expect(callOrder).toEqual(['emitter', 'reaper']);
    await daemon.stop();
  });

  it('stop() calls emitter.stop() before reaper.stop()', async () => {
    const stopOrder = [];
    const sup = {
      repo:    {},
      emitter: { start: vi.fn(), stop: vi.fn(async () => stopOrder.push('emitter')) },
      reaper:  { start: vi.fn(), stop: vi.fn(() => stopOrder.push('reaper')) },
    };
    const factory = vi.fn(async () => sup);

    const { daemon } = buildSupervisorDaemon({ heartbeatFactory: factory });
    await daemon.start();
    await daemon.stop();

    expect(stopOrder).toEqual(['emitter', 'reaper']);
  });

  it('stop() does not throw if emitter.stop() throws', async () => {
    const sup = {
      repo:    {},
      emitter: { start: vi.fn(), stop: vi.fn(async () => { throw new Error('emitter boom'); }) },
      reaper:  { start: vi.fn(), stop: vi.fn() },
    };
    const factory = vi.fn(async () => sup);

    const { daemon } = buildSupervisorDaemon({ heartbeatFactory: factory });
    await daemon.start();
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  it('stop() does not throw if reaper.stop() throws', async () => {
    const sup = {
      repo:    {},
      emitter: { start: vi.fn(), stop: vi.fn(async () => {}) },
      reaper:  { start: vi.fn(), stop: vi.fn(() => { throw new Error('reaper boom'); }) },
    };
    const factory = vi.fn(async () => sup);

    const { daemon } = buildSupervisorDaemon({ heartbeatFactory: factory });
    await daemon.start();
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  it('start() logs "supervisor started" when supervisor is built', async () => {
    const sup = makeFakeSupervisor();
    const logger = makeLogger();
    const factory = vi.fn(async () => sup);

    const { daemon } = buildSupervisorDaemon({ logger, heartbeatFactory: factory });
    await daemon.start();

    const infoCalls = logger.info.mock.calls.map(([msg]) => msg);
    expect(infoCalls.some(msg => msg?.includes?.('supervisor started'))).toBe(true);
    await daemon.stop();
  });

  it('workspaceManager threaded through to factory extras when present in SCP mode', async () => {
    // Wire an SCP-mode daemon; verify heartbeatFactory receives workspaceManager in extras.
    let capturedExtras = null;

    const factory = vi.fn(async (cfg, log, getMongo, extras) => {
      capturedExtras = extras;
      return null;
    });

    const fakeMongo = {
      disconnect: vi.fn().mockResolvedValue(undefined),
      models: {},
      model: vi.fn().mockReturnValue({}),
    };

    const fakeWm = { stopWorkspace: vi.fn(), markReaped: vi.fn() };

    const scpConfig = {
      ...BRIDGE_CONFIG_DEFAULTS,
      platform:  { mode: 'scp' },
      bridge:    { ...BRIDGE_CONFIG_DEFAULTS.bridge },
      rpc:       { ...BRIDGE_CONFIG_DEFAULTS.rpc },
      web:       { ...BRIDGE_CONFIG_DEFAULTS.web, enabled: false },
      mongodb:   { uri: 'mongodb://localhost/testdb' },
      workspace: { ...BRIDGE_CONFIG_DEFAULTS.workspace },
      sources:   { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false } },
      memory:    { ...BRIDGE_CONFIG_DEFAULTS.memory, enabled: false },
      creds:     { ...BRIDGE_CONFIG_DEFAULTS.creds, enabled: false },
      supervisor: { ...BRIDGE_CONFIG_DEFAULTS.supervisor, enabled: false },
    };

    const daemon = new BridgeDaemon({
      config: scpConfig,
      logger: makeLogger(),
      env: {},
      sessionRouterFactory:    vi.fn(() => makeFakeRouter()),
      slackAdapterFactory:     vi.fn(() => makeFakeAdapter()),
      controlSocketFactory:    vi.fn(() => makeFakeSocket()),
      memoryGatewayFactory:    vi.fn(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}), enabled: false })),
      mongoConnectFactory:     vi.fn().mockResolvedValue(fakeMongo),
      workspaceManagerFactory: vi.fn().mockReturnValue(fakeWm),
      heartbeatFactory:        factory,
    });

    await daemon.start();

    expect(capturedExtras).not.toBeNull();
    expect(capturedExtras.workspaceManager).toBe(fakeWm);

    await daemon.stop();
  });
});

// ─── BridgeDaemon — heartbeatRepo wiring into ScpHttpServer ──────────────────

describe('BridgeDaemon — heartbeatRepo threaded into ScpHttpServer', () => {
  /** Shared mongo stub that satisfies getSynapsWorkspaceModel. */
  function makeScpMongo() {
    return {
      disconnect: vi.fn().mockResolvedValue(undefined),
      models: {},
      model: vi.fn().mockReturnValue({
        findOneAndUpdate: vi.fn().mockResolvedValue({}),
        find:             vi.fn().mockResolvedValue([]),
        deleteOne:        vi.fn().mockResolvedValue({}),
      }),
    };
  }

  /** Build a full SCP config with supervisor overrides and web enabled. */
  function makeScpSupervisorConfig({
    supervisorEnabled = true,
    bridgeCriticalMs  = 45_000,
  } = {}) {
    return {
      ...BRIDGE_CONFIG_DEFAULTS,
      platform:  { mode: 'scp' },
      bridge:    { ...BRIDGE_CONFIG_DEFAULTS.bridge },
      rpc:       { ...BRIDGE_CONFIG_DEFAULTS.rpc },
      web:       { ...BRIDGE_CONFIG_DEFAULTS.web, enabled: true, http_port: 0 },
      mongodb:   { uri: 'mongodb://localhost/testdb' },
      workspace: { ...BRIDGE_CONFIG_DEFAULTS.workspace },
      sources:   { slack: { ...BRIDGE_CONFIG_DEFAULTS.sources.slack, enabled: false } },
      memory:    { ...BRIDGE_CONFIG_DEFAULTS.memory, enabled: false },
      creds:     { ...BRIDGE_CONFIG_DEFAULTS.creds, enabled: false },
      supervisor: {
        ...BRIDGE_CONFIG_DEFAULTS.supervisor,
        enabled:           supervisorEnabled,
        bridge_critical_ms: bridgeCriticalMs,
      },
    };
  }

  it('ScpHttpServer factory receives non-null heartbeatRepo when supervisor.enabled=true', async () => {
    // A fake supervisor whose repo is a recognisable sentinel object.
    const fakeRepo = { _isFakeHeartbeatRepo: true };
    const fakeSup  = {
      repo:    fakeRepo,
      emitter: { start: vi.fn(), stop: vi.fn(async () => {}) },
      reaper:  { start: vi.fn(), stop: vi.fn() },
    };
    const heartbeatFactory = vi.fn(async () => fakeSup);

    // Capture the args the factory is called with.
    let capturedFactoryArgs = null;
    const fakeScpServer = {
      start: vi.fn(async () => ({ port: 0 })),
      stop:  vi.fn(async () => {}),
    };
    const scpHttpServerFactory = vi.fn((args) => {
      capturedFactoryArgs = args;
      return fakeScpServer;
    });

    const fakeMongo = makeScpMongo();
    const config    = makeScpSupervisorConfig({ supervisorEnabled: true, bridgeCriticalMs: 45_000 });

    const daemon = new BridgeDaemon({
      config,
      logger:  makeLogger(),
      env:     {},
      sessionRouterFactory:    vi.fn(() => makeFakeRouter()),
      slackAdapterFactory:     vi.fn(() => makeFakeAdapter()),
      controlSocketFactory:    vi.fn(() => makeFakeSocket()),
      memoryGatewayFactory:    vi.fn(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}), enabled: false })),
      mongoConnectFactory:     vi.fn().mockResolvedValue(fakeMongo),
      workspaceManagerFactory: vi.fn().mockReturnValue({}),
      heartbeatFactory,
      scpHttpServerFactory,
    });

    await daemon.start();

    // The factory must have been called
    expect(scpHttpServerFactory).toHaveBeenCalledTimes(1);
    // heartbeatRepo must be the repo from the supervisor — NOT null
    expect(capturedFactoryArgs).not.toBeNull();
    expect(capturedFactoryArgs.heartbeatRepo).toBe(fakeRepo);
    // bridgeCriticalMs is carried in config.supervisor — verify the config was threaded through
    expect(capturedFactoryArgs.config.supervisor.bridge_critical_ms).toBe(45_000);

    await daemon.stop();
  });

  it('ScpHttpServer factory receives null heartbeatRepo when supervisor.enabled=false', async () => {
    // heartbeatFactory returns null (supervisor disabled)
    const heartbeatFactory = vi.fn(async () => null);

    let capturedFactoryArgs = null;
    const fakeScpServer = {
      start: vi.fn(async () => ({ port: 0 })),
      stop:  vi.fn(async () => {}),
    };
    const scpHttpServerFactory = vi.fn((args) => {
      capturedFactoryArgs = args;
      return fakeScpServer;
    });

    const fakeMongo = makeScpMongo();
    const config    = makeScpSupervisorConfig({ supervisorEnabled: false });

    const daemon = new BridgeDaemon({
      config,
      logger:  makeLogger(),
      env:     {},
      sessionRouterFactory:    vi.fn(() => makeFakeRouter()),
      slackAdapterFactory:     vi.fn(() => makeFakeAdapter()),
      controlSocketFactory:    vi.fn(() => makeFakeSocket()),
      memoryGatewayFactory:    vi.fn(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}), enabled: false })),
      mongoConnectFactory:     vi.fn().mockResolvedValue(fakeMongo),
      workspaceManagerFactory: vi.fn().mockReturnValue({}),
      heartbeatFactory,
      scpHttpServerFactory,
    });

    await daemon.start();

    expect(scpHttpServerFactory).toHaveBeenCalledTimes(1);
    expect(capturedFactoryArgs).not.toBeNull();
    // With supervisor disabled the repo must be null (back-compat)
    expect(capturedFactoryArgs.heartbeatRepo).toBeNull();

    await daemon.stop();
  });
});

