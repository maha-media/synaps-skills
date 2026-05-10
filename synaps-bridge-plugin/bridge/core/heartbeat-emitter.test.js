/**
 * @file bridge/core/heartbeat-emitter.test.js
 *
 * Deterministic tests for HeartbeatEmitter.
 *
 * Strategy
 * ────────
 *  • vi.useFakeTimers() takes over globalThis.setInterval / clearInterval so
 *    the emitter's default injection path is exercised without real waits.
 *  • vi.advanceTimersByTimeAsync() drains the microtask queue between ticks,
 *    making async beatNow() calls settle before we assert.
 *  • A few tests inject setInterval/clearInterval manually to verify the
 *    injection contract independently.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeartbeatEmitter } from './heartbeat-emitter.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Minimal repo mock */
function makeRepo() {
  return { record: vi.fn().mockResolvedValue({}) };
}

/** Full logger mock */
function makeLogger() {
  return {
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  };
}

/** Build a running emitter with sane defaults; caller can override any field. */
function makeEmitter(overrides = {}) {
  return new HeartbeatEmitter({
    repo:       makeRepo(),
    component:  'bridge',
    id:         'main',
    intervalMs: 1_000,
    logger:     makeLogger(),
    ...overrides,
  });
}

// ─── 1. Constructor validation ────────────────────────────────────────────────

describe('HeartbeatEmitter — constructor validation', () => {
  it('1. throws TypeError when repo is missing', () => {
    expect(() => new HeartbeatEmitter({ component: 'bridge', id: 'x', intervalMs: 1000 }))
      .toThrow(TypeError);
  });

  it('2. throws TypeError when component is missing', () => {
    expect(() => new HeartbeatEmitter({ repo: makeRepo(), id: 'x', intervalMs: 1000 }))
      .toThrow(TypeError);
  });

  it('3. throws TypeError when id is missing', () => {
    expect(() => new HeartbeatEmitter({ repo: makeRepo(), component: 'bridge', intervalMs: 1000 }))
      .toThrow(TypeError);
  });

  it('4. throws TypeError when intervalMs <= 0', () => {
    expect(() => makeEmitter({ intervalMs: 0 })).toThrow(TypeError);
    expect(() => makeEmitter({ intervalMs: -500 })).toThrow(TypeError);
  });

  it('5. throws TypeError when repo.record is not a function', () => {
    expect(() => makeEmitter({ repo: { record: 'notAFunction' } }))
      .toThrow(TypeError);
  });

  it('5b. throws TypeError when repo.record is absent entirely', () => {
    expect(() => makeEmitter({ repo: {} })).toThrow(TypeError);
  });

  it('constructs successfully with valid required fields', () => {
    expect(() => makeEmitter()).not.toThrow();
  });
});

// ─── 2. start() / initial beat ───────────────────────────────────────────────

describe('HeartbeatEmitter — start() behaviour', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => { vi.useRealTimers(); });

  it('6. calls repo.record immediately after start()', async () => {
    const repo   = makeRepo();
    const emitter = makeEmitter({ repo });

    emitter.start();
    // Let the initial beatNow() Promise settle
    await vi.advanceTimersByTimeAsync(0);

    expect(repo.record).toHaveBeenCalledOnce();
    expect(repo.record).toHaveBeenCalledWith({
      component: 'bridge',
      id:        'main',
      healthy:   true,
      details:   {},
    });

    await emitter.stop();
  });

  it('7. emits at intervalMs cadence', async () => {
    const repo    = makeRepo();
    const emitter = makeEmitter({ repo, intervalMs: 500 });

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);   // initial beat
    expect(repo.record).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500); // 1 tick
    expect(repo.record).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(500); // 2nd tick
    expect(repo.record).toHaveBeenCalledTimes(3);

    await emitter.stop();
  });

  it('8. multiple ticks call repo.record multiple times', async () => {
    const repo    = makeRepo();
    const emitter = makeEmitter({ repo, intervalMs: 200 });

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);    // initial
    await vi.advanceTimersByTimeAsync(1000); // 5 more ticks

    // initial + 5 interval ticks = 6
    expect(repo.record.mock.calls.length).toBeGreaterThanOrEqual(6);

    await emitter.stop();
  });

  it('14. start() throws if already running', async () => {
    const emitter = makeEmitter();
    emitter.start();

    expect(() => emitter.start()).toThrow('HeartbeatEmitter: already started');

    await emitter.stop();
  });

  it('running getter returns true after start, false after stop', async () => {
    const emitter = makeEmitter();
    expect(emitter.running).toBe(false);

    emitter.start();
    expect(emitter.running).toBe(true);

    await emitter.stop();
    expect(emitter.running).toBe(false);
  });
});

// ─── 3. detailsFn / healthFn ─────────────────────────────────────────────────

