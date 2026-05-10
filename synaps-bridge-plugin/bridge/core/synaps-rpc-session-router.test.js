/**
 * @file bridge/core/synaps-rpc-session-router.test.js
 *
 * Tests for SynapsRpcSessionRouter — all rpc subprocess interaction is mocked
 * via a fake rpcFactory / handle pair; no real binaries are spawned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SynapsRpcSessionRouter } from './synaps-rpc-session-router.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a fake rpc handle whose send() resolves immediately with `response`.
 * @param {object|null} response
 */
function makeHandle(response) {
  return { send: vi.fn().mockResolvedValue(response) };
}

/**
 * Build a fake rpc handle whose send() rejects with `error`.
 * @param {Error} error
 */
function makeErrHandle(error) {
  return { send: vi.fn().mockRejectedValue(error) };
}

/**
 * Build a SynapsRpcSessionRouter with a factory that always returns `handle`.
 * Overrides are merged into the constructor opts.
 */
function makeRouter(handle, overrides = {}) {
  const rpcFactory = vi.fn().mockResolvedValue(handle);
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const now = vi.fn().mockReturnValue(1_000_000); // fixed "now"

  const router = new SynapsRpcSessionRouter({
    rpcFactory,
    probeTimeoutMs: overrides.probeTimeoutMs ?? 5_000,
    callTimeoutMs: overrides.callTimeoutMs ?? 60_000,
    cacheTtlMs: overrides.cacheTtlMs ?? 30_000,
    logger,
    now,
    ...overrides,
  });

  return { router, rpcFactory, logger, now };
}

// ─── Constructor ──────────────────────────────────────────────────────────────

describe('SynapsRpcSessionRouter constructor', () => {
  it('throws TypeError when rpcFactory is missing', () => {
    expect(() => new SynapsRpcSessionRouter({})).toThrow(TypeError);
    expect(() => new SynapsRpcSessionRouter({})).toThrow('rpcFactory must be a function');
  });

  it('constructs successfully with a valid rpcFactory', () => {
    const { router } = makeRouter(makeHandle(null));
    expect(router).toBeInstanceOf(SynapsRpcSessionRouter);
  });
});

// ─── listTools — failure paths ─────────────────────────────────────────────────

describe('SynapsRpcSessionRouter.listTools — failure paths return []', () => {
  it('returns [] when synapsUserId is empty string', async () => {
    const { router } = makeRouter(makeHandle(null));
    const result = await router.listTools('');
    expect(result).toEqual([]);
  });

  it('returns [] when synapsUserId is null', async () => {
    const { router } = makeRouter(makeHandle(null));
    const result = await router.listTools(null);
    expect(result).toEqual([]);
  });

  it('returns [] when rpcFactory throws', async () => {
    const rpcFactory = vi.fn().mockRejectedValue(new Error('docker not available'));
    const router = new SynapsRpcSessionRouter({
      rpcFactory,
      logger: { warn: vi.fn(), error: vi.fn() },
      now: Date.now,
    });
    const result = await router.listTools('user-1');
    expect(result).toEqual([]);
  });

  it('returns [] when probe times out (handle.send never resolves)', async () => {
    const handle = { send: vi.fn().mockReturnValue(new Promise(() => {})) }; // never resolves
    const { router } = makeRouter(handle, { probeTimeoutMs: 20 });
    const result = await router.listTools('user-1');
    expect(result).toEqual([]);
  });

  it('returns [] when handle.send rejects (network error)', async () => {
    const handle = makeErrHandle(new Error('connection refused'));
    const { router } = makeRouter(handle);
    const result = await router.listTools('user-1');
    expect(result).toEqual([]);
  });

  it('returns [] when response.ok is false (unknown_op)', async () => {
    const handle = makeHandle({ ok: false, error: 'unknown_op' });
    const { router } = makeRouter(handle);
    const result = await router.listTools('user-1');
    expect(result).toEqual([]);
  });

  it('returns [] when response.tools is not an array', async () => {
    const handle = makeHandle({ ok: true, tools: null });
    const { router } = makeRouter(handle);
    const result = await router.listTools('user-1');
    expect(result).toEqual([]);
  });

  it('returns [] when response is null (malformed parse)', async () => {
    const handle = makeHandle(null);
    const { router } = makeRouter(handle);
    const result = await router.listTools('user-1');
    expect(result).toEqual([]);
  });
});

