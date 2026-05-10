/**
 * @file tool-progress.test.js
 */

import { describe, it, expect } from 'vitest';
import { ToolProgress } from './tool-progress.js';

// ── helpers ───────────────────────────────────────────────────────────────────

let now = 2_000_000;
const nowMs = () => now;

function makeTp() {
  now = 2_000_000;
  return new ToolProgress({ nowMs });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ToolProgress', () => {
  it('onStart creates entry with status="running"', () => {
    const tp = makeTp();
    tp.onStart({ tool_id: 'T1', tool_name: 'read_file' });

    const entry = tp.get('T1');
    expect(entry).toBeDefined();
    expect(entry.toolId).toBe('T1');
    expect(entry.toolName).toBe('read_file');
    expect(entry.status).toBe('running');
    expect(entry.inputBuffer).toBe('');
    expect(entry.input).toBeNull();
    expect(entry.startedAt).toBe(2_000_000);
    expect(entry.result).toBeUndefined();
  });

  it('onInputDelta accumulates fragments in inputBuffer', () => {
    const tp = makeTp();
    tp.onStart({ tool_id: 'T1', tool_name: 'search' });

    tp.onInputDelta({ tool_id: 'T1', delta: '{"q' });
    tp.onInputDelta({ tool_id: 'T1', delta: 'uery"' });
    tp.onInputDelta({ tool_id: 'T1', delta: ':"foo"}' });

    expect(tp.get('T1').inputBuffer).toBe('{"query":"foo"}');
  });

  it('onInputDelta is a no-op for unknown tool_id', () => {
    const tp = makeTp();
    // Should not throw
    expect(() => tp.onInputDelta({ tool_id: 'unknown', delta: 'x' })).not.toThrow();
  });

  it('onInput sets the input field (ignores buffer content)', () => {
    const tp = makeTp();
    tp.onStart({ tool_id: 'T1', tool_name: 'search' });
    tp.onInputDelta({ tool_id: 'T1', delta: '{"query":"foo"}' });
    tp.onInput({ tool_id: 'T1', input: { query: 'foo' } });

    const entry = tp.get('T1');
    expect(entry.input).toEqual({ query: 'foo' });
    // Buffer is preserved (not cleared) — onInput doesn't touch it
    expect(entry.inputBuffer).toBe('{"query":"foo"}');
  });

  it('onInput with null input still sets input field', () => {
    const tp = makeTp();
    tp.onStart({ tool_id: 'T1', tool_name: 'noop' });
    tp.onInput({ tool_id: 'T1', input: null });
    expect(tp.get('T1').input).toBeNull();
  });

  it('onResult sets result + status="done" + doneAt', () => {
    const tp = makeTp();
    tp.onStart({ tool_id: 'T1', tool_name: 'read_file' });
    now = 2_001_000;
    tp.onResult({ tool_id: 'T1', result: 'file contents here' });

    const entry = tp.get('T1');
    expect(entry.result).toBe('file contents here');
    expect(entry.status).toBe('done');
    expect(entry.doneAt).toBe(2_001_000);
  });

  it('onError sets error + status="done" + doneAt', () => {
    const tp = makeTp();
    tp.onStart({ tool_id: 'T1', tool_name: 'run_cmd' });
    now = 2_002_000;
    tp.onError({ tool_id: 'T1', error: new Error('command failed') });

    const entry = tp.get('T1');
    expect(entry.error).toBeInstanceOf(Error);
    expect(entry.status).toBe('done');
    expect(entry.doneAt).toBe(2_002_000);
  });

  it('onResult is a no-op for unknown tool_id', () => {
    const tp = makeTp();
    expect(() => tp.onResult({ tool_id: 'ghost', result: 'x' })).not.toThrow();
  });

  it('reset removes an entry', () => {
    const tp = makeTp();
    tp.onStart({ tool_id: 'T1', tool_name: 'x' });
    tp.reset('T1');
    expect(tp.get('T1')).toBeUndefined();
  });

  it('reset is a no-op for unknown tool_id', () => {
    const tp = makeTp();
    expect(() => tp.reset('ghost')).not.toThrow();
  });

  it('list returns entries in insertion order', () => {
    const tp = makeTp();
    tp.onStart({ tool_id: 'T1', tool_name: 'a' });
    tp.onStart({ tool_id: 'T2', tool_name: 'b' });
    tp.onStart({ tool_id: 'T3', tool_name: 'c' });

    const ids = tp.list().map((e) => e.toolId);
    expect(ids).toEqual(['T1', 'T2', 'T3']);
  });

  it('list returns empty array when no tools tracked', () => {
    const tp = makeTp();
    expect(tp.list()).toEqual([]);
  });
});
