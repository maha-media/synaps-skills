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
  const rpc = {
    prompt: vi.fn().mockImplementation(
      promptImpl ?? (() => Promise.resolve({ message: 'hi' })),
    ),
  };
  const sessionRouter = {
    getOrCreate: vi.fn().mockResolvedValue(rpc),
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
    expect(() => new McpToolRegistry({})).toThrow('sessionRouter required');
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
  it('calls sessionRouter.getOrCreate with {synaps_user_id}', async () => {
    const { registry, sessionRouter } = makeRegistry();
    await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'hello' },
      synaps_user_id: 'user-42',
    });
    expect(sessionRouter.getOrCreate).toHaveBeenCalledWith({ synaps_user_id: 'user-42' });
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

  it('handles bare string result from rpc.prompt', async () => {
    const { registry } = makeRegistry({ promptImpl: () => Promise.resolve('plain string') });
    const result = await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'q' },
      synaps_user_id: 'u1',
    });
    expect(result.content[0].text).toBe('plain string');
    expect(result.isError).toBe(false);
  });

  it('handles weird shape from rpc.prompt → JSON.stringify fallback', async () => {
    const weirdShape = { unexpected: true, value: 99 };
    const { registry } = makeRegistry({ promptImpl: () => Promise.resolve(weirdShape) });
    const result = await registry.callTool({
      name: 'synaps_chat',
      arguments: { prompt: 'q' },
      synaps_user_id: 'u1',
    });
    expect(result.content[0].text).toBe(JSON.stringify(weirdShape));
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
