/**
 * bridge/core/mcp/mcp-tool-registry.test.js
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  McpToolRegistry,
  McpToolNotFoundError,
  McpToolInvalidArgsError,
  McpToolTimeoutError,
} from './mcp-tool-registry.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a fresh mock sessionRouter + rpc for each test. */
function makeRouter(promptImpl) {
  // Minimal EventEmitter-shaped rpc so the McpToolRegistry's listener-based
  // collection logic (text_delta → agent_end) can be exercised in tests.
  const listeners = new Map();
  const rpc = {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
    },
    off(ev, fn) { listeners.get(ev)?.delete(fn); },
    emit(ev, payload) {
      for (const fn of (listeners.get(ev) ?? [])) fn(payload);
    },
    prompt: vi.fn().mockImplementation(
      // Default: ack ok:true then emit a text_delta + agent_end on next tick.
      promptImpl ?? (function defaultPrompt() {
        queueMicrotask(() => {
          rpc.emit('message_update', { type: 'text_delta', delta: 'hi' });
          rpc.emit('agent_end', { usage: {} });
        });
        return Promise.resolve({ ok: true, command: 'prompt' });
      }),
    ),
  };
  const sessionRouter = {
    getOrCreateSession: vi.fn().mockResolvedValue(rpc),
  };
  return { sessionRouter, rpc };
}

function makeRegistry(overrides = {}) {
  const { sessionRouter, rpc } = makeRouter(overrides.promptImpl);
  const registry = new McpToolRegistry({
    sessionRouter,
    chatTimeoutMs: overrides.chatTimeoutMs ?? 120_000,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    now: Date.now,
  });
  return { registry, sessionRouter, rpc };
}

// ─── Constructor ──────────────────────────────────────────────────────────────

describe('McpToolRegistry constructor', () => {
  it('throws TypeError when sessionRouter is missing', () => {
    expect(() => new McpToolRegistry({})).toThrow(TypeError);
    expect(() => new McpToolRegistry({})).toThrow('sessionRouter');
  });

  it('throws TypeError when sessionRouter is null', () => {
    expect(() => new McpToolRegistry({ sessionRouter: null })).toThrow(TypeError);
  });

  it('constructs successfully with a valid sessionRouter', () => {
    const { registry } = makeRegistry();
    expect(registry).toBeInstanceOf(McpToolRegistry);
  });
});

// ─── listTools ────────────────────────────────────────────────────────────────

describe('McpToolRegistry.listTools', () => {
  it('returns all tool descriptors (length 1)', async () => {
    const { registry } = makeRegistry();
    const tools = await registry.listTools({ synaps_user_id: 'u1', institution_id: 'i1' });
    expect(tools).toHaveLength(1);
  });

  it('first tool name is synaps_chat', async () => {
    const { registry } = makeRegistry();
    const [tool] = await registry.listTools({});
    expect(tool.name).toBe('synaps_chat');
  });

  it('returns a copy — mutating result does not affect subsequent calls', async () => {
    const { registry } = makeRegistry();
    const first = await registry.listTools({});
    first.push({ name: 'injected' }); // mutate the returned array
    const second = await registry.listTools({});
    expect(second).toHaveLength(1);
  });
});

// ─── callTool — routing / validation ──────────────────────────────────────────

