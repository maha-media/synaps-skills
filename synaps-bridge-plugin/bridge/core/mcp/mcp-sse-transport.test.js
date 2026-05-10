/**
 * @file bridge/core/mcp/mcp-sse-transport.test.js
 *
 * Unit tests for McpSseTransport — SSE framing helper.
 * Pool: vmThreads (set globally in vitest.config.js).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpSseTransport } from './mcp-sse-transport.js';

// ─── Fake res factory ────────────────────────────────────────────────────────

/**
 * Creates a minimal Node http.ServerResponse-shaped mock.
 * Captures all writes, tracks ended state, and stores event listeners.
 */
function fakeRes() {
  const writes   = [];
  let   ended    = false;
  const handlers = {};

  return {
    writeHead: vi.fn((status, headers) => writes.push({ status, headers })),
    write:     vi.fn((chunk) => { writes.push(chunk); return true; }),
    end:       vi.fn(() => { ended = true; }),
    on:        vi.fn((evt, fn) => { handlers[evt] = fn; }),
    headersSent: false,
    get _writes()   { return writes;   },
    get _ended()    { return ended;    },
    get _handlers() { return handlers; },
  };
}

// ─── Expected SSE header shape ───────────────────────────────────────────────

const EXPECTED_HEADERS = {
  'Content-Type':      'text/event-stream',
  'Cache-Control':     'no-cache, no-transform',
  'Connection':        'keep-alive',
  'X-Accel-Buffering': 'no',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('McpSseTransport', () => {

  // 1 ── start() writes SSE headers ──────────────────────────────────────────
  it('start() writes the SSE headers with status 200', () => {
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();

    expect(res.writeHead).toHaveBeenCalledOnce();
    expect(res.writeHead).toHaveBeenCalledWith(200, EXPECTED_HEADERS);
    t.close();
  });

  // 2 ── start() writes retry hint ───────────────────────────────────────────
  it('start() writes the initial retry hint after the status line', () => {
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();

    // Second write element (index 1) is the retry hint
    expect(res.write).toHaveBeenCalledWith('retry: 1500\n\n');
    t.close();
  });

  // 3 ── start() is idempotent ────────────────────────────────────────────────
  it('start() is idempotent — second call is a no-op', () => {
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();
    t.start(); // second call

    expect(res.writeHead).toHaveBeenCalledOnce();
    // Only one retry-hint write
    const retryWrites = res._writes.filter(w => w === 'retry: 1500\n\n');
    expect(retryWrites).toHaveLength(1);
    t.close();
  });

  // 4 ── notify() produces data frame ────────────────────────────────────────
  it('notify() produces a `data: <json>\\n\\n` SSE frame', () => {
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();
    t.notify('synaps/chunk', { text: 'hello' });

    const dataWrites = res._writes.filter(w => typeof w === 'string' && w.startsWith('data:'));
    expect(dataWrites).toHaveLength(1);

    const parsed = JSON.parse(dataWrites[0].replace(/^data: /, '').trim());
    expect(parsed).toMatchObject({
      jsonrpc: '2.0',
      method:  'synaps/chunk',
      params:  { text: 'hello' },
    });
    expect(parsed).not.toHaveProperty('id');
    t.close();
  });

  // 5 ── notify() auto-starts ────────────────────────────────────────────────
  it('notify() auto-starts the transport if start() was not called', () => {
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });

    t.notify('synaps/chunk', { text: 'auto' });

    expect(res.writeHead).toHaveBeenCalledOnce();
    expect(res.write).toHaveBeenCalledWith('retry: 1500\n\n');
    t.close();
  });

  // 6 ── result() writes final frame and calls end() ─────────────────────────
  it('result() writes the result frame then calls res.end()', () => {
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();
    t.result('req-1', { output: 'done' });

    expect(res.end).toHaveBeenCalledOnce();
    const dataWrites = res._writes.filter(w => typeof w === 'string' && w.startsWith('data:'));
    expect(dataWrites).toHaveLength(1);

    const parsed = JSON.parse(dataWrites[0].replace(/^data: /, ''));
    expect(parsed).toMatchObject({
      jsonrpc: '2.0',
      id:      'req-1',
      result:  { output: 'done' },
    });
  });

  // 7 ── error() writes JSON-RPC error frame and calls end() ─────────────────
  it('error() writes a JSON-RPC error frame then calls res.end()', () => {
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();
    t.error('req-2', { code: -32603, message: 'Internal error' });

    expect(res.end).toHaveBeenCalledOnce();
    const dataWrites = res._writes.filter(w => typeof w === 'string' && w.startsWith('data:'));
    expect(dataWrites).toHaveLength(1);

    const parsed = JSON.parse(dataWrites[0].replace(/^data: /, ''));
    expect(parsed).toMatchObject({
      jsonrpc: '2.0',
      id:      'req-2',
      error:   { code: -32603, message: 'Internal error' },
    });
  });

  // 8 ── After result(), notify() calls are no-ops ────────────────────────────
  it('notify() after result() is a no-op (stream is closed)', () => {
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();
    t.result('req-3', { ok: true });

    const writeCountAfterResult = res.write.mock.calls.length;
    t.notify('synaps/chunk', { text: 'too late' });

    expect(res.write.mock.calls.length).toBe(writeCountAfterResult);
  });

  // 9 ── Keepalive fires at heartbeatMs ──────────────────────────────────────
  it('keepalive comment fires at heartbeatMs interval', () => {
    vi.useFakeTimers();
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 500 });
    t.start();

    vi.advanceTimersByTime(500);
    const keepaliveWrites = res._writes.filter(w => w === ': keepalive\n\n');
    expect(keepaliveWrites.length).toBeGreaterThanOrEqual(1);

    vi.advanceTimersByTime(500);
    const after2 = res._writes.filter(w => w === ': keepalive\n\n');
    expect(after2.length).toBeGreaterThanOrEqual(2);

    t.close();
    vi.useRealTimers();
  });

  // 10 ── Keepalive stops after close() ──────────────────────────────────────
  it('keepalive stops after close()', () => {
    vi.useFakeTimers();
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 500 });
    t.start();

    vi.advanceTimersByTime(500);
    const countBefore = res._writes.filter(w => w === ': keepalive\n\n').length;

    t.close();
    vi.advanceTimersByTime(1500); // would fire 3 more times if not stopped

    const countAfter = res._writes.filter(w => w === ': keepalive\n\n').length;
    expect(countAfter).toBe(countBefore); // no new keepalives

    vi.useRealTimers();
  });

  // 11 ── Peer-disconnect triggers internal close ────────────────────────────
  it('peer-disconnect (res "close" event) triggers internal close', () => {
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();

    expect(t.closed).toBe(false);

    // Simulate the peer hanging up
    res._handlers['close']?.();

    expect(t.closed).toBe(true);
  });

  // 12 ── closed getter reflects state ───────────────────────────────────────
  it('closed getter is false initially and true after close()', () => {
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });

    expect(t.closed).toBe(false);
    t.start();
    expect(t.closed).toBe(false);
    t.close();
    expect(t.closed).toBe(true);
  });

  // 13 ── Unicode-safe JSON serialisation ────────────────────────────────────
  it('params with Unicode characters (emoji, CJK, surrogates) serialise correctly', () => {
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();

    const unicodeText = '你好 🌍 \u00e9\u00e0';
    t.notify('synaps/chunk', { text: unicodeText });

    const dataWrites = res._writes.filter(w => typeof w === 'string' && w.startsWith('data:'));
    expect(dataWrites).toHaveLength(1);

    const raw = dataWrites[0].replace(/^data: /, '');
    const parsed = JSON.parse(raw);
    // JSON.parse round-trip must preserve the original string exactly
    expect(parsed.params.text).toBe(unicodeText);
    // The SSE data line itself must be valid UTF-8 (no raw surrogates)
    expect(() => JSON.parse(raw)).not.toThrow();

    t.close();
  });

  // 14 ── Multiple concurrent notify() calls preserve order ─────────────────
  it('multiple notify() calls preserve insertion order', () => {
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();

    const messages = ['first', 'second', 'third', 'fourth', 'fifth'];
    for (const text of messages) {
      t.notify('synaps/chunk', { text });
    }

    const dataWrites = res._writes
      .filter(w => typeof w === 'string' && w.startsWith('data:'))
      .map(w => JSON.parse(w.replace(/^data: /, '')).params.text);

    expect(dataWrites).toEqual(messages);
    t.close();
  });

  // 15 ── close() is idempotent ───────────────────────────────────────────────
  it('close() is idempotent — multiple calls do not throw or double-end', () => {
    const res = fakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();

    expect(() => {
      t.close();
      t.close();
      t.close();
    }).not.toThrow();

    expect(t.closed).toBe(true);
    // res.end was NOT called — we never sent a result/error, just force-closed
    expect(res.end).not.toHaveBeenCalled();
  });

  // 16 ── constructor throws without res ─────────────────────────────────────
  it('constructor throws TypeError when res is not provided', () => {
    expect(() => new McpSseTransport({})).toThrow(TypeError);
    expect(() => new McpSseTransport()).toThrow(TypeError);
  });

  // 17 ── res.on('close') listener is registered during construction ─────────
  it('registers a "close" listener on res during construction', () => {
    const res = fakeRes();
    new McpSseTransport({ res, heartbeatMs: 60_000 });

    expect(res.on).toHaveBeenCalledWith('close', expect.any(Function));
  });

});
