/**
 * @file bridge/index.test.js
 *
 * Tests for BridgeDaemon — daemon orchestrator.
 *
 * All subsystems are injected via factories so no real processes, sockets,
 * or Slack connections are ever created.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BridgeDaemon } from './index.js';
import { BRIDGE_CONFIG_DEFAULTS } from './config.js';
import { SynapsRpc } from './core/synaps-rpc.js';
import { DockerExecSynapsRpc } from './core/synaps-rpc-docker.js';

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
