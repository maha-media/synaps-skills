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
