/**
 * @file tests/scp-phase-5/01-reaper-end-to-end.test.mjs
 *
 * Acceptance tests for Reaper wired to a real mongo-memory-server.
 *
 * Strategy
 * ────────
 * • MongoMemoryServer provides real in-process MongoDB.
 * • makeHeartbeatRepo(m) builds the production HeartbeatRepo.
 * • workspaceManager and rpcKiller are vi.fn() stubs — this test exercises the
 *   reaper's orchestration logic, not the actual container/rpc kill mechanics.
 * • sweepNow() is called directly; no timers needed (we don't exercise
 *   start()/stop() scheduling — that lives in the unit tests in reaper.test.js).
 * • Stale timestamps are seeded directly via repo.record() with an injectable
 *   `now` clock (past date) so we can set them behind the threshold.
 *
 * Scenarios (6 tests)
 * ────────────────────
 * 1. workspace stale > 30 min → stopWorkspace called with id; row deleted.
 * 2. rpc stale > 5 min → rpcKiller called with id; row deleted.
 * 3. scp stale 31 s → no kill; row preserved; warn logged.
 * 4. Mixed sweep: 2 workspaces + 1 rpc + 1 scp → summary correctly populated.
 * 5. workspaceManager.stopWorkspace throws → error captured in summary;
 *    sweep continues (remaining targets processed).
 * 6. Fresh heartbeat (1 s old) is NOT reaped even if workspace threshold is 30 min.
 *
 * Constraints
 * ───────────
 * • ESM only (.mjs)
 * • beforeAll timeout ≥ 60_000 for mongo-memory-server.
 * • No top-level await.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { makeHeartbeatRepo }  from '../../bridge/core/db/index.js';
import { makeHeartbeatModel } from '../../bridge/core/db/models/synaps-heartbeat.js';
import { Reaper }             from '../../bridge/core/reaper.js';

// ─── Module-level fixtures ────────────────────────────────────────────────────

let mongod;
let m;   // private mongoose.Mongoose instance

/** Silent logger that also captures warn calls for assertion. */
function makeSilentLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

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

