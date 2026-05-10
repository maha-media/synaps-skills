/**
 * @file 01-prompt-streams-text.test.mjs
 *
 * E2E test: inject a "streams_text" prompt and verify the Slack streaming
 * call sequence: startStream → appendStream (×≥2) → stopStream.
 *
 * The fake rpc emits:
 *   text_delta "Hello, "  →  text_delta "world!"  →  agent_end
 *
 * The streaming-proxy debounces at 80 chars or 250 ms.  With only 13 chars
 * total the 250 ms timer fires and flushes in one appendStream call.  However
 * the StreamHandle may also be called from proxy.stop() before the timer fires.
 * We assert on the *cumulative* text, not the exact number of chunks.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildDaemon, waitFor, findCalls, tmpStateDir, cleanupStateDir } from './helpers.mjs';

describe('01 — prompt streams text', () => {
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

  it('streams text correctly: startStream → appendStream×≥1 → stopStream with cumulative text "Hello, world!"', async () => {
    stateDir = tmpStateDir();
    ({ daemon, fakeApp } = buildDaemon({ stateDir }));

    await daemon.start();

    // Inject assistant_thread_started so the session context is set.
    await fakeApp.injectEvent('assistant_thread_started', {
      assistant_thread: {
        channel_id: 'C001',
        thread_ts: '111.111',
      },
    });

    // Inject a user message with "streams_text" trigger.
    await fakeApp.injectEvent('message', {
      channel: 'C001',
      channel_type: 'im',
      ts: '111.222',
      thread_ts: '111.111',
      text: 'streams_text please',
      user: 'U001',
      files: [],
    });

    // Wait for stopStream to be called (end of stream).
    await waitFor(
      () => findCalls(fakeApp, 'chat.stopStream').length >= 1,
      { timeoutMs: 3000, message: 'expected chat.stopStream to be called' },
    );

    // ── assertions ────────────────────────────────────────────────────────

    // 1. startStream called once.
    const startCalls = findCalls(fakeApp, 'chat.startStream');
    expect(startCalls).toHaveLength(1);

    // 2. appendStream called at least once.
    const appendCalls = findCalls(fakeApp, 'chat.appendStream');
    expect(appendCalls.length).toBeGreaterThanOrEqual(1);

    // 3. stopStream called once.
    const stopCalls = findCalls(fakeApp, 'chat.stopStream');
    expect(stopCalls).toHaveLength(1);

    // 4. Cumulative text equals "Hello, world!".
    const allText = appendCalls
      .filter((c) => typeof c.args.markdown_text === 'string')
      .map((c) => c.args.markdown_text ?? '')
      .join('');
    expect(allText).toBe('Hello, world!');
  });
});
