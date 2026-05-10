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
  const rpc = {
    prompt: vi.fn().mockImplementation(
      promptImpl ?? (() => Promise.resolve({ message: 'hi' })),
    ),
  };
  const sessionRouter = { getOrCreate: vi.fn().mockResolvedValue(rpc) };
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
    const sessionRouter = { getOrCreate: vi.fn().mockResolvedValue(rpc) };
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
    expect(sessionRouter.getOrCreate).toHaveBeenCalledWith({ synaps_user_id: 'u1' });
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
    const sessionRouter = { getOrCreate: vi.fn().mockResolvedValue(rpc) };
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
