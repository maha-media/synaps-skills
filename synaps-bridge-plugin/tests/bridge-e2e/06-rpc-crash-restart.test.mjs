/**
 * @file 06-rpc-crash-restart.test.mjs
 *
 * E2E test: inject a "crash" prompt → fake rpc child exits non-zero →
 * SessionRouter auto-restarts the child → a follow-up message succeeds.
 *
 * Validates spec §7.2 (rpc crash → restart) and SUBAGENT_BRIEF §7.
 *
 * Timing considerations:
 *   - The SlackAdapter swallows the rpc.prompt rejection (code path §11 in index.js).
 *   - SessionRouter's _onRpcExit fires after the child exits, detects code≠0,
 *     and spawns a new rpc child (emits 'session_restarted').
 *   - We wait for 'session_restarted' then inject a second message.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildDaemon, waitFor, findCalls, tmpStateDir, cleanupStateDir } from './helpers.mjs';

describe('06 — rpc crash + restart', () => {
  let daemon, fakeApp, stateDir;

  afterEach(async () => {
    if (daemon) {
      await daemon.stop().catch(() => {});
      daemon = null;
    }
    if (stateDir) {
      cleanupStateDir(stateDir);
      stateDir = null;
    }
  });

  it('crash prompt causes restart; subsequent message succeeds', async () => {
    stateDir = tmpStateDir();
    ({ daemon, fakeApp } = buildDaemon({ stateDir }));
    await daemon.start();

    const CHANNEL = 'C006';
    const THREAD = '666.001';
    const SESSION_KEY = `slack:${CHANNEL}:${THREAD}`;

    // Track session_restarted event.
    let restarted = false;

    // We need to subscribe to the router's event AFTER daemon.start() creates it.
    const router = daemon._sessionRouter;
    router.on('session_restarted', ({ key }) => {
      if (key === SESSION_KEY) restarted = true;
    });

    // 1. Inject a "crash" message — the rpc child will exit non-zero.
    // injectEvent() awaits the event handler which itself awaits rpc.prompt().
    // rpc.prompt() will reject (child exited) but SlackAdapter catches it.
    // We don't await here; the handler will settle quickly (crash is immediate).
    const crashPromise = fakeApp.injectEvent('message', {
      channel: CHANNEL,
      channel_type: 'im',
      ts: THREAD,
      thread_ts: THREAD,
      text: 'crash please',
      user: 'U006',
      files: [],
    });

    // Wait for the crash to complete and the child to be restarted.
    await waitFor(
      () => restarted,
      { timeoutMs: 4000, message: 'expected session_restarted event after crash' },
    );

    // Ensure the crash promise settled (don't leave hanging).
    await crashPromise.catch(() => {});

    // 2. Inject a follow-up message — should succeed with the restarted child.
    await fakeApp.injectEvent('message', {
      channel: CHANNEL,
      channel_type: 'im',
      ts: '666.002',
      thread_ts: THREAD,
      text: 'ack after restart',
      user: 'U006',
      files: [],
    });

    // Wait for the follow-up stream to complete.
    await waitFor(
      () => findCalls(fakeApp, 'chat.stopStream').length >= 1,
      { timeoutMs: 3000, message: 'expected chat.stopStream after restart' },
    );

    // 3. Assertions.

    // session_restarted was emitted.
    expect(restarted).toBe(true);

    // After restart, stopStream was called (follow-up succeeded).
    const stopCalls = findCalls(fakeApp, 'chat.stopStream');
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);

    // startStream was called for the follow-up.
    const startCalls = findCalls(fakeApp, 'chat.startStream');
    expect(startCalls.length).toBeGreaterThanOrEqual(1);

    // The router still has the session live after restart.
    const sessions = router.liveSessions();
    const session = sessions.find((s) => s.key === SESSION_KEY);
    expect(session).toBeDefined();
  });
});
