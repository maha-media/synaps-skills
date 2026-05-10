/**
 * @file bridge/core/reaper.test.js
 *
 * Tests for the Reaper periodic-sweep class.
 *
 * Uses vitest fake timers to control setInterval cadence and deterministic
 * mocks for repo, workspaceManager, rpcKiller, and logger.
 *
 * Test count: 22 (numbered below, matching the spec).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Reaper } from './reaper.js';

/** Flush all pending microtasks (Promise.resolve chains). */
const flushPromises = () => new Promise(resolve => setImmediate(resolve));

// ─── Shared factory helpers ──────────────────────────────────────────────────

function makeRepo(overrides = {}) {
  return {
    findStale: vi.fn().mockResolvedValue([]),
    remove:    vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeWorkspaceManager(overrides = {}) {
  return {
    stopWorkspace: vi.fn().mockResolvedValue(undefined),
    markReaped:    vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeRpcKiller(overrides) {
  return overrides ?? vi.fn().mockResolvedValue(undefined);
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  };
}

/** Heartbeat document stubs. */
function wsDoc(id) { return { component: 'workspace', id }; }
function wsDocWithTs(id, ts, details = {}) { return { component: 'workspace', id, ts, details }; }
function rpcDoc(id) { return { component: 'rpc',       id }; }
function scpDoc(id) { return { component: 'scp',       id }; }

/**
 * Build a Reaper with sensible defaults plus any caller overrides.
 * Injects fake setInterval / clearInterval captured from the outer scope.
 */
function makeReaper({
  repo,
  workspaceManager,
  rpcKiller,
  thresholds,
  logger,
  setIntervalImpl,
  clearIntervalImpl,
  inboxNotifier,
  inboxDirFor,
  now,
} = {}) {
  return new Reaper({
    repo:          repo    ?? makeRepo(),
    workspaceManager,
    rpcKiller,
    intervalMs:    60_000,
    thresholds,
    logger:        logger  ?? makeLogger(),
    setInterval:   setIntervalImpl  ?? globalThis.setInterval,
    clearInterval: clearIntervalImpl ?? globalThis.clearInterval,
    inboxNotifier,
    inboxDirFor,
    now,
  });
}

function makeInboxNotifier(overrides = {}) {
  return {
    notifyWorkspaceReaped: vi.fn().mockResolvedValue({ written: true, path: '/tmp/fake.json' }),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Reaper — constructor validation', () => {
  // 1. Missing repo
  it('1. throws when repo is omitted', () => {
    expect(() => new Reaper({ intervalMs: 1000 })).toThrow('repo is required');
  });

  // 2. Missing intervalMs
  it('2. throws when intervalMs is omitted', () => {
    expect(() => new Reaper({ repo: makeRepo() })).toThrow('intervalMs is required');
  });

  it('2b. throws when intervalMs is zero', () => {
    expect(() => new Reaper({ repo: makeRepo(), intervalMs: 0 })).toThrow('positive finite');
  });

  it('2c. throws when intervalMs is negative', () => {
    expect(() => new Reaper({ repo: makeRepo(), intervalMs: -1 })).toThrow('positive finite');
  });

  // 2. Constructor merges custom thresholds with defaults (partial override)
  it('2d. merges partial threshold override with defaults', () => {
    const reaper = new Reaper({
      repo:        makeRepo(),
      intervalMs:  1000,
      thresholds:  { workspaceMs: 999 },
    });
    // Custom override honoured
    expect(reaper._thresholds.workspaceMs).toBe(999);
    // Untouched defaults survive
    expect(reaper._thresholds.rpcMs).toBe(5 * 60_000);
    expect(reaper._thresholds.scpMs).toBe(30_000);
  });
});

describe('Reaper — start / stop lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 3. start() schedules interval via injected setInterval
  it('3. start() registers the interval with the injected setInterval', () => {
    const setIntervalSpy  = vi.fn().mockReturnValue(42);
    const clearIntervalSpy = vi.fn();
    const reaper = new Reaper({
      repo:         makeRepo(),
      intervalMs:   5000,
      setInterval:  setIntervalSpy,
      clearInterval: clearIntervalSpy,
    });
    reaper.start();
    reaper.stop();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
  });

  // 4. start() invokes sweepNow immediately
  it('4. start() calls sweepNow immediately (before first tick)', () => {
    // Use real-time injected mocks so no async-flush complications.
    const repo    = makeRepo();
    const reaper  = new Reaper({
      repo,
      intervalMs:    60_000,
      logger:        makeLogger(),
      setInterval:   vi.fn().mockReturnValue(1),
      clearInterval: vi.fn(),
    });
    // Spy BEFORE start so the call is captured.
    const sweepSpy = vi.spyOn(reaper, 'sweepNow').mockResolvedValue({
      reaped: { workspaces: [], rpcs: [] }, scpStale: [], errors: [],
    });

    reaper.start();

    // sweepNow() is called synchronously inside start() (the .catch is chained
    // on the returned promise, but the call itself is synchronous).
    expect(sweepSpy).toHaveBeenCalledOnce();
    reaper.stop();
  });

  // 5. Multiple ticks trigger multiple sweeps
  it('5. multiple timer ticks trigger multiple sweeps', async () => {
    let tickFn;
    const setIntervalSpy  = vi.fn((fn) => { tickFn = fn; return 99; });
    const clearIntervalSpy = vi.fn();
    const repo   = makeRepo();
    const reaper = new Reaper({
      repo,
      intervalMs:    60_000,
      logger:        makeLogger(),
      setInterval:   setIntervalSpy,
      clearInterval: clearIntervalSpy,
    });
    const sweepSpy = vi.spyOn(reaper, 'sweepNow').mockResolvedValue({
      reaped: { workspaces: [], rpcs: [] }, scpStale: [], errors: [],
    });

    reaper.start();               // call 1 (immediate)
    await tickFn();               // call 2
    await tickFn();               // call 3

    expect(sweepSpy).toHaveBeenCalledTimes(3);
    reaper.stop();
  });

  // 6. stop() clears the interval
  it('6. stop() calls clearInterval with the timer handle', () => {
    const TIMER_HANDLE    = Symbol('timer');
    const setIntervalSpy  = vi.fn().mockReturnValue(TIMER_HANDLE);
    const clearIntervalSpy = vi.fn();

    const reaper = new Reaper({
      repo:          makeRepo(),
      intervalMs:    1000,
      setInterval:   setIntervalSpy,
      clearInterval: clearIntervalSpy,
    });
    reaper.start();
    reaper.stop();

    expect(clearIntervalSpy).toHaveBeenCalledWith(TIMER_HANDLE);
    expect(reaper.running).toBe(false);
  });

  // 7. stop() before start is a no-op
  it('7. stop() before start() is a no-op (no throw, running stays false)', () => {
    const clearIntervalSpy = vi.fn();
    const reaper = new Reaper({
      repo:          makeRepo(),
      intervalMs:    1000,
      setInterval:   vi.fn().mockReturnValue(1),
      clearInterval: clearIntervalSpy,
    });

    expect(() => reaper.stop()).not.toThrow();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    expect(reaper.running).toBe(false);
  });

  // 8. start() throws if already running
  it('8. start() throws when already running', () => {
    const reaper = makeReaper({
      setIntervalImpl:  vi.fn().mockReturnValue(1),
      clearIntervalImpl: vi.fn(),
    });
    reaper.start();
    expect(() => reaper.start()).toThrow('already running');
    reaper.stop();
  });
});

describe('Reaper — sweepNow() workspace reap', () => {
  // 9. sweepNow() reaps stale workspaces (stopWorkspace called)
  it('9. calls workspaceManager.stopWorkspace for each stale workspace', async () => {
    const repo   = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) => {
        if (component === 'workspace') return Promise.resolve([wsDoc('ws-1'), wsDoc('ws-2')]);
        return Promise.resolve([]);
      }),
    });
    const wm     = makeWorkspaceManager();
    const reaper = makeReaper({ repo, workspaceManager: wm });

    await reaper.sweepNow();

    expect(wm.stopWorkspace).toHaveBeenCalledWith('ws-1');
    expect(wm.stopWorkspace).toHaveBeenCalledWith('ws-2');
  });

  // 10. sweepNow() calls markReaped after stopWorkspace
  it('10. calls workspaceManager.markReaped after stopWorkspace succeeds', async () => {
    const repo = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'workspace'
          ? Promise.resolve([wsDoc('ws-A')])
          : Promise.resolve([]),
      ),
    });
    const wm = makeWorkspaceManager();
    const reaper = makeReaper({ repo, workspaceManager: wm });

    await reaper.sweepNow();

    // markReaped must be called AFTER stopWorkspace
    const stopOrder = wm.stopWorkspace.mock.invocationCallOrder[0];
    const markOrder = wm.markReaped.mock.invocationCallOrder[0];
    expect(markOrder).toBeGreaterThan(stopOrder);
    expect(wm.markReaped).toHaveBeenCalledWith('ws-A');
  });

  // 11. sweepNow() calls repo.remove after successful reap
  it('11. calls repo.remove for workspace after stopWorkspace + markReaped succeed', async () => {
    const repo = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'workspace'
          ? Promise.resolve([wsDoc('ws-X')])
          : Promise.resolve([]),
      ),
    });
    const wm = makeWorkspaceManager();
    const reaper = makeReaper({ repo, workspaceManager: wm });

    await reaper.sweepNow();

    expect(repo.remove).toHaveBeenCalledWith({ component: 'workspace', id: 'ws-X' });
  });
});