describe('McpToolRegistry.callTool — routing and validation', () => {
  it('throws McpToolNotFoundError (code -32601) for an unknown tool name', async () => {
    const { registry } = makeRegistry();
    await expect(
      registry.callTool({ name: 'ghost_tool', arguments: {}, synaps_user_id: 'u1' }),
    ).rejects.toThrow(McpToolNotFoundError);
  });

  it('McpToolNotFoundError has code -32601', async () => {
    const { registry } = makeRegistry();
    try {
      await registry.callTool({ name: 'ghost_tool', arguments: {}, synaps_user_id: 'u1' });
    } catch (err) {
      expect(err.code).toBe(-32601);
      expect(err.name).toBe('McpToolNotFoundError');
      expect(err.toolName).toBe('ghost_tool');
    }
  });

  it('throws McpToolInvalidArgsError (code -32602) when args are missing required fields', async () => {
    const { registry } = makeRegistry();
    await expect(
      registry.callTool({ name: 'synaps_chat', arguments: {}, synaps_user_id: 'u1' }),
    ).rejects.toThrow(McpToolInvalidArgsError);
  });

  it('McpToolInvalidArgsError has code -32602', async () => {
    const { registry } = makeRegistry();
    try {
      await registry.callTool({ name: 'synaps_chat', arguments: {}, synaps_user_id: 'u1' });
    } catch (err) {
      expect(err.code).toBe(-32602);
      expect(err.name).toBe('McpToolInvalidArgsError');
    }
  });

  it('throws InvalidArgs when prompt is missing', async () => {
    const { registry } = makeRegistry();
    await expect(
      registry.callTool({ name: 'synaps_chat', arguments: { context: 'ctx' }, synaps_user_id: 'u1' }),
    ).rejects.toThrow(McpToolInvalidArgsError);
  });

  it('treats null arguments as empty object (missing prompt → InvalidArgs)', async () => {
    const { registry } = makeRegistry();
    // null args → {} → missing prompt → InvalidArgs
    await expect(
      registry.callTool({ name: 'synaps_chat', arguments: null, synaps_user_id: 'u1' }),
    ).rejects.toThrow(McpToolInvalidArgsError);
  });
});

// ─── callTool — successful dispatch ──────────────────────────────────────────

describe('McpToolRegistry.callTool — successful dispatch', () => {
  it('calls sessionRouter.getOrCreateSession with {synaps_user_id}', async () => {
    const { registry, sessionRouter } = makeRegistry();
    await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'hello' },
      synaps_user_id: 'user-42',
    });
    expect(sessionRouter.getOrCreateSession).toHaveBeenCalledWith({ source: 'mcp', conversation: 'user-42', thread: 'default' });
  });

  it('returns {content:[{type:"text",text:"hi"}], isError:false} on success', async () => {
    const { registry } = makeRegistry();
    const result = await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'hello' },
      synaps_user_id: 'u1',
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'hi' }],
      isError: false,
    });
  });

  it('prepends context with "\\n\\n" separator when context provided', async () => {
    const { registry, rpc } = makeRegistry();
    await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'hello world', context: 'system context' },
      synaps_user_id: 'u1',
    });
    expect(rpc.prompt).toHaveBeenCalledWith('system context\n\nhello world');
  });

  it('sends only prompt when context is absent', async () => {
    const { registry, rpc } = makeRegistry();
    await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'bare prompt' },
      synaps_user_id: 'u1',
    });
    expect(rpc.prompt).toHaveBeenCalledWith('bare prompt');
  });

  it('assembles text from streamed text_delta events terminated by agent_end', async () => {
    const { registry, rpc } = makeRegistry({
      promptImpl: function () {
        queueMicrotask(() => {
          rpc.emit('message_update', { type: 'text_delta', delta: 'Hello ' });
          rpc.emit('message_update', { type: 'text_delta', delta: 'world' });
          rpc.emit('message_update', { type: 'text_delta', delta: '!' });
          rpc.emit('agent_end', { usage: {} });
        });
        return Promise.resolve({ ok: true });
      },
    });
    const result = await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'q' },
      synaps_user_id: 'u1',
    });
    expect(result.content[0].text).toBe('Hello world!');
    expect(result.isError).toBe(false);
  });

  it('ignores non-text_delta message_update events (thinking, toolcalls)', async () => {
    const { registry, rpc } = makeRegistry({
      promptImpl: function () {
        queueMicrotask(() => {
          rpc.emit('message_update', { type: 'thinking_delta', delta: 'hmm' });
          rpc.emit('message_update', { type: 'text_delta', delta: 'answer' });
          rpc.emit('message_update', { type: 'toolcall_start', tool_name: 'web_fetch' });
          rpc.emit('agent_end', { usage: {} });
        });
        return Promise.resolve({ ok: true });
      },
    });
    const result = await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'q' },
      synaps_user_id: 'u1',
    });
    expect(result.content[0].text).toBe('answer');
    expect(result.isError).toBe(false);
  });
});

// ─── callTool — error propagation ────────────────────────────────────────────

