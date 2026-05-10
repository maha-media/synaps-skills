/**
 * @file 05-multi-thread-isolation.test.mjs
 *
 * E2E test: inject messages to two different threads and verify:
 *   1. Two distinct sessions exist in the session router.
 *   2. Each chat.startStream call is tagged with the correct thread_ts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildDaemon, waitFor, findCalls, tmpStateDir, cleanupStateDir } from './helpers.mjs';

describe('05 — multi-thread isolation', () => {
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

  it('two threads produce two isolated sessions with correct thread_ts on startStream', async () => {
    stateDir = tmpStateDir();
    ({ daemon, fakeApp } = buildDaemon({ stateDir }));
    await daemon.start();

    // Inject messages on two different thread timestamps (same channel).
    const thread1 = '555.001';
    const thread2 = '555.002';

    // Message to thread 1.
    const p1 = fakeApp.injectEvent('message', {
      channel: 'C005',
      channel_type: 'im',
      ts: thread1,
      thread_ts: thread1,
      text: 'ack for thread one',
      user: 'U005',
      files: [],
    });

    // Message to thread 2 — injected concurrently.
    const p2 = fakeApp.injectEvent('message', {
      channel: 'C005',
      channel_type: 'im',
      ts: thread2,
      thread_ts: thread2,
      text: 'ack for thread two',
      user: 'U005',
      files: [],
    });

    // Both resolve when their respective prompts complete.
    await Promise.all([p1, p2]);

    // Wait until both streams are stopped.
    await waitFor(
      () => findCalls(fakeApp, 'chat.stopStream').length >= 2,
      { timeoutMs: 3000, message: 'expected 2 chat.stopStream calls' },
    );

    // 1. Two distinct sessions in the router.
    const sessions = daemon._sessionRouter.liveSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(2);

    const keys = sessions.map((s) => s.key);
    expect(keys).toContain(`slack:C005:${thread1}`);
    expect(keys).toContain(`slack:C005:${thread2}`);

    // 2. Two startStream calls with distinct thread_ts values.
    const startCalls = findCalls(fakeApp, 'chat.startStream');
    expect(startCalls.length).toBeGreaterThanOrEqual(2);

    const threadTsValues = startCalls.map((c) => c.args.thread_ts);
    expect(threadTsValues).toContain(thread1);
    expect(threadTsValues).toContain(thread2);
  });
});
