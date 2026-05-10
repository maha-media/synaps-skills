/**
 * @file tests/scp-phase-6/04-phase-6-disabled.test.mjs
 *
 * Tests that all Phase 6 subsystems degrade gracefully when disabled.
 *
 * Strategy
 * ────────
 * • All three sections disabled (scheduler, hooks, supervisor/heartbeat):
 *   NoopScheduler, NoopHookBus, NoopInboxNotifier, no heartbeatRepo.
 * • ControlSocket ops return correct *_disabled codes.
 * • InboxNotifier noop returns { written: false, reason: 'noop' }.
 * • NoopScheduler returns SchedulerDisabledError on all domain ops.
 * • NoopHookBus returns empty summary on emit().
 *
 * ≥ 4 tests
 */

import { describe, it, expect } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';

import { ControlSocket }                  from '../../bridge/control-socket.js';
import { NoopScheduler, SchedulerDisabledError } from '../../bridge/core/scheduler.js';
import { NoopHookBus }                    from '../../bridge/core/hook-bus.js';
import { NoopInboxNotifier }              from '../../bridge/core/inbox-notifier.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let socketCounter = 0;
function tmpSocketPath() {
  return path.join(os.tmpdir(), `cs-disabled-${process.pid}-${++socketCounter}.sock`);
}

function makeFakeRouter() {
  return {
    liveSessions: () => [],
    listSessions: async () => [],
    closeSession: async () => {},
  };
}

function sendRequest(socketPath, req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    sock.on('connect', () => { sock.write(JSON.stringify(req) + '\n'); });
    sock.on('data', (c)  => { buf += c.toString('utf8'); });
    sock.on('end',  ()   => {
      try { resolve(JSON.parse(buf.trim())); }
      catch (e) { reject(new Error(`Could not parse: ${buf}`)); }
    });
    sock.on('error', reject);
  });
}

// ─── 1. Scheduler disabled → scheduler_disabled codes ────────────────────────

describe('Phase 6 disabled — NoopScheduler ControlSocket ops', () => {
  let cs;
  let socketPath;

  const setup = async () => {
    socketPath = tmpSocketPath();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      scheduler:     new NoopScheduler(),
      // hookBus, heartbeatRepo intentionally omitted
      logger: silent,
    });
    await cs.start();
  };

  const teardown = async () => { await cs.stop(); };

  it('scheduled_task_create → code:scheduler_disabled', async () => {
    await setup();
    const resp = await sendRequest(socketPath, {
      op:             'scheduled_task_create',
      synaps_user_id: 'user-1',
      institution_id: 'inst-1',
      name:           'n',
      cron:           '* * * * *',
      channel:        'c',
      prompt:         'p',
    });
    await teardown();
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('scheduler_disabled');
  });

  it('scheduled_task_list → code:scheduler_disabled', async () => {
    await setup();
    const resp = await sendRequest(socketPath, {
      op:             'scheduled_task_list',
      synaps_user_id: 'user-1',
    });
    await teardown();
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('scheduler_disabled');
  });

  it('scheduled_task_remove → code:scheduler_disabled', async () => {
    await setup();
    const resp = await sendRequest(socketPath, {
      op:             'scheduled_task_remove',
      id:             'task-1',
      synaps_user_id: 'user-1',
    });
    await teardown();
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('scheduler_disabled');
  });
});

// ─── 2. Hooks disabled → hooks_disabled codes ─────────────────────────────────

describe('Phase 6 disabled — NoopHookBus ControlSocket ops', () => {
  let cs;
  let socketPath;

  const setup = async () => {
    socketPath = tmpSocketPath();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      hookBus:       new NoopHookBus(),
      // hookRepo intentionally omitted
      logger: silent,
    });
    await cs.start();
  };

  const teardown = async () => { await cs.stop(); };

  it('hook_create → code:hooks_disabled', async () => {
    await setup();
    const resp = await sendRequest(socketPath, {
      op:     'hook_create',
      scope:  { type: 'global' },
      event:  'pre_tool',
      action: { type: 'webhook', config: { url: 'https://x.com', secret: 's' } },
    });
    await teardown();
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('hooks_disabled');
  });

  it('hook_list → code:hooks_disabled', async () => {
    await setup();
    const resp = await sendRequest(socketPath, { op: 'hook_list' });
    await teardown();
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('hooks_disabled');
  });

  it('hook_remove → code:hooks_disabled', async () => {
    await setup();
    const resp = await sendRequest(socketPath, { op: 'hook_remove', id: 'hook-1' });
    await teardown();
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('hooks_disabled');
  });
});

// ─── 3. Supervisor disabled → heartbeat_emit noop ─────────────────────────────

describe('Phase 6 disabled — no heartbeatRepo → supervisor:noop', () => {
  it('heartbeat_emit returns { ok:true, supervisor:"noop" } when repo absent', async () => {
    const socketPath = tmpSocketPath();
    const cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      // heartbeatRepo intentionally absent
      logger: silent,
    });
    await cs.start();

    const resp = await sendRequest(socketPath, {
      op:             'heartbeat_emit',
      component:      'workspace',
      id:             'ws-1',
      synaps_user_id: 'user-1',
    });

    await cs.stop();

    expect(resp.ok).toBe(true);
    expect(resp.supervisor).toBe('noop');
  });
});

// ─── 4. NoopInboxNotifier writes nothing ──────────────────────────────────────

describe('Phase 6 disabled — NoopInboxNotifier', () => {
  it('returns { written: false, reason: "noop" } without touching the filesystem', async () => {
    const noop   = new NoopInboxNotifier();
    const result = await noop.notifyWorkspaceReaped({
      workspaceId:  'ws-noop',
      synapsUserId: 'user-1',
      reason:       'stale_heartbeat',
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe('noop');
  });
});

// ─── 5. NoopScheduler domain ops throw SchedulerDisabledError ────────────────

describe('Phase 6 disabled — NoopScheduler throws correctly', () => {
  const noop = new NoopScheduler();

  it('create() throws SchedulerDisabledError', async () => {
    await expect(noop.create({})).rejects.toThrow(SchedulerDisabledError);
  });

  it('list() throws SchedulerDisabledError', async () => {
    await expect(noop.list({})).rejects.toThrow(SchedulerDisabledError);
  });

  it('remove() throws SchedulerDisabledError', async () => {
    await expect(noop.remove('id')).rejects.toThrow(SchedulerDisabledError);
  });
});

// ─── 6. NoopHookBus emit always returns empty ─────────────────────────────────

describe('Phase 6 disabled — NoopHookBus emit', () => {
  it('emit() always returns { fired:0, blocked:false, results:[] }', async () => {
    const noop   = new NoopHookBus();
    const result = await noop.emit('pre_tool', { tool: 'bash' });
    expect(result).toEqual({ fired: 0, blocked: false, results: [] });
  });
});