describe('McpToolRegistry.callTool — error propagation', () => {
  it('propagates rpc.prompt rejection (non-timeout errors are re-thrown)', async () => {
    const rpcError = new Error('rpc blew up');
    const { registry } = makeRegistry({ promptImpl: () => Promise.reject(rpcError) });
    await expect(
      registry.callTool({
        name: 'synaps_chat',
        arguments: { prompt: 'q' },
        synaps_user_id: 'u1',
      }),
    ).rejects.toThrow('rpc blew up');
  });

  it('returns isError:true result (not thrown) when chatTimeoutMs elapses', async () => {
    // Use a never-resolving promise with a very short timeout
    const { registry } = makeRegistry({
      chatTimeoutMs: 50,
      promptImpl: () => new Promise(() => {}), // never resolves
    });

    const result = await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'slow' },
      synaps_user_id: 'u1',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timed out after 50ms/);
  });
});

// ─── Error class shapes ───────────────────────────────────────────────────────

describe('Error class shapes', () => {
  it('McpToolNotFoundError has correct .name, .code, .toolName', () => {
    const err = new McpToolNotFoundError('my_tool');
    expect(err.name).toBe('McpToolNotFoundError');
    expect(err.code).toBe(-32601);
    expect(err.toolName).toBe('my_tool');
    expect(err).toBeInstanceOf(Error);
  });

  it('McpToolInvalidArgsError has correct .name, .code, .toolName', () => {
    const err = new McpToolInvalidArgsError('synaps_chat', 'missing prompt');
    expect(err.name).toBe('McpToolInvalidArgsError');
    expect(err.code).toBe(-32602);
    expect(err.toolName).toBe('synaps_chat');
    expect(err.message).toContain('missing prompt');
    expect(err).toBeInstanceOf(Error);
  });

  it('McpToolTimeoutError has correct .name, .code, .toolName', () => {
    const err = new McpToolTimeoutError('synaps_chat', 5000);
    expect(err.name).toBe('McpToolTimeoutError');
    expect(err.code).toBe(-32000);
    expect(err.toolName).toBe('synaps_chat');
    expect(err.message).toContain('5000ms');
    expect(err).toBeInstanceOf(Error);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 8 Track 2 — rpcRouter injection + per-tool surfacing
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FAKE_RPC_TOOLS = [
  { name: 'web_fetch',  description: 'Fetch a URL',     inputSchema: { type: 'object' } },
  { name: 'web_search', description: 'Search the web',  inputSchema: { type: 'object' } },
];

function makeRpcRouter(overrides = {}) {
  return {
    listTools: vi.fn().mockResolvedValue(overrides.tools ?? FAKE_RPC_TOOLS),
    callTool:  vi.fn().mockResolvedValue(
      overrides.callResult ?? { content: [{ type: 'text', text: 'rpc result' }], isError: false },
    ),
  };
}

/**
 * Build a McpToolRegistry with rpcRouter and surfaceRpcTools opt-in.
 */
function makeRegistryWithRpc({ surfaceRpcTools = true, rpcRouter, rpcTools, promptImpl } = {}) {
  // Same EventEmitter-shaped rpc as makeRouter so synaps_chat path tests
  // get an agent_end signal.
  const listeners = new Map();
  const rpc = {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
    },
    off(ev, fn) { listeners.get(ev)?.delete(fn); },
    emit(ev, payload) { for (const fn of (listeners.get(ev) ?? [])) fn(payload); },
    prompt: vi.fn().mockImplementation(
      promptImpl ?? (function defaultPrompt() {
        queueMicrotask(() => {
          rpc.emit('message_update', { type: 'text_delta', delta: 'hi' });
          rpc.emit('agent_end', { usage: {} });
        });
        return Promise.resolve({ ok: true });
      }),
    ),
  };
  const sessionRouter = { getOrCreateSession: vi.fn().mockResolvedValue(rpc) };
  const resolvedRpcRouter = rpcRouter ?? makeRpcRouter({ tools: rpcTools ?? FAKE_RPC_TOOLS });

  const registry = new McpToolRegistry({
    sessionRouter,
    rpcRouter: resolvedRpcRouter,
    surfaceRpcTools,
    chatTimeoutMs: 120_000,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    now: Date.now,
  });

  return { registry, sessionRouter, rpc, rpcRouter: resolvedRpcRouter };
}

// ─── McpToolRegistry constructor — rpcRouter ──────────────────────────────────

describe('McpToolRegistry constructor — Phase 8 rpcRouter slot', () => {
  it('accepts rpcRouter without throwing', () => {
    const { registry } = makeRegistryWithRpc({ surfaceRpcTools: false });
    expect(registry).toBeInstanceOf(McpToolRegistry);
  });

  it('accepts rpcRouter=null (surfaceRpcTools off is valid)', () => {
    const rpc = { prompt: vi.fn() };
    const sessionRouter = { getOrCreateSession: vi.fn().mockResolvedValue(rpc) };
    expect(() => new McpToolRegistry({ sessionRouter, rpcRouter: null })).not.toThrow();
  });
});

// ─── listTools — surfaceRpcTools disabled ─────────────────────────────────────

describe('McpToolRegistry.listTools — surfaceRpcTools=false', () => {
  it('returns only [synaps_chat] when surfaceRpcTools is false', async () => {
    const { registry } = makeRegistryWithRpc({ surfaceRpcTools: false });
    const tools = await registry.listTools({ synaps_user_id: 'u1' });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('synaps_chat');
  });

  it('does not call rpcRouter.listTools when surfaceRpcTools is false', async () => {
    const { registry, rpcRouter } = makeRegistryWithRpc({ surfaceRpcTools: false });
    await registry.listTools({ synaps_user_id: 'u1' });
    expect(rpcRouter.listTools).not.toHaveBeenCalled();
  });

  it('returns [synaps_chat] when surfaceRpcTools is true but no synaps_user_id', async () => {
    const { registry, rpcRouter } = makeRegistryWithRpc({ surfaceRpcTools: true });
    const tools = await registry.listTools({});
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('synaps_chat');
    expect(rpcRouter.listTools).not.toHaveBeenCalled();
  });
});

// ─── listTools — surfaceRpcTools enabled ──────────────────────────────────────

describe('McpToolRegistry.listTools — surfaceRpcTools=true', () => {
  it('returns [synaps_chat, ...rpcTools] when surfaceRpcTools is true', async () => {
    const { registry } = makeRegistryWithRpc({ surfaceRpcTools: true });
    const tools = await registry.listTools({ synaps_user_id: 'u1' });
    expect(tools).toHaveLength(1 + FAKE_RPC_TOOLS.length);
    expect(tools[0].name).toBe('synaps_chat');
    expect(tools.map((t) => t.name)).toContain('web_fetch');
    expect(tools.map((t) => t.name)).toContain('web_search');
  });

  it('calls rpcRouter.listTools with synapsUserId', async () => {
    const { registry, rpcRouter } = makeRegistryWithRpc({ surfaceRpcTools: true });
    await registry.listTools({ synaps_user_id: 'user-42' });
    expect(rpcRouter.listTools).toHaveBeenCalledWith('user-42');
  });

  it('returns only [synaps_chat] when rpcRouter.listTools returns []', async () => {
    const { registry } = makeRegistryWithRpc({ surfaceRpcTools: true, rpcTools: [] });
    const tools = await registry.listTools({ synaps_user_id: 'u1' });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('synaps_chat');
  });

  it('returns [synaps_chat] when rpcRouter.listTools throws (fault tolerant)', async () => {
    const badRouter = {
      listTools: vi.fn().mockRejectedValue(new Error('rpc offline')),
      callTool:  vi.fn(),
    };
    const { registry } = makeRegistryWithRpc({ surfaceRpcTools: true, rpcRouter: badRouter });
    const tools = await registry.listTools({ synaps_user_id: 'u1' });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('synaps_chat');
  });
});

// ─── callTool — synaps_chat still dispatches to sessionRouter ─────────────────

describe('McpToolRegistry.callTool — synaps_chat path unchanged', () => {
  it('routes synaps_chat to sessionRouter even when surfaceRpcTools=true', async () => {
    const { registry, sessionRouter } = makeRegistryWithRpc({ surfaceRpcTools: true });
    await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'hello' },
      synaps_user_id: 'u1',
    });
    expect(sessionRouter.getOrCreateSession).toHaveBeenCalledWith({ source: 'mcp', conversation: 'u1', thread: 'default' });
  });

  it('does NOT call rpcRouter.callTool for synaps_chat', async () => {
    const { registry, rpcRouter } = makeRegistryWithRpc({ surfaceRpcTools: true });
    await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'hello' },
      synaps_user_id: 'u1',
    });
    expect(rpcRouter.callTool).not.toHaveBeenCalled();
  });
});

