/**
 * @file 03-subagent-lifecycle.test.mjs
 *
 * E2E test: inject a "subagent" prompt and verify the subagent lifecycle
 * is surfaced as task_update chunks with status transitions.
 *
 * The fake rpc emits:
 *   subagent_start  { subagent_id: 'SA1', agent_name: 'sub-worker', task_preview: 'doing work' }
 *   subagent_update { subagent_id: 'SA1', agent_name: 'sub-worker', status: 'in_progress' }
 *   subagent_done   { subagent_id: 'SA1', agent_name: 'sub-worker', result_preview: 'done', ... }
 *   text_delta "summary"
 *   agent_end
 *
 * SubagentTracker coerces 'in_progress' → 'running' and 'done' is its own state.
 * StreamingProxy passes the tracker's status values verbatim into task_update.task.status.
 *
 * Observed status progression:
 *   subagent_start  → status = 'running'
 *   subagent_update → status = 'running'   (in_progress coerced to running)
 *   subagent_done   → status = 'done'
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildDaemon, waitFor, findCalls, tmpStateDir, cleanupStateDir } from './helpers.mjs';

describe('03 — subagent lifecycle', () => {
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

  it('subagent: appendStream task_update status transitions include running then done for SA1', async () => {
    stateDir = tmpStateDir();
    ({ daemon, fakeApp } = buildDaemon({ stateDir }));
    await daemon.start();

    await fakeApp.injectEvent('message', {
      channel: 'C003',
      channel_type: 'im',
      ts: '333.001',
      thread_ts: '333.001',
      text: 'subagent test please',
      user: 'U003',
      files: [],
    });

    // Wait for the full stream to finish.
    await waitFor(
      () => findCalls(fakeApp, 'chat.stopStream').length >= 1,
      { timeoutMs: 3000, message: 'expected chat.stopStream (subagent)' },
    );

    const appendCalls = findCalls(fakeApp, 'chat.appendStream');

    // 1. At least one appendStream is a task_update.
    const taskUpdates = appendCalls.filter((c) => Array.isArray(c.args.chunks) && c.args.chunks.some((x) => x.type === 'task_update'));
    expect(taskUpdates.length).toBeGreaterThanOrEqual(1);

    // 2. At least one task_update is for 'SA1'.
    const saUpdates = taskUpdates.filter(
      (c) => Array.isArray(c.args.chunks) && c.args.chunks.some((x) => x.type === 'task_update' && x.task_update?.id === 'SA1'),
    );
    expect(saUpdates.length).toBeGreaterThanOrEqual(2);

    // 3. The final SA1 task_update has status 'done'.
    // (SubagentTracker maps 'done' from subagent_done events.)
    const statuses = saUpdates.map((c) => c.args.chunks.find((x) => x.type === 'task_update').task_update.status);
    expect(statuses).toContain('done');

    // 4. 'done' is the last status emitted — earlier ones are 'running'.
    const lastStatus = statuses[statuses.length - 1];
    expect(lastStatus).toBe('done');
    // Earlier status(es) must be 'running'.
    expect(statuses[0]).toBe('running');
  });
});