describe('HeartbeatEmitter — detailsFn and healthFn', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => { vi.useRealTimers(); });

  it('9. detailsFn output is forwarded to repo.record', async () => {
    const repo      = makeRepo();
    const detailsFn = vi.fn().mockReturnValue({ queue: 3 });
    const emitter   = makeEmitter({ repo, detailsFn });

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(repo.record).toHaveBeenCalledWith(
      expect.objectContaining({ details: { queue: 3 } }),
    );

    await emitter.stop();
  });

  it('10. healthFn output is forwarded to repo.record', async () => {
    const repo     = makeRepo();
    const healthFn = vi.fn().mockReturnValue(false);
    const emitter  = makeEmitter({ repo, healthFn });

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(repo.record).toHaveBeenCalledWith(
      expect.objectContaining({ healthy: false }),
    );

    await emitter.stop();
  });

  it('11. healthFn defaults to true when absent', async () => {
    const repo    = makeRepo();
    const emitter = makeEmitter({ repo }); // no healthFn

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);

    const call = repo.record.mock.calls[0][0];
    expect(call.healthy).toBe(true);

    await emitter.stop();
  });

  it('12. detailsFn defaults to {} when absent', async () => {
    const repo    = makeRepo();
    const emitter = makeEmitter({ repo }); // no detailsFn

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);

    const call = repo.record.mock.calls[0][0];
    expect(call.details).toEqual({});

    await emitter.stop();
  });

  it('13. async detailsFn / healthFn are awaited correctly', async () => {
    const repo      = makeRepo();
    const detailsFn = vi.fn().mockResolvedValue({ async: true });
    const healthFn  = vi.fn().mockResolvedValue(false);
    const emitter   = makeEmitter({ repo, detailsFn, healthFn });

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(repo.record).toHaveBeenCalledWith(
      expect.objectContaining({ healthy: false, details: { async: true } }),
    );

    await emitter.stop();
  });
});

// ─── 4. stop() behaviour ─────────────────────────────────────────────────────

describe('HeartbeatEmitter — stop() behaviour', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => { vi.useRealTimers(); });

  it('15. stop() clears the interval — no further beats after stop()', async () => {
    const repo    = makeRepo();
    const emitter = makeEmitter({ repo, intervalMs: 200 });

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);   // initial
    await vi.advanceTimersByTimeAsync(200); // 1 tick
    const countBeforeStop = repo.record.mock.calls.length;

    await emitter.stop();
    repo.record.mockClear(); // reset to isolate post-stop calls

    // Advance time — no new interval beats should fire
    await vi.advanceTimersByTimeAsync(1000);
    // Only the final shutdown beat from stop() should exist (already called above)
    // repo.record was cleared, so any lingering interval beat would show here
    // (the final beat happens inside stop() before we cleared, so this should be 0)
    expect(repo.record.mock.calls.length).toBe(0);
    expect(countBeforeStop).toBeGreaterThanOrEqual(2);
  });

  it('16. stop() emits a final healthy=false beat', async () => {
    const repo    = makeRepo();
    const emitter = makeEmitter({ repo });

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);
    repo.record.mockClear(); // ignore beats so far

    await emitter.stop();

    expect(repo.record).toHaveBeenCalledOnce();
    expect(repo.record).toHaveBeenCalledWith({
      component: 'bridge',
      id:        'main',
      healthy:   false,
      details:   { reason: 'shutdown' },
    });
  });

  it('17. stop() before start() is a no-op (does not throw)', async () => {
    const emitter = makeEmitter();
    expect(emitter.running).toBe(false);
    await expect(emitter.stop()).resolves.toBeUndefined();
  });

  it('17b. stop() before start() does not call repo.record', async () => {
    const repo    = makeRepo();
    const emitter = makeEmitter({ repo });
    await emitter.stop();
    expect(repo.record).not.toHaveBeenCalled();
  });
});

// ─── 5. Error resilience ──────────────────────────────────────────────────────