// ─── listTools — success path ─────────────────────────────────────────────────

describe('SynapsRpcSessionRouter.listTools — success path', () => {
  const FAKE_TOOLS = [
    { name: 'web_fetch',  description: 'Fetch a URL',  inputSchema: { type: 'object', properties: {} } },
    { name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: {} } },
    { name: 'run_shell',  description: 'Run a shell command', inputSchema: { type: 'object', properties: {} } },
  ];

  it('returns the parsed tool list on success', async () => {
    const handle = makeHandle({ ok: true, tools: FAKE_TOOLS });
    const { router } = makeRouter(handle);
    const result = await router.listTools('user-1');
    expect(result).toEqual(FAKE_TOOLS);
  });

  it('sends {"op":"tools_list"} to handle.send', async () => {
    const handle = makeHandle({ ok: true, tools: FAKE_TOOLS });
    const { router } = makeRouter(handle);
    await router.listTools('user-1');
    expect(handle.send).toHaveBeenCalledWith({ op: 'tools_list' });
  });

  it('calls rpcFactory with synapsUserId', async () => {
    const handle = makeHandle({ ok: true, tools: FAKE_TOOLS });
    const { router, rpcFactory } = makeRouter(handle);
    await router.listTools('user-99');
    expect(rpcFactory).toHaveBeenCalledWith('user-99');
  });
});

// ─── listTools — caching ──────────────────────────────────────────────────────

describe('SynapsRpcSessionRouter.listTools — 30-second cache', () => {
  const FAKE_TOOLS = [
    { name: 'tool_a', description: 'A', inputSchema: {} },
  ];

  it('second call within cache window does not re-invoke rpcFactory', async () => {
    const handle = makeHandle({ ok: true, tools: FAKE_TOOLS });
    const { router, rpcFactory } = makeRouter(handle, { cacheTtlMs: 30_000 });

    await router.listTools('user-cache');
    await router.listTools('user-cache');

    expect(rpcFactory).toHaveBeenCalledTimes(1);
  });

  it('second call within cache window does not re-send probe', async () => {
    const handle = makeHandle({ ok: true, tools: FAKE_TOOLS });
    const { router } = makeRouter(handle, { cacheTtlMs: 30_000 });

    await router.listTools('user-cache');
    await router.listTools('user-cache');

    expect(handle.send).toHaveBeenCalledTimes(1);
  });

  it('second call within cache window returns same tools', async () => {
    const handle = makeHandle({ ok: true, tools: FAKE_TOOLS });
    const { router } = makeRouter(handle, { cacheTtlMs: 30_000 });

    const first  = await router.listTools('user-cache');
    const second = await router.listTools('user-cache');

    expect(second).toEqual(first);
  });

  it('cache is per-user — different users get separate probes', async () => {
    const handle = makeHandle({ ok: true, tools: FAKE_TOOLS });
    const { router, rpcFactory } = makeRouter(handle, { cacheTtlMs: 30_000 });

    await router.listTools('user-A');
    await router.listTools('user-B');

    expect(rpcFactory).toHaveBeenCalledTimes(2);
    expect(rpcFactory).toHaveBeenCalledWith('user-A');
    expect(rpcFactory).toHaveBeenCalledWith('user-B');
  });

  it('re-probes after cache expires', async () => {
    const handle = makeHandle({ ok: true, tools: FAKE_TOOLS });
    // Use a mutable now clock
    let fakeNow = 1_000_000;
    const now = vi.fn(() => fakeNow);

    const router = new SynapsRpcSessionRouter({
      rpcFactory: vi.fn().mockResolvedValue(handle),
      cacheTtlMs: 1_000, // 1 second
      probeTimeoutMs: 5_000,
      logger: { warn: vi.fn(), error: vi.fn() },
      now,
    });

    await router.listTools('user-exp');
    // Advance clock past TTL
    fakeNow += 2_000;
    await router.listTools('user-exp');

    expect(handle.send).toHaveBeenCalledTimes(2);
  });

  it('invalidateCache removes user entry so next call re-probes', async () => {
    const handle = makeHandle({ ok: true, tools: FAKE_TOOLS });
    const { router } = makeRouter(handle, { cacheTtlMs: 30_000 });

    await router.listTools('user-inv');
    router.invalidateCache('user-inv');
    await router.listTools('user-inv');

    expect(handle.send).toHaveBeenCalledTimes(2);
  });
});