// ─── callTool — unknown name dispatched to rpcRouter ──────────────────────────

describe('McpToolRegistry.callTool — rpc forwarding when surfaceRpcTools=true', () => {
  it('dispatches unknown tool name to rpcRouter.callTool when surfacing is on', async () => {
    const { registry, rpcRouter } = makeRegistryWithRpc({ surfaceRpcTools: true });
    const result = await registry.callTool({
      name: 'web_fetch',
      arguments: { url: 'https://example.com' },
      synaps_user_id: 'u1',
    });
    expect(rpcRouter.callTool).toHaveBeenCalledWith({
      synapsUserId: 'u1',
      name: 'web_fetch',
      args: { url: 'https://example.com' },
    });
    expect(result).toEqual({ content: [{ type: 'text', text: 'rpc result' }], isError: false });
  });

  it('forwards the return value from rpcRouter.callTool verbatim', async () => {
    const customResult = { content: [{ type: 'text', text: 'custom output' }], isError: false };
    const rpcRouter = makeRpcRouter({ callResult: customResult });
    const { registry } = makeRegistryWithRpc({ surfaceRpcTools: true, rpcRouter });

    const result = await registry.callTool({
      name: 'run_shell',
      arguments: { cmd: 'ls' },
      synaps_user_id: 'u2',
    });
    expect(result).toEqual(customResult);
  });

  it('passes null args as empty object to rpcRouter.callTool', async () => {
    const { registry, rpcRouter } = makeRegistryWithRpc({ surfaceRpcTools: true });
    await registry.callTool({
      name: 'web_fetch',
      arguments: null,
      synaps_user_id: 'u1',
    });
    expect(rpcRouter.callTool).toHaveBeenCalledWith({
      synapsUserId: 'u1',
      name: 'web_fetch',
      args: {},
    });
  });
});