describe('HeartbeatEmitter — error resilience', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => { vi.useRealTimers(); });

  it('18. error in repo.record is caught — interval keeps ticking', async () => {
    const repo   = makeRepo();
    const logger = makeLogger();
    // First call rejects; subsequent calls succeed
    repo.record
      .mockRejectedValueOnce(new Error('DB down'))
      .mockResolvedValue({});
    const emitter = makeEmitter({ repo, logger });

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);   // initial — will fail
    await vi.advanceTimersByTimeAsync(1000); // 1 tick — should succeed

    // emitter should have ticked again (2 calls: initial + tick)
    expect(repo.record.mock.calls.length).toBeGreaterThanOrEqual(2);
    // warn logged for the failure
    expect(logger.warn).toHaveBeenCalledWith(
      'heartbeat emit failed',
      expect.objectContaining({ error: 'DB down' }),
    );

    await emitter.stop();
  });

  it('19. error in detailsFn is caught — interval keeps ticking', async () => {
    const repo      = makeRepo();
    const logger    = makeLogger();
    let   callCount = 0;
    const detailsFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('detailsFn boom');
      return { ok: true };
    });
    const emitter = makeEmitter({ repo, logger, detailsFn, intervalMs: 300 });

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);   // initial — detailsFn throws
    expect(logger.warn).toHaveBeenCalledWith(
      'heartbeat emit failed',
      expect.objectContaining({ error: 'detailsFn boom' }),
    );

    await vi.advanceTimersByTimeAsync(300); // 2nd beat — detailsFn succeeds
    // repo.record should have been called at least once (2nd beat succeeds)
    const successCalls = repo.record.mock.calls.filter(
      ([arg]) => arg.details?.ok === true,
    );
    expect(successCalls.length).toBeGreaterThanOrEqual(1);

    await emitter.stop();
  });
});

// ─── 6. Logging ──────────────────────────────────────────────────────────────

describe('HeartbeatEmitter — logging', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(async () => { vi.useRealTimers(); });

  it('20a. logger.info called on start', async () => {
    const logger  = makeLogger();
    const emitter = makeEmitter({ logger, intervalMs: 500 });

    emitter.start();
    expect(logger.info).toHaveBeenCalledWith(
      'heartbeat emitter started',
      { component: 'bridge', id: 'main', intervalMs: 500 },
    );

    await emitter.stop();
  });

  it('20b. logger.info called on stop', async () => {
    const logger  = makeLogger();
    const emitter = makeEmitter({ logger });

    emitter.start();
    await emitter.stop();

    expect(logger.info).toHaveBeenCalledWith(
      'heartbeat emitter stopped',
      { component: 'bridge', id: 'main' },
    );
  });

  it('20c. logger.debug called on successful beat', async () => {
    const logger  = makeLogger();
    const emitter = makeEmitter({ logger });

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.debug).toHaveBeenCalledWith(
      'heartbeat',
      expect.objectContaining({ component: 'bridge', id: 'main', healthy: true }),
    );

    await emitter.stop();
  });

  it('20d. logger.warn called when repo.record throws', async () => {
    const repo   = makeRepo();
    const logger = makeLogger();
    repo.record.mockRejectedValueOnce(new Error('timeout'));
    const emitter = makeEmitter({ repo, logger });

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalledWith(
      'heartbeat emit failed',
      expect.objectContaining({ component: 'bridge', id: 'main', error: 'timeout' }),
    );

    await emitter.stop();
  });

  it('20e. emitter works without a logger (no-op logger used)', async () => {
    const repo    = makeRepo();
    // No logger supplied
    const emitter = new HeartbeatEmitter({
      repo,
      component:  'bridge',
      id:         'main',
      intervalMs: 500,
    });

    emitter.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(repo.record).toHaveBeenCalledOnce();

    await emitter.stop();
  });
});

// ─── 7. Injectable setInterval / clearInterval ────────────────────────────────

describe('HeartbeatEmitter — injectable timer fns', () => {
  it('uses injected setInterval and clearInterval', async () => {
    let   capturedFn        = null;
    let   capturedMs        = null;
    let   clearWasCalled    = false;
    const fakeTimer         = Symbol('timer');

    const setIntervalFn  = vi.fn((fn, ms) => { capturedFn = fn; capturedMs = ms; return fakeTimer; });
    const clearIntervalFn = vi.fn((t) => { if (t === fakeTimer) clearWasCalled = true; });

    const repo    = makeRepo();
    const emitter = new HeartbeatEmitter({
      repo,
      component:     'rpc',
      id:            'sess-1',
      intervalMs:    250,
      setInterval:   setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    emitter.start();
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 250);
    expect(capturedMs).toBe(250);

    await emitter.stop();
    expect(clearWasCalled).toBe(true);
  });

  it('injected setInterval callback triggers beatNow', async () => {
    let   capturedCb        = null;
    const setIntervalFn     = vi.fn((fn) => { capturedCb = fn; return 99; });
    const clearIntervalFn   = vi.fn();

    const repo    = makeRepo();
    const emitter = new HeartbeatEmitter({
      repo,
      component:    'workspace',
      id:           'ws-1',
      intervalMs:   1000,
      setInterval:  setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    emitter.start();
    // Drain the initial beatNow() fire-and-forget
    await Promise.resolve();
    const callsAfterStart = repo.record.mock.calls.length;

    // Manually trigger the interval callback
    await capturedCb();
    expect(repo.record.mock.calls.length).toBe(callsAfterStart + 1);

    await emitter.stop();
  });
});