describe('Reaper — sweepNow() rpc reap', () => {
  // 12. sweepNow() reaps stale rpcs via rpcKiller
  it('12. calls rpcKiller and repo.remove for each stale rpc', async () => {
    const killer = makeRpcKiller();
    const repo   = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'rpc'
          ? Promise.resolve([rpcDoc('sess-1'), rpcDoc('sess-2')])
          : Promise.resolve([]),
      ),
    });
    const reaper = makeReaper({ repo, rpcKiller: killer });

    await reaper.sweepNow();

    expect(killer).toHaveBeenCalledWith('sess-1');
    expect(killer).toHaveBeenCalledWith('sess-2');
    expect(repo.remove).toHaveBeenCalledWith({ component: 'rpc', id: 'sess-1' });
    expect(repo.remove).toHaveBeenCalledWith({ component: 'rpc', id: 'sess-2' });
  });
});

describe('Reaper — sweepNow() scp stale (info-only)', () => {
  // 13. sweepNow() warns on stale scp without calling any killer
  it('13. logs warn for stale scp docs and does NOT call repo.remove', async () => {
    const logger = makeLogger();
    const repo   = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'scp'
          ? Promise.resolve([scpDoc('scp-main')])
          : Promise.resolve([]),
      ),
    });
    const reaper = makeReaper({ repo, logger });

    await reaper.sweepNow();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('scp heartbeat stale'),
      expect.objectContaining({ id: 'scp-main' }),
    );
    // repo.remove must NOT be called for scp
    const removeCalls = repo.remove.mock.calls;
    const scpRemove = removeCalls.filter(([args]) => args?.component === 'scp');
    expect(scpRemove).toHaveLength(0);
  });
});

