/**
 * @file 02-tool-progress-routes.test.mjs
 *
 * E2E test: inject a "tool_call" prompt and verify tool progress
 * is routed through chat.appendStream as task_update chunks.
 *
 * The fake rpc emits:
 *   text_delta "Looking up... "
 *   toolcall_start { tool_id: 'T1', tool_name: 'read_messages' }
 *   toolcall_input { tool_id: 'T1', input: { q: 'latest' } }
 *   toolcall_result { tool_id: 'T1', result: 'ok' }
 *   text_delta "done."
 *   agent_end
 *
 * The StreamingProxy routes tool events to appendStream as task_update
 * chunks (status: 'in_progress' or 'complete') when richStreamChunks=true.
 *
 * Note: The 'complete' status is emitted from _handleToolcallResult which is
 * an async event handler — it may be dispatched concurrently with proxy.stop().
 * We poll for the 'complete' status explicitly with generous timeout.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildDaemon, waitFor, findCalls, tmpStateDir, cleanupStateDir } from './helpers.mjs';

/**
 * Poll until at least one task_update chunk for toolId carries the given status,
 * or until timeoutMs elapses.
 *
 * Returns the full list of matching task_update statuses at that point.
 *
 * @param {import('./fake-bolt-client.mjs').FakeBoltApp} app
 * @param {string} toolId
 * @param {string} status
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<string[]>}
 */
async function waitForToolStatus(app, toolId, status, timeoutMs = 2000) {
  await waitFor(
    () => {
      const updates = findCalls(app, 'chat.appendStream').filter(
        (c) => Array.isArray(c.args.chunks) && c.args.chunks.some((x) => x.type === 'task_update' && x.task_update?.id === toolId),
      );
      return updates.some((c) => c.args.chunks.find((x) => x.type === 'task_update').task_update.status === status);
    },
    { timeoutMs, message: `task_update status '${status}' for tool '${toolId}' never appeared` },
  );

  return findCalls(app, 'chat.appendStream')
    .filter(
      (c) => Array.isArray(c.args.chunks) && c.args.chunks.some((x) => x.type === 'task_update' && x.task_update?.id === toolId),
    )
    .map((c) => c.args.chunks.find((x) => x.type === 'task_update').task_update.status);
}

describe('02 — tool progress routes', () => {
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

  it('tool_call: appendStream carries task_update with id:T1 in_progress and complete statuses', async () => {
    stateDir = tmpStateDir();
    ({ daemon, fakeApp } = buildDaemon({ stateDir }));
    await daemon.start();

    // Inject message and wait for it to complete.
    await fakeApp.injectEvent('message', {
      channel: 'C002',
      channel_type: 'im',
      ts: '222.001',
      thread_ts: '222.001',
      text: 'tool_call please',
      user: 'U002',
      files: [],
    });

    // injectEvent() awaited the full handler (proxy.start → rpc.prompt → proxy.stop).
    // However, _handleToolcallResult is an async method called fire-and-forget from
    // the synchronous EventEmitter dispatch, so its appendStream call for 'complete'
    // may still be in-flight when the handler returns. Poll explicitly instead of
    // relying on a fixed settle window.

    // 1. in_progress must appear first (toolcall_start / toolcall_input).
    // 2. Then wait for 'complete' (toolcall_result) — with up to 2 s.
    const statuses = await waitForToolStatus(fakeApp, 'T1', 'complete', 2000);

    // 3. At least one appendStream call is a task_update for T1.
    expect(statuses.length).toBeGreaterThanOrEqual(1);

    // 4. in_progress status appears (from toolcall_start or toolcall_input).
    expect(statuses).toContain('in_progress');

    // 5. complete status appears (from toolcall_result → status='done' → 'complete').
    expect(statuses).toContain('complete');

    // 6. complete appears after in_progress.
    const firstInProgress = statuses.indexOf('in_progress');
    const lastComplete = statuses.lastIndexOf('complete');
    expect(lastComplete).toBeGreaterThan(firstInProgress);
  });
});