// ─── callTool — success and error ─────────────────────────────────────────────

describe('SynapsRpcSessionRouter.callTool — success path', () => {
  it('sends {op:"tool_call", name, args} to handle.send', async () => {
    const handle = makeHandle({ ok: true, result: 'hello world' });
    const { router } = makeRouter(handle);

    await router.callTool({ synapsUserId: 'u1', name: 'web_fetch', args: { url: 'https://example.com' } });

    expect(handle.send).toHaveBeenCalledWith({
      op: 'tool_call',
      name: 'web_fetch',
      args: { url: 'https://example.com' },
    });
  });

  it('returns {content:[{type:"text",text}], isError:false} on success with string result', async () => {
    const handle = makeHandle({ ok: true, result: 'fetched content' });
    const { router } = makeRouter(handle);

    const result = await router.callTool({ synapsUserId: 'u1', name: 'web_fetch', args: {} });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'fetched content' }],
      isError: false,
    });
  });

  it('returns {content:[{type:"text",text}], isError:false} on success with result.text', async () => {
    const handle = makeHandle({ ok: true, result: { text: 'the answer' } });
    const { router } = makeRouter(handle);

    const result = await router.callTool({ synapsUserId: 'u1', name: 'web_fetch', args: {} });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'the answer' }],
      isError: false,
    });
  });

  it('JSON-stringifies non-string, non-text result objects', async () => {
    const obj = { data: [1, 2, 3] };
    const handle = makeHandle({ ok: true, result: obj });
    const { router } = makeRouter(handle);

    const result = await router.callTool({ synapsUserId: 'u1', name: 'query', args: {} });

    expect(result.content[0].text).toBe(JSON.stringify(obj));
    expect(result.isError).toBe(false);
  });

  it('defaults args to {} when not provided', async () => {
    const handle = makeHandle({ ok: true, result: 'ok' });
    const { router } = makeRouter(handle);

    await router.callTool({ synapsUserId: 'u1', name: 'my_tool' });

    expect(handle.send).toHaveBeenCalledWith({ op: 'tool_call', name: 'my_tool', args: {} });
  });
});

describe('SynapsRpcSessionRouter.callTool — error paths', () => {
  it('returns isError:true when response.ok is false', async () => {
    const handle = makeHandle({ ok: false, error: 'tool execution failed' });
    const { router } = makeRouter(handle);

    const result = await router.callTool({ synapsUserId: 'u1', name: 'bad_tool', args: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('tool execution failed');
  });

  it('returns isError:true when handle.send rejects', async () => {
    const handle = makeErrHandle(new Error('rpc crashed'));
    const { router } = makeRouter(handle);

    const result = await router.callTool({ synapsUserId: 'u1', name: 'tool', args: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/rpc crashed/);
  });

  it('returns isError:true when callTool times out', async () => {
    const handle = { send: vi.fn().mockReturnValue(new Promise(() => {})) };
    const { router } = makeRouter(handle, { callTimeoutMs: 20 });

    const result = await router.callTool({ synapsUserId: 'u1', name: 'slow_tool', args: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timed out/i);
  });

  it('returns isError:true when rpcFactory rejects', async () => {
    const rpcFactory = vi.fn().mockRejectedValue(new Error('workspace down'));
    const router = new SynapsRpcSessionRouter({
      rpcFactory,
      logger: { warn: vi.fn(), error: vi.fn() },
      now: Date.now,
    });

    const result = await router.callTool({ synapsUserId: 'u1', name: 'tool', args: {} });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/workspace down/);
  });

  it('throws when synapsUserId is missing', async () => {
    const { router } = makeRouter(makeHandle(null));
    await expect(router.callTool({ name: 'tool', args: {} })).rejects.toThrow('synapsUserId required');
  });

  it('throws when name is missing', async () => {
    const { router } = makeRouter(makeHandle(null));
    await expect(router.callTool({ synapsUserId: 'u1', args: {} })).rejects.toThrow('name required');
  });
});