// ─── callTool — Method not found when surfacing is off ────────────────────────

describe('McpToolRegistry.callTool — Method not found when surfaceRpcTools=false', () => {
  it('throws McpToolNotFoundError for unknown name when surfaceRpcTools=false', async () => {
    const { registry } = makeRegistryWithRpc({ surfaceRpcTools: false });
    await expect(
      registry.callTool({ name: 'web_fetch', arguments: {}, synaps_user_id: 'u1' }),
    ).rejects.toThrow(McpToolNotFoundError);
  });

  it('McpToolNotFoundError has code -32601', async () => {
    const { registry } = makeRegistryWithRpc({ surfaceRpcTools: false });
    try {
      await registry.callTool({ name: 'web_fetch', arguments: {}, synaps_user_id: 'u1' });
    } catch (err) {
      expect(err.code).toBe(-32601);
      expect(err.toolName).toBe('web_fetch');
    }
  });

  it('does NOT call rpcRouter.callTool when surfaceRpcTools=false', async () => {
    const { registry, rpcRouter } = makeRegistryWithRpc({ surfaceRpcTools: false });
    try {
      await registry.callTool({ name: 'web_fetch', arguments: {}, synaps_user_id: 'u1' });
    } catch {
      // expected
    }
    expect(rpcRouter.callTool).not.toHaveBeenCalled();
  });

  it('throws McpToolNotFoundError for unknown name when rpcRouter is null', async () => {
    const rpc = { prompt: vi.fn() };
    const sessionRouter = { getOrCreateSession: vi.fn().mockResolvedValue(rpc) };
    const registry = new McpToolRegistry({
      sessionRouter,
      rpcRouter: null,
      surfaceRpcTools: false,
      logger: { warn: vi.fn(), error: vi.fn() },
      now: Date.now,
    });
    await expect(
      registry.callTool({ name: 'anything', arguments: {}, synaps_user_id: 'u1' }),
    ).rejects.toThrow(McpToolNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 9 Track 1 — _runSerialized helper
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Minimal registry just for _runSerialized tests — we only need the private
 * helper; sessionRouter must satisfy the constructor guard.
 */
function makeSerialRegistry() {
  const rpc = { prompt: vi.fn(), on: vi.fn(), off: vi.fn() };
  const sessionRouter = { getOrCreateSession: vi.fn().mockResolvedValue(rpc) };
  const registry = new McpToolRegistry({
    sessionRouter,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  });
  return registry;
}

describe('McpToolRegistry._runSerialized — Track 1 helper', () => {

  // ── T1-1: Serial order ──────────────────────────────────────────────────────
  it('resolves 5 concurrent calls on the same key in submission order', async () => {
    const registry = makeSerialRegistry();
    const order = [];
    const KEY = 'mcp|u1|default';

    // Each fn records its index and resolves after a tiny await so they truly
    // interleave if not serialised.
    const promises = Array.from({ length: 5 }, (_, i) =>
      registry._runSerialized(KEY, async () => {
        // Yield to allow later-submitted chains to attempt to start.
        await new Promise((r) => setImmediate(r));
        order.push(i);
        return i;
      }),
    );

    const results = await Promise.all(promises);

    // Results must match submission order 0–4.
    expect(results).toEqual([0, 1, 2, 3, 4]);
    // The internal order array must also be monotonically increasing.
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  // ── T1-2: Rejection isolation ───────────────────────────────────────────────
  it('a mid-chain rejection does not block or corrupt later callers', async () => {
    const registry = makeSerialRegistry();
    const KEY = 'mcp|u2|default';

    const p1 = registry._runSerialized(KEY, async () => 'first');
    const p2 = registry._runSerialized(KEY, async () => { throw new Error('boom'); });
    const p3 = registry._runSerialized(KEY, async () => 'third');

    const [r1, r3] = await Promise.all([
      p1,
      p2.catch(() => 'caught'),
      p3,
    ]).then(([a, , c]) => [a, c]);

    expect(r1).toBe('first');
    expect(r3).toBe('third');
    // p3 must not have hung — if we get here the chain was not dead-locked.
  });

  // ── T1-3: Key isolation (different keys run in parallel) ────────────────────
  it('calls on different keys overlap (parallelism proven by timestamps)', async () => {
    const registry = makeSerialRegistry();

    // Each fn takes ~20 ms. If keys were also serialised, total would be ≥ 80 ms
    // (4 calls × 20 ms). With parallel keys, A and B overlap so total ≈ 40 ms.
    const DELAY = 20;
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    const timestamps = [];
    const record = (label) => () =>
      delay(DELAY).then(() => { timestamps.push({ label, t: Date.now() }); return label; });

    const start = Date.now();
    await Promise.all([
      registry._runSerialized('mcp|u-a|default', record('A1')),
      registry._runSerialized('mcp|u-a|default', record('A2')),
      registry._runSerialized('mcp|u-b|default', record('B1')),
      registry._runSerialized('mcp|u-b|default', record('B2')),
    ]);
    const elapsed = Date.now() - start;

    // If A and B ran completely sequentially the wall time would be ≥ 4×DELAY.
    // Parallelism means it should be < 3×DELAY (generous bound).
    expect(elapsed).toBeLessThan(DELAY * 3 + 30); // +30 ms scheduling slack

    // Within key A, A1 must finish before A2 starts → A2.t ≥ A1.t.
    const A1 = timestamps.find((e) => e.label === 'A1');
    const A2 = timestamps.find((e) => e.label === 'A2');
    expect(A2.t).toBeGreaterThanOrEqual(A1.t);
  });

  // ── T1-4: Map cleanup ───────────────────────────────────────────────────────
  it('_sessionLocks size is ≤ 1 after 10 sequential calls on one key', async () => {
    const registry = makeSerialRegistry();
    const KEY = 'mcp|u3|default';

    for (let i = 0; i < 10; i++) {
      // Run sequentially (await each call) to ensure clean settling.
      // eslint-disable-next-line no-await-in-loop
      await registry._runSerialized(KEY, async () => i);
    }

    // After all calls have fully settled, the Map should have cleaned up.
    expect(registry._sessionLocks.size).toBeLessThanOrEqual(1);
  });

  // ── T1-5: Empty / missing sessionKey throws TypeError ───────────────────────
  it('throws TypeError for an empty string sessionKey', async () => {
    const registry = makeSerialRegistry();
    await expect(
      registry._runSerialized('', async () => 'x'),
    ).rejects.toThrow(TypeError);
    await expect(
      registry._runSerialized('', async () => 'x'),
    ).rejects.toThrow('non-empty string');
  });

  // ── T1-6: Return value passthrough ─────────────────────────────────────────
  it('resolves to whatever fn returns (object, number, undefined)', async () => {
    const registry = makeSerialRegistry();
    const KEY = 'mcp|u4|default';

    const obj    = await registry._runSerialized(KEY, async () => ({ a: 1 }));
    const num    = await registry._runSerialized(KEY, async () => 42);
    const undef  = await registry._runSerialized(KEY, async () => undefined);
    const str    = await registry._runSerialized(KEY, async () => 'hello');

    expect(obj).toEqual({ a: 1 });
    expect(num).toBe(42);
    expect(undef).toBeUndefined();
    expect(str).toBe('hello');
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 9 Track 2 — onDelta callback thread-through in callTool / _invokeChat
// ═══════════════════════════════════════════════════════════════════════════════

describe('McpToolRegistry.callTool — onDelta callback (Track 2)', () => {

  // ── T2-1: onDelta invoked for every text_delta event ──────────────────────
  it('onDelta is called for every text_delta event with the correct text', async () => {
    const captured = [];
    const { registry, rpc } = makeRegistry({
      promptImpl: function () {
        queueMicrotask(() => {
          rpc.emit('message_update', { type: 'text_delta', delta: 'alpha' });
          rpc.emit('message_update', { type: 'text_delta', delta: ' beta' });
          rpc.emit('message_update', { type: 'text_delta', delta: ' gamma' });
          rpc.emit('agent_end', {});
        });
        return Promise.resolve({ ok: true });
      },
    });

    await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'stream me' },
      synaps_user_id: 'u1',
      onDelta: (text) => captured.push(text),
    });

    expect(captured).toEqual(['alpha', ' beta', ' gamma']);
  });

  // ── T2-2: onDelta invoked in chronological order matching the stream ───────
  it('onDelta calls arrive in the same order as text_delta events', async () => {
    const order = [];
    const TOKENS = ['T1', 'T2', 'T3', 'T4', 'T5'];

    const { registry, rpc } = makeRegistry({
      promptImpl: function () {
        queueMicrotask(() => {
          for (const tok of TOKENS) {
            rpc.emit('message_update', { type: 'text_delta', delta: tok });
          }
          rpc.emit('agent_end', {});
        });
        return Promise.resolve({ ok: true });
      },
    });

    await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'order test' },
      synaps_user_id: 'u1',
      onDelta: (text) => order.push(text),
    });

    expect(order).toEqual(TOKENS);
  });

  // ── T2-3: Buffer integrity — final text === concatenation of all deltas ────
  it('final result text equals the concatenation of all onDelta arguments', async () => {
    const deltas = [];
    const TOKENS = ['Hello', ', ', 'world', '!'];

    const { registry, rpc } = makeRegistry({
      promptImpl: function () {
        queueMicrotask(() => {
          for (const tok of TOKENS) {
            rpc.emit('message_update', { type: 'text_delta', delta: tok });
          }
          rpc.emit('agent_end', {});
        });
        return Promise.resolve({ ok: true });
      },
    });

    const result = await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'integrity' },
      synaps_user_id: 'u1',
      onDelta: (text) => deltas.push(text),
    });

    const concatenated = deltas.join('');
    expect(result.content[0].text).toBe(concatenated);
    expect(result.content[0].text).toBe('Hello, world!');
    expect(result.isError).toBe(false);
  });

  // ── T2-4: Omitting onDelta works (Phase 8 baseline behaviour) ─────────────
  it('omitting onDelta causes no error and returns correct result (Phase 8 baseline)', async () => {
    const { registry, rpc } = makeRegistry({
      promptImpl: function () {
        queueMicrotask(() => {
          rpc.emit('message_update', { type: 'text_delta', delta: 'baseline' });
          rpc.emit('agent_end', {});
        });
        return Promise.resolve({ ok: true });
      },
    });

    // No onDelta supplied — must behave identically to Phase 8.
    const result = await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'no delta cb' },
      synaps_user_id: 'u1',
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'baseline' }],
      isError: false,
    });
  });

});