describe('Reaper — sweepNow() summary shape', () => {
  // 14. sweepNow() returns proper summary shape
  it('14. returns { reaped: { workspaces, rpcs }, scpStale, errors }', async () => {
    const killer = makeRpcKiller();
    const wm     = makeWorkspaceManager();
    const repo   = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) => {
        if (component === 'workspace') return Promise.resolve([wsDoc('ws-1')]);
        if (component === 'rpc')       return Promise.resolve([rpcDoc('r-1')]);
        if (component === 'scp')       return Promise.resolve([scpDoc('scp-1')]);
        return Promise.resolve([]);
      }),
    });
    const reaper = makeReaper({ repo, workspaceManager: wm, rpcKiller: killer });

    const summary = await reaper.sweepNow();

    expect(summary).toMatchObject({
      reaped:   { workspaces: ['ws-1'], rpcs: ['r-1'] },
      scpStale: ['scp-1'],
      errors:   [],
    });
  });
});

describe('Reaper — per-target error handling', () => {
  // 15. workspaceManager.stopWorkspace error caught; sweep continues with next workspace
  it('15. stopWorkspace error is caught; remaining workspaces are still processed', async () => {
    const wm = makeWorkspaceManager({
      stopWorkspace: vi.fn()
        .mockRejectedValueOnce(new Error('docker gone'))
        .mockResolvedValue(undefined),
    });
    const repo = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'workspace'
          ? Promise.resolve([wsDoc('ws-bad'), wsDoc('ws-good')])
          : Promise.resolve([]),
      ),
    });
    const reaper = makeReaper({ repo, workspaceManager: wm });

    const summary = await reaper.sweepNow();

    // ws-bad failed → in errors, NOT in reaped
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ component: 'workspace', id: 'ws-bad' });
    // ws-good succeeded → in reaped
    expect(summary.reaped.workspaces).toContain('ws-good');
    expect(summary.reaped.workspaces).not.toContain('ws-bad');
  });

  // 16. rpcKiller error caught; sweep continues with next rpc
  it('16. rpcKiller error is caught; remaining rpcs are still processed', async () => {
    const killer = vi.fn()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValue(undefined);
    const repo = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'rpc'
          ? Promise.resolve([rpcDoc('r-bad'), rpcDoc('r-good')])
          : Promise.resolve([]),
      ),
    });
    const reaper = makeReaper({ repo, rpcKiller: killer });

    const summary = await reaper.sweepNow();

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ component: 'rpc', id: 'r-bad' });
    expect(summary.reaped.rpcs).toContain('r-good');
    expect(summary.reaped.rpcs).not.toContain('r-bad');
  });

  // 17. repo.findStale error for one component doesn't kill other sections
  it('17. findStale error for workspace section does not abort rpc or scp sections', async () => {
    const killer = makeRpcKiller();
    const repo   = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) => {
        if (component === 'workspace') return Promise.reject(new Error('db timeout'));
        if (component === 'rpc')       return Promise.resolve([rpcDoc('r-1')]);
        if (component === 'scp')       return Promise.resolve([scpDoc('s-1')]);
        return Promise.resolve([]);
      }),
    });
    const logger = makeLogger();
    const reaper = makeReaper({ repo, rpcKiller: killer, logger });

    const summary = await reaper.sweepNow();

    // Workspace section failed — reaped.workspaces is empty
    expect(summary.reaped.workspaces).toHaveLength(0);
    // RPC section ran fine
    expect(summary.reaped.rpcs).toContain('r-1');
    // SCP section ran fine
    expect(summary.scpStale).toContain('s-1');
    // Error logged
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('findStale failed for workspace'),
      expect.any(Error),
    );
  });

  // 18. repo.remove error is caught; reap still counted as successful (termination occurred)
  it('18. repo.remove error is caught; id still appears in reaped list', async () => {
    const wm   = makeWorkspaceManager();
    const repo = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'workspace'
          ? Promise.resolve([wsDoc('ws-rmerr')])
          : Promise.resolve([]),
      ),
      remove: vi.fn().mockRejectedValue(new Error('mongo write failed')),
    });
    const reaper = makeReaper({ repo, workspaceManager: wm });

    const summary = await reaper.sweepNow();

    // The stop + markReaped succeeded → id is in reaped
    expect(summary.reaped.workspaces).toContain('ws-rmerr');
    // The remove failure is recorded in errors[]
    expect(summary.errors.some(e => e.id === 'ws-rmerr')).toBe(true);
  });

  // 19. missing workspaceManager logs warn and skips workspace reap (not throw)
  it('19. missing workspaceManager logs a warn and skips reap (no throw)', async () => {
    const logger = makeLogger();
    const repo   = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'workspace'
          ? Promise.resolve([wsDoc('ws-orphan')])
          : Promise.resolve([]),
      ),
    });
    const reaper = makeReaper({ repo, logger }); // no workspaceManager

    const summary = await reaper.sweepNow();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('workspaceManager not configured'),
      expect.any(Object),
    );
    expect(summary.reaped.workspaces).toHaveLength(0);
    expect(repo.remove).not.toHaveBeenCalledWith(
      expect.objectContaining({ component: 'workspace' }),
    );
  });

  // 20. missing rpcKiller logs warn and skips rpc reap
  it('20. missing rpcKiller logs a warn and skips reap (no throw)', async () => {
    const logger = makeLogger();
    const repo   = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'rpc'
          ? Promise.resolve([rpcDoc('r-orphan')])
          : Promise.resolve([]),
      ),
    });
    const reaper = makeReaper({ repo, logger }); // no rpcKiller

    const summary = await reaper.sweepNow();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('rpcKiller not configured'),
      expect.any(Object),
    );
    expect(summary.reaped.rpcs).toHaveLength(0);
    expect(repo.remove).not.toHaveBeenCalledWith(
      expect.objectContaining({ component: 'rpc' }),
    );
  });

  // 21. workspaceManager.markReaped error doesn't prevent repo.remove
  it('21. markReaped error does not prevent repo.remove from running', async () => {
    const wm = makeWorkspaceManager({
      markReaped: vi.fn().mockRejectedValue(new Error('state machine error')),
    });
    const repo = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'workspace'
          ? Promise.resolve([wsDoc('ws-mark-fail')])
          : Promise.resolve([]),
      ),
    });
    const reaper = makeReaper({ repo, workspaceManager: wm });

    const summary = await reaper.sweepNow();

    // repo.remove should still have been called
    expect(repo.remove).toHaveBeenCalledWith({ component: 'workspace', id: 'ws-mark-fail' });
    // The markReaped failure is recorded in errors[]
    expect(summary.errors.some(e =>
      e.id === 'ws-mark-fail' && e.error.message === 'state machine error',
    )).toBe(true);
    // workspace is still in reaped list (stop succeeded, markReaped was best-effort)
    expect(summary.reaped.workspaces).toContain('ws-mark-fail');
  });

  // 22. detailed errors[] entry per failure includes { component, id, error }
  it('22. each errors[] entry has { component, id, error } shape', async () => {
    const stopErr = new Error('container not found');
    const wm      = makeWorkspaceManager({
      stopWorkspace: vi.fn().mockRejectedValue(stopErr),
    });
    const repo = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'workspace'
          ? Promise.resolve([wsDoc('ws-shape')])
          : Promise.resolve([]),
      ),
    });
    const reaper = makeReaper({ repo, workspaceManager: wm });

    const { errors } = await reaper.sweepNow();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      component: 'workspace',
      id:        'ws-shape',
      error:     stopErr,
    });
  });
});

