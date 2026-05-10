/**
 * @file subagent-tracker.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentTracker } from './subagent-tracker.js';

// ── helpers ───────────────────────────────────────────────────────────────────

let now = 1_000_000;
const nowMs = () => now;

function makeTracker() {
  now = 1_000_000;
  return new SubagentTracker({ nowMs });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('SubagentTracker', () => {
  it('onStart creates entry with status="running"', () => {
    const t = makeTracker();
    t.onStart({ subagent_id: 'S1', agent_name: 'helper', task_preview: 'do stuff' });

    const entry = t.get('S1');
    expect(entry).toBeDefined();
    expect(entry.id).toBe('S1');
    expect(entry.agent_name).toBe('helper');
    expect(entry.status).toBe('running');
    expect(entry.task_preview).toBe('do stuff');
    expect(entry.startedAt).toBe(1_000_000);
  });

  it('onStart without task_preview does not set the field', () => {
    const t = makeTracker();
    t.onStart({ subagent_id: 'S1', agent_name: 'helper' });
    const entry = t.get('S1');
    expect('task_preview' in entry).toBe(false);
  });

  it('onUpdate with status="in_progress" coerces to "running"', () => {
    const t = makeTracker();
    t.onStart({ subagent_id: 'S1', agent_name: 'helper' });
    now = 1_001_000;
    t.onUpdate({ subagent_id: 'S1', agent_name: 'helper', status: 'in_progress' });

    const entry = t.get('S1');
    expect(entry.status).toBe('running');
    expect(entry.updatedAt).toBe(1_001_000);
  });

  it('onUpdate with status="pending" keeps "pending"', () => {
    const t = makeTracker();
    t.onStart({ subagent_id: 'S1', agent_name: 'helper' });
    t.onUpdate({ subagent_id: 'S1', agent_name: 'helper', status: 'pending' });
    expect(t.get('S1').status).toBe('pending');
  });

  it('onUpdate with status="running" keeps "running"', () => {
    const t = makeTracker();
    t.onStart({ subagent_id: 'S1', agent_name: 'helper' });
    t.onUpdate({ subagent_id: 'S1', agent_name: 'helper', status: 'running' });
    expect(t.get('S1').status).toBe('running');
  });

  it('onUpdate with arbitrary status defaults to "running"', () => {
    const t = makeTracker();
    t.onStart({ subagent_id: 'S1', agent_name: 'helper' });
    t.onUpdate({ subagent_id: 'S1', agent_name: 'helper', status: 'something_weird' });
    expect(t.get('S1').status).toBe('running');
  });

  it('onUpdate creates entry on the fly if start was missed', () => {
    const t = makeTracker();
    t.onUpdate({ subagent_id: 'S1', agent_name: 'late', status: 'in_progress' });
    const entry = t.get('S1');
    expect(entry).toBeDefined();
    expect(entry.status).toBe('running');
  });

  it('onDone with positive duration_secs → status="done"', () => {
    const t = makeTracker();
    t.onStart({ subagent_id: 'S1', agent_name: 'helper' });
    now = 1_005_000;
    t.onDone({ subagent_id: 'S1', agent_name: 'helper', result_preview: 'all good', duration_secs: 5 });

    const entry = t.get('S1');
    expect(entry.status).toBe('done');
    expect(entry.result_preview).toBe('all good');
    expect(entry.duration_secs).toBe(5);
    expect(entry.doneAt).toBe(1_005_000);
  });

  it('onDone with negative duration_secs → status="failed"', () => {
    const t = makeTracker();
    t.onStart({ subagent_id: 'S1', agent_name: 'helper' });
    t.onDone({ subagent_id: 'S1', agent_name: 'helper', result_preview: 'ok', duration_secs: -1 });
    expect(t.get('S1').status).toBe('failed');
  });

  it('onDone with result_preview starting with "Error" → status="failed"', () => {
    const t = makeTracker();
    t.onStart({ subagent_id: 'S1', agent_name: 'helper' });
    t.onDone({ subagent_id: 'S1', agent_name: 'helper', result_preview: 'Error: something broke', duration_secs: 3 });
    expect(t.get('S1').status).toBe('failed');
  });

  it('onDone with result_preview starting with "error" (lowercase) → status="failed"', () => {
    const t = makeTracker();
    t.onStart({ subagent_id: 'S1', agent_name: 'helper' });
    t.onDone({ subagent_id: 'S1', agent_name: 'helper', result_preview: 'error: oops', duration_secs: 2 });
    expect(t.get('S1').status).toBe('failed');
  });

  it('pendingCount ignores "done" and "failed" entries', () => {
    const t = makeTracker();
    t.onStart({ subagent_id: 'S1', agent_name: 'a' });
    t.onStart({ subagent_id: 'S2', agent_name: 'b' });
    t.onStart({ subagent_id: 'S3', agent_name: 'c' });

    t.onDone({ subagent_id: 'S2', agent_name: 'b', duration_secs: 1 });
    t.onDone({ subagent_id: 'S3', agent_name: 'c', result_preview: 'Error: x', duration_secs: 2 });

    // S1 still running; S2 done; S3 failed
    expect(t.pendingCount()).toBe(1);
  });

  it('pendingCount counts "pending" status', () => {
    const t = makeTracker();
    t.onStart({ subagent_id: 'S1', agent_name: 'a' });
    t.onUpdate({ subagent_id: 'S1', agent_name: 'a', status: 'pending' });
    expect(t.pendingCount()).toBe(1);
  });

  it('list returns all entries in insertion order', () => {
    const t = makeTracker();
    t.onStart({ subagent_id: 'S1', agent_name: 'first' });
    t.onStart({ subagent_id: 'S2', agent_name: 'second' });
    t.onStart({ subagent_id: 'S3', agent_name: 'third' });

    const ids = t.list().map((e) => e.id);
    expect(ids).toEqual(['S1', 'S2', 'S3']);
  });

  it('get returns undefined for unknown id', () => {
    const t = makeTracker();
    expect(t.get('nope')).toBeUndefined();
  });
});