beforeEach(async () => {
  const Heartbeat = makeHeartbeatModel(m);
  await Heartbeat.deleteMany({});
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a repo whose `now` is fixed to `fixedDate` so that record() writes that
 * ts.  Used to seed a heartbeat that is already stale from the real clock's PoV.
 */
function repoAt(date) {
  return makeHeartbeatRepo(m, { now: () => date });
}

/** Real-clock repo for assertions (findAll, remove, etc.). */
function realRepo() {
  return makeHeartbeatRepo(m);
}

function makeWorkspaceManager() {
  return {
    stopWorkspace: vi.fn().mockResolvedValue(undefined),
    markReaped:    vi.fn().mockResolvedValue(undefined),
  };
}

function makeRpcKiller() {
  return vi.fn().mockResolvedValue(undefined);
}

function buildReaper({ logger, workspaceManager, rpcKiller, thresholds } = {}) {
  return new Reaper({
    repo:             realRepo(),
    workspaceManager: workspaceManager ?? makeWorkspaceManager(),
    rpcKiller:        rpcKiller        ?? makeRpcKiller(),
    intervalMs:       60_000,
    logger:           logger           ?? makeSilentLogger(),
    thresholds,
    // Inject a no-op setInterval so start() doesn't schedule real timers.
    setInterval:   () => null,
    clearInterval: () => {},
  });
}

// ─── 1. Stale workspace → stopWorkspace + row deleted ─────────────────────────

describe('Reaper — stale workspace is reaped', () => {
  it('calls stopWorkspace and deletes the heartbeat row', async () => {
    const STALE_DATE = new Date(Date.now() - 31 * 60_000); // 31 min ago
    await repoAt(STALE_DATE).record({ component: 'workspace', id: 'ws_stale_01', healthy: true });

    const wm     = makeWorkspaceManager();
    const reaper = buildReaper({ workspaceManager: wm });
    const summary = await reaper.sweepNow();

    expect(wm.stopWorkspace).toHaveBeenCalledOnce();
    expect(wm.stopWorkspace).toHaveBeenCalledWith('ws_stale_01');

    expect(summary.reaped.workspaces).toContain('ws_stale_01');
    expect(summary.errors).toHaveLength(0);

    // Row must be gone.
    const remaining = await realRepo().findAll();
    expect(remaining.find((r) => r.id === 'ws_stale_01')).toBeUndefined();
  });
});

// ─── 2. Stale rpc → rpcKiller + row deleted ───────────────────────────────────

describe('Reaper — stale rpc is reaped', () => {
  it('calls rpcKiller and deletes the heartbeat row', async () => {
    const STALE_DATE = new Date(Date.now() - 6 * 60_000); // 6 min ago
    await repoAt(STALE_DATE).record({ component: 'rpc', id: 'sess_stale_01', healthy: true });

    const killer = makeRpcKiller();
    const reaper = buildReaper({ rpcKiller: killer });
    const summary = await reaper.sweepNow();

    expect(killer).toHaveBeenCalledOnce();
    expect(killer).toHaveBeenCalledWith('sess_stale_01');

    expect(summary.reaped.rpcs).toContain('sess_stale_01');
    expect(summary.errors).toHaveLength(0);

    const remaining = await realRepo().findAll();
    expect(remaining.find((r) => r.id === 'sess_stale_01')).toBeUndefined();
  });
});

// ─── 3. Stale scp → warn only, row preserved ─────────────────────────────────

describe('Reaper — stale scp logs warn and preserves the row', () => {
  it('emits a warn log for stale scp and does NOT delete the row', async () => {
    const STALE_DATE = new Date(Date.now() - 31_000); // 31 s ago
    await repoAt(STALE_DATE).record({ component: 'scp', id: 'scp_main', healthy: true });

    const logger = makeSilentLogger();
    const reaper = buildReaper({ logger });
    const summary = await reaper.sweepNow();

    // Must appear in scpStale, not in reaped.
    expect(summary.scpStale).toContain('scp_main');
    expect(summary.reaped.workspaces).toHaveLength(0);
    expect(summary.reaped.rpcs).toHaveLength(0);
    expect(summary.errors).toHaveLength(0);

    // Row must still be in the DB.
    const remaining = await realRepo().findAll();
    expect(remaining.find((r) => r.id === 'scp_main')).toBeDefined();

    // At least one warn call must reference scp stale.
    const warnedScp = logger.warn.mock.calls.some(
      (args) => String(args[0]).includes('scp'),
    );
    expect(warnedScp).toBe(true);
  });
});

// ─── 4. Mixed sweep summary ────────────────────────────────────────────────────

describe('Reaper — mixed sweep produces correct summary', () => {
  it('2 workspaces + 1 rpc + 1 scp all handled correctly in one sweep', async () => {
    const W_STALE   = new Date(Date.now() - 31 * 60_000);
    const RPC_STALE = new Date(Date.now() - 6  * 60_000);
    const SCP_STALE = new Date(Date.now() - 31_000);

    await repoAt(W_STALE).record({ component: 'workspace', id: 'ws_mix_01' });
    await repoAt(W_STALE).record({ component: 'workspace', id: 'ws_mix_02' });
    await repoAt(RPC_STALE).record({ component: 'rpc',  id: 'sess_mix_01' });
    await repoAt(SCP_STALE).record({ component: 'scp',  id: 'scp_mix_main' });

    const wm     = makeWorkspaceManager();
    const killer = makeRpcKiller();
    const reaper = buildReaper({ workspaceManager: wm, rpcKiller: killer });
    const summary = await reaper.sweepNow();

    // Workspaces
    expect(summary.reaped.workspaces.sort()).toEqual(['ws_mix_01', 'ws_mix_02']);
    expect(wm.stopWorkspace).toHaveBeenCalledTimes(2);

    // RPCs
    expect(summary.reaped.rpcs).toEqual(['sess_mix_01']);
    expect(killer).toHaveBeenCalledOnce();

    // SCP
    expect(summary.scpStale).toEqual(['scp_mix_main']);

    // Errors
    expect(summary.errors).toHaveLength(0);

    // Workspace and rpc rows must be gone; scp row preserved.
    const remaining = await realRepo().findAll();
    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).not.toContain('ws_mix_01');
    expect(remainingIds).not.toContain('ws_mix_02');
    expect(remainingIds).not.toContain('sess_mix_01');
    expect(remainingIds).toContain('scp_mix_main');
  });
});

// ─── 5. stopWorkspace throws → error captured, sweep continues ────────────────

describe('Reaper — stopWorkspace error is captured; sweep continues', () => {
  it('records error in summary but still processes remaining workspaces', async () => {
    const W_STALE = new Date(Date.now() - 31 * 60_000);
    await repoAt(W_STALE).record({ component: 'workspace', id: 'ws_boom' });
    await repoAt(W_STALE).record({ component: 'workspace', id: 'ws_ok' });

    const wm = makeWorkspaceManager();
    wm.stopWorkspace.mockImplementationOnce(async (id) => {
      if (id === 'ws_boom') throw new Error('docker timeout');
    });

    const reaper = buildReaper({ workspaceManager: wm });
    const summary = await reaper.sweepNow();

    // ws_boom errored — should be in errors[], NOT in reaped.
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].id).toBe('ws_boom');
    expect(summary.errors[0].error.message).toMatch(/docker timeout/);

    // ws_ok should have been reaped successfully.
    expect(summary.reaped.workspaces).toContain('ws_ok');
    expect(summary.reaped.workspaces).not.toContain('ws_boom');

    // ws_ok row deleted; ws_boom row NOT deleted (continue skipped repo.remove).
    const remaining = await realRepo().findAll();
    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).toContain('ws_boom');
    expect(remainingIds).not.toContain('ws_ok');
  });
});

// ─── 6. Fresh heartbeat is not reaped ────────────────────────────────────────

describe('Reaper — fresh heartbeat is NOT reaped', () => {
  it('ignores a workspace heartbeat that is only 1 second old', async () => {
    const FRESH_DATE = new Date(Date.now() - 1_000); // 1 s ago
    await repoAt(FRESH_DATE).record({ component: 'workspace', id: 'ws_fresh', healthy: true });

    const wm = makeWorkspaceManager();
    const reaper = buildReaper({ workspaceManager: wm });
    const summary = await reaper.sweepNow();

    expect(wm.stopWorkspace).not.toHaveBeenCalled();
    expect(summary.reaped.workspaces).toHaveLength(0);
    expect(summary.errors).toHaveLength(0);

    // Row must still be in the DB.
    const remaining = await realRepo().findAll();
    expect(remaining.find((r) => r.id === 'ws_fresh')).toBeDefined();
  });
});