describe('Reaper — logger.info on sweep complete', () => {
  it('calls logger.info("reaper sweep complete", summary) after every sweep', async () => {
    const logger = makeLogger();
    const reaper = makeReaper({ logger });

    const summary = await reaper.sweepNow();

    expect(logger.info).toHaveBeenCalledWith('reaper sweep complete', summary);
  });
});

// ─── Phase 6: InboxNotifier wiring tests ────────────────────────────────────

describe('Reaper — InboxNotifier wiring (Phase 6)', () => {
  // B2-1: notifier called with correct payload after workspace reap
  it('B2-1: calls notifyWorkspaceReaped with all four correct fields after workspace reap', async () => {
    const TS     = new Date('2024-03-15T12:00:00.000Z');
    const NOW_TS = new Date('2024-03-15T12:31:00.000Z'); // 31 minutes later → ageMs = 31 * 60_000
    const expectedAgeMs = NOW_TS.getTime() - TS.getTime();

    const repo = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'workspace'
          ? Promise.resolve([wsDocWithTs('ws-notify', TS, { synaps_user_id: 'user-99' })])
          : Promise.resolve([]),
      ),
    });
    const wm      = makeWorkspaceManager();
    const notifier = makeInboxNotifier();
    const reaper  = makeReaper({
      repo,
      workspaceManager: wm,
      inboxNotifier:    notifier,
      now:              () => NOW_TS,
    });

    await reaper.sweepNow();

    expect(notifier.notifyWorkspaceReaped).toHaveBeenCalledOnce();
    expect(notifier.notifyWorkspaceReaped).toHaveBeenCalledWith({
      workspaceId:  'ws-notify',
      synapsUserId: 'user-99',
      reason:       'stale_heartbeat',
      details:      {
        ageMs:     expectedAgeMs,
        threshold: 30 * 60_000, // default workspaceMs threshold
      },
    });
  });

  // B2-2: notifier error caught + warn-logged + reap still counted as success
  it('B2-2: notifier error is caught + warn-logged; workspace still appears in reaped list', async () => {
    const logger  = makeLogger();
    const repo    = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'workspace'
          ? Promise.resolve([wsDoc('ws-err-notify')])
          : Promise.resolve([]),
      ),
    });
    const wm      = makeWorkspaceManager();
    const notifier = makeInboxNotifier({
      notifyWorkspaceReaped: vi.fn().mockRejectedValue(new Error('inbox write failed')),
    });
    const reaper  = makeReaper({
      repo,
      workspaceManager: wm,
      inboxNotifier:    notifier,
      logger,
    });

    const summary = await reaper.sweepNow();

    // Reap still counted as success
    expect(summary.reaped.workspaces).toContain('ws-err-notify');
    // No additional errors[] entry for notifier failure (it's warn-only)
    expect(summary.errors).toHaveLength(0);
    // Warn was logged
    expect(logger.warn).toHaveBeenCalledWith(
      'inbox notify failed',
      expect.objectContaining({ workspaceId: 'ws-err-notify', err: 'inbox write failed' }),
    );
  });

  // B2-3: rpc reap does NOT call notifier (layer-boundary discipline)
  it('B2-3: rpc reap does NOT call inboxNotifier (layer-boundary discipline)', async () => {
    const killer  = makeRpcKiller();
    const notifier = makeInboxNotifier();
    const repo    = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'rpc'
          ? Promise.resolve([rpcDoc('sess-boundary')])
          : Promise.resolve([]),
      ),
    });
    const reaper = makeReaper({
      repo,
      rpcKiller:     killer,
      inboxNotifier: notifier,
    });

    await reaper.sweepNow();

    expect(killer).toHaveBeenCalledWith('sess-boundary');
    expect(notifier.notifyWorkspaceReaped).not.toHaveBeenCalled();
  });

  // B2-4: scp-stale warn does NOT call notifier
  it('B2-4: scp-stale warn path does NOT call inboxNotifier', async () => {
    const notifier = makeInboxNotifier();
    const repo    = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'scp'
          ? Promise.resolve([scpDoc('scp-boundary')])
          : Promise.resolve([]),
      ),
    });
    const reaper = makeReaper({
      repo,
      inboxNotifier: notifier,
    });

    await reaper.sweepNow();

    expect(notifier.notifyWorkspaceReaped).not.toHaveBeenCalled();
  });

  // B2-5: inboxNotifier null → no calls + no errors (back-compat with Phase 5)
  it('B2-5: inboxNotifier null → notifier never called + no errors (Phase 5 back-compat)', async () => {
    const repo = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'workspace'
          ? Promise.resolve([wsDoc('ws-compat')])
          : Promise.resolve([]),
      ),
    });
    const wm   = makeWorkspaceManager();
    // Explicitly pass null (same as omitting it in makeReaper)
    const reaper = makeReaper({ repo, workspaceManager: wm, inboxNotifier: null });

    const summary = await reaper.sweepNow();

    // Workspace reaped successfully
    expect(summary.reaped.workspaces).toContain('ws-compat');
    expect(summary.errors).toHaveLength(0);
    // No notifier was used — no interference
  });

  // B2-6: synapsUserId from heartbeat.details.synaps_user_id when present, null otherwise
  it('B2-6: synapsUserId is null when heartbeat.details.synaps_user_id is absent', async () => {
    const repo = makeRepo({
      findStale: vi.fn().mockImplementation(({ component }) =>
        component === 'workspace'
          // doc has no details.synaps_user_id
          ? Promise.resolve([{ component: 'workspace', id: 'ws-noid', details: {} }])
          : Promise.resolve([]),
      ),
    });
    const wm       = makeWorkspaceManager();
    const notifier = makeInboxNotifier();
    const reaper   = makeReaper({
      repo,
      workspaceManager: wm,
      inboxNotifier:    notifier,
    });

    await reaper.sweepNow();

    expect(notifier.notifyWorkspaceReaped).toHaveBeenCalledOnce();
    expect(notifier.notifyWorkspaceReaped).toHaveBeenCalledWith(
      expect.objectContaining({ synapsUserId: null }),
    );
  });
});

