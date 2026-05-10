/**
 * @file bridge/core/mcp/mcp-server.test.js
 *
 * Tests for McpServer — JSON-RPC dispatcher (Wave B2).
 *
 * Uses injected fakes for all dependencies; no I/O performed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  McpServer,
  MCP_PROTOCOL_VERSION,
  MCP_ERROR_CODES,
} from './mcp-server.js';
import {
  McpToolNotFoundError,
  McpToolInvalidArgsError,
  McpToolTimeoutError,
} from './mcp-tool-registry.js';

// ─── Shared fake factories ─────────────────────────────────────────────────────

function makeFakes() {
  return {
    fakeTokenResolver: { resolve: vi.fn() },
    fakeToolRegistry:  { listTools: vi.fn(), callTool: vi.fn() },
    fakeApprovalGate:  { filterTools: vi.fn(), isToolAllowed: vi.fn() },
    fakeAudit:         { record: vi.fn() },
    fakeLogger:        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

/**
 * Build a McpServer wired to the supplied fakes.
 * Overrides are merged on top of defaults.
 */
function makeServer(fakes, overrides = {}) {
  return new McpServer({
    tokenResolver: fakes.fakeTokenResolver,
    toolRegistry:  fakes.fakeToolRegistry,
    approvalGate:  fakes.fakeApprovalGate,
    audit:         fakes.fakeAudit,
    logger:        fakes.fakeLogger,
    now:           Date.now,
    ...overrides,
  });
}

/** A resolved identity returned by tokenResolver.resolve() */
const VALID_IDENTITY = Object.freeze({
  synaps_user_id: 'user-42',
  institution_id: 'inst-99',
  token_id:       'tok-abc',
});

/** Convenience: build a minimal valid JSON-RPC 2.0 body */
function rpcBody(method, id = 1, params = {}) {
  return { jsonrpc: '2.0', method, id, params };
}

// ─── Construction ──────────────────────────────────────────────────────────────

describe('McpServer — construction', () => {
  it('throws TypeError when tokenResolver is missing', () => {
    const fakes = makeFakes();
    expect(() => new McpServer({
      toolRegistry: fakes.fakeToolRegistry,
      approvalGate: fakes.fakeApprovalGate,
    })).toThrow(TypeError);
    expect(() => new McpServer({
      toolRegistry: fakes.fakeToolRegistry,
      approvalGate: fakes.fakeApprovalGate,
    })).toThrow('tokenResolver required');
  });

  it('throws TypeError when toolRegistry is missing', () => {
    const fakes = makeFakes();
    expect(() => new McpServer({
      tokenResolver: fakes.fakeTokenResolver,
      approvalGate:  fakes.fakeApprovalGate,
    })).toThrow(TypeError);
    expect(() => new McpServer({
      tokenResolver: fakes.fakeTokenResolver,
      approvalGate:  fakes.fakeApprovalGate,
    })).toThrow('toolRegistry required');
  });

  it('throws TypeError when approvalGate is missing', () => {
    const fakes = makeFakes();
    expect(() => new McpServer({
      tokenResolver: fakes.fakeTokenResolver,
      toolRegistry:  fakes.fakeToolRegistry,
    })).toThrow(TypeError);
    expect(() => new McpServer({
      tokenResolver: fakes.fakeTokenResolver,
      toolRegistry:  fakes.fakeToolRegistry,
    })).toThrow('approvalGate required');
  });

  it('accepts custom serverName and serverVersion', () => {
    const fakes  = makeFakes();
    const server = makeServer(fakes, { serverName: 'my-server', serverVersion: '9.9.9' });
    expect(server._serverName).toBe('my-server');
    expect(server._serverVersion).toBe('9.9.9');
  });

  it('audit defaults to the built-in no-op (does not throw if audit omitted)', async () => {
    const fakes = makeFakes();
    const server = new McpServer({
      tokenResolver: fakes.fakeTokenResolver,
      toolRegistry:  fakes.fakeToolRegistry,
      approvalGate:  fakes.fakeApprovalGate,
      // audit intentionally omitted
    });
    // Trigger initialize (no auth needed) — should not throw
    const res = await server.handle({ body: rpcBody('initialize') });
    expect(res.statusCode).toBe(200);
  });
});

// ─── Parse / envelope validation ───────────────────────────────────────────────

describe('McpServer — parse / envelope validation', () => {
  let fakes, server;

  beforeEach(() => {
    fakes  = makeFakes();
    server = makeServer(fakes);
  });

  it('null body → 400 + PARSE_ERROR', async () => {
    const res = await server.handle({ body: null });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.PARSE_ERROR);
  });

  it('undefined body → 400 + PARSE_ERROR', async () => {
    const res = await server.handle({ body: undefined });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.PARSE_ERROR);
  });

  it('body missing jsonrpc field → 400 + INVALID_REQUEST', async () => {
    const res = await server.handle({ body: { method: 'ping', id: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.INVALID_REQUEST);
  });

  it('body.jsonrpc !== "2.0" → 400 + INVALID_REQUEST', async () => {
    const res = await server.handle({ body: { jsonrpc: '1.0', method: 'ping', id: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.INVALID_REQUEST);
  });

  it('body.method missing → 400 + INVALID_REQUEST', async () => {
    const res = await server.handle({ body: { jsonrpc: '2.0', id: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.INVALID_REQUEST);
  });

  it('body.method not a string → 400 + INVALID_REQUEST', async () => {
    const res = await server.handle({ body: { jsonrpc: '2.0', method: 42, id: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.INVALID_REQUEST);
  });

  it('id may be a number — echoed in response', async () => {
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    const res = await server.handle({ body: { jsonrpc: '2.0', method: 'ping', id: 99 } });
    expect(res.body.id).toBe(99);
  });

  it('id may be a string — echoed in response', async () => {
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    const res = await server.handle({ body: { jsonrpc: '2.0', method: 'ping', id: 'req-abc' } });
    expect(res.body.id).toBe('req-abc');
  });

  it('id may be null — treated as a regular request (not notification)', async () => {
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    const res = await server.handle({ body: { jsonrpc: '2.0', method: 'ping', id: null } });
    // null id is a valid request id per JSON-RPC spec; should NOT be treated as notification
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toBeNull();
  });

  it('request WITHOUT id field (not even null) → 202 + null body (notification)', async () => {
    const res = await server.handle({ body: { jsonrpc: '2.0', method: 'ping' } });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBeNull();
  });

  it('notifications/initialized → 202 + null body', async () => {
    const res = await server.handle({
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBeNull();
  });
});

// ─── Auth ──────────────────────────────────────────────────────────────────────

describe('McpServer — auth', () => {
  let fakes, server;

  beforeEach(() => {
    fakes  = makeFakes();
    server = makeServer(fakes);
  });

  it('initialize WITHOUT token → 200 (auth-exempt)', async () => {
    const res = await server.handle({ body: rpcBody('initialize') });
    expect(res.statusCode).toBe(200);
    expect(fakes.fakeTokenResolver.resolve).not.toHaveBeenCalled();
  });

  it('tools/list without token → 401 + AUTH_REQUIRED, id echoed', async () => {
    fakes.fakeTokenResolver.resolve.mockResolvedValue(null);
    const res = await server.handle({ token: undefined, body: rpcBody('tools/list', 7) });
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.AUTH_REQUIRED);
    expect(res.body.id).toBe(7);
  });

  it('tools/list with invalid token → 401 + AUTH_REQUIRED', async () => {
    fakes.fakeTokenResolver.resolve.mockResolvedValue(null);
    const res = await server.handle({ token: 'bad-token', body: rpcBody('tools/list') });
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.AUTH_REQUIRED);
  });

  it('tools/list with valid token → tokenResolver called once, dispatch proceeds', async () => {
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    fakes.fakeToolRegistry.listTools.mockResolvedValue([]);
    fakes.fakeApprovalGate.filterTools.mockResolvedValue([]);

    const res = await server.handle({ token: 'good-token', body: rpcBody('tools/list') });

    expect(fakes.fakeTokenResolver.resolve).toHaveBeenCalledTimes(1);
    expect(fakes.fakeTokenResolver.resolve).toHaveBeenCalledWith('good-token');
    expect(res.statusCode).toBe(200);
  });

  it('tools/call with invalid token → 401 + AUTH_REQUIRED', async () => {
    fakes.fakeTokenResolver.resolve.mockResolvedValue(null);
    const res = await server.handle({ token: 'bad', body: rpcBody('tools/call', 1, { name: 'synaps_chat', arguments: {} }) });
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.AUTH_REQUIRED);
  });

  it('ping with invalid token → 401 (ping requires auth)', async () => {
    fakes.fakeTokenResolver.resolve.mockResolvedValue(null);
    const res = await server.handle({ token: 'bad', body: rpcBody('ping') });
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.AUTH_REQUIRED);
  });
});

// ─── initialize ───────────────────────────────────────────────────────────────

describe('McpServer — initialize', () => {
  let fakes, server;

  beforeEach(() => {
    fakes  = makeFakes();
    server = makeServer(fakes);
  });

  it('returns protocolVersion === MCP_PROTOCOL_VERSION when client sends matching version', async () => {
    const res = await server.handle({
      body: rpcBody('initialize', 1, { protocolVersion: MCP_PROTOCOL_VERSION }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it('returns server\'s version when client sends a different version (e.g. "2025-01-01")', async () => {
    const res = await server.handle({
      body: rpcBody('initialize', 1, { protocolVersion: '2025-01-01' }),
    });
    expect(res.body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it('includes capabilities.tools.listChanged: false', async () => {
    const res = await server.handle({ body: rpcBody('initialize') });
    expect(res.body.result.capabilities.tools.listChanged).toBe(false);
  });

  it('includes capabilities.logging as an object', async () => {
    const res = await server.handle({ body: rpcBody('initialize') });
    expect(res.body.result.capabilities.logging).toBeDefined();
  });

  it('includes serverInfo.name and serverInfo.version', async () => {
    const customServer = makeServer(fakes, { serverName: 'test-srv', serverVersion: '1.2.3' });
    const res = await customServer.handle({ body: rpcBody('initialize') });
    expect(res.body.result.serverInfo.name).toBe('test-srv');
    expect(res.body.result.serverInfo.version).toBe('1.2.3');
  });

  it('includes instructions (default text)', async () => {
    const res = await server.handle({ body: rpcBody('initialize') });
    expect(typeof res.body.result.instructions).toBe('string');
    expect(res.body.result.instructions.length).toBeGreaterThan(0);
  });

  it('custom instructions override the default', async () => {
    const customServer = makeServer(fakes, { instructions: 'Custom instructions here.' });
    const res = await customServer.handle({ body: rpcBody('initialize') });
    expect(res.body.result.instructions).toBe('Custom instructions here.');
  });

  it('response.id matches request.id', async () => {
    const res = await server.handle({ body: rpcBody('initialize', 'init-42') });
    expect(res.body.id).toBe('init-42');
  });
});

// ─── ping ─────────────────────────────────────────────────────────────────────

describe('McpServer — ping', () => {
  let fakes, server;

  beforeEach(() => {
    fakes  = makeFakes();
    server = makeServer(fakes);
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
  });

  it('returns 200 with empty result {} and id echoed', async () => {
    const res = await server.handle({ token: 't', body: rpcBody('ping', 'ping-1') });
    expect(res.statusCode).toBe(200);
    expect(res.body.result).toEqual({});
    expect(res.body.id).toBe('ping-1');
  });
});

// ─── tools/list ───────────────────────────────────────────────────────────────

describe('McpServer — tools/list', () => {
  const TOOL = { name: 'synaps_chat', description: 'Chat' };
  let fakes, server;

  beforeEach(() => {
    fakes  = makeFakes();
    server = makeServer(fakes);
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
  });

  it('with valid token, returns 200 with {tools: [...]}', async () => {
    fakes.fakeToolRegistry.listTools.mockResolvedValue([TOOL]);
    fakes.fakeApprovalGate.filterTools.mockResolvedValue([TOOL]);

    const res = await server.handle({ token: 't', body: rpcBody('tools/list') });
    expect(res.statusCode).toBe(200);
    expect(res.body.result.tools).toEqual([TOOL]);
  });

  it('calls toolRegistry.listTools with ctx {synaps_user_id, institution_id}', async () => {
    fakes.fakeToolRegistry.listTools.mockResolvedValue([]);
    fakes.fakeApprovalGate.filterTools.mockResolvedValue([]);

    await server.handle({ token: 't', body: rpcBody('tools/list') });

    expect(fakes.fakeToolRegistry.listTools).toHaveBeenCalledWith({
      synaps_user_id: VALID_IDENTITY.synaps_user_id,
      institution_id: VALID_IDENTITY.institution_id,
    });
  });

  it('calls approvalGate.filterTools with the tool list and ctx', async () => {
    fakes.fakeToolRegistry.listTools.mockResolvedValue([TOOL]);
    fakes.fakeApprovalGate.filterTools.mockResolvedValue([TOOL]);

    await server.handle({ token: 't', body: rpcBody('tools/list') });

    expect(fakes.fakeApprovalGate.filterTools).toHaveBeenCalledWith(
      [TOOL],
      { synaps_user_id: VALID_IDENTITY.synaps_user_id, institution_id: VALID_IDENTITY.institution_id },
    );
  });

  it('when filter returns [] → result.tools === []', async () => {
    fakes.fakeToolRegistry.listTools.mockResolvedValue([TOOL]);
    fakes.fakeApprovalGate.filterTools.mockResolvedValue([]);

    const res = await server.handle({ token: 't', body: rpcBody('tools/list') });
    expect(res.body.result.tools).toEqual([]);
  });

  it('when toolRegistry throws → INTERNAL_ERROR in JSON-RPC response (HTTP 200)', async () => {
    fakes.fakeToolRegistry.listTools.mockRejectedValue(new Error('registry exploded'));

    const res = await server.handle({ token: 't', body: rpcBody('tools/list') });
    expect(res.statusCode).toBe(200);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
  });

  it('when approvalGate.filterTools throws → INTERNAL_ERROR in JSON-RPC response', async () => {
    fakes.fakeToolRegistry.listTools.mockResolvedValue([TOOL]);
    fakes.fakeApprovalGate.filterTools.mockRejectedValue(new Error('gate exploded'));

    const res = await server.handle({ token: 't', body: rpcBody('tools/list') });
    expect(res.statusCode).toBe(200);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
  });
});

// ─── tools/call ───────────────────────────────────────────────────────────────

describe('McpServer — tools/call', () => {
  const SUCCESS_RESULT = { content: [{ type: 'text', text: 'hello' }], isError: false };
  let fakes, server;

  beforeEach(() => {
    fakes  = makeFakes();
    server = makeServer(fakes);
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    fakes.fakeApprovalGate.isToolAllowed.mockResolvedValue(true);
    fakes.fakeToolRegistry.callTool.mockResolvedValue(SUCCESS_RESULT);
  });

  it('with valid token + permitted tool → 200 with content blocks', async () => {
    const res = await server.handle({
      token: 't',
      body: rpcBody('tools/call', 1, { name: 'synaps_chat', arguments: { prompt: 'hi' } }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.result).toEqual(SUCCESS_RESULT);
  });

  it('with valid token + denied tool → 200 with APPROVAL_REQUIRED error in envelope', async () => {
    fakes.fakeApprovalGate.isToolAllowed.mockResolvedValue(false);
    const res = await server.handle({
      token: 't',
      body: rpcBody('tools/call', 1, { name: 'synaps_chat', arguments: { prompt: 'hi' } }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.APPROVAL_REQUIRED);
  });

  it('params.name missing → INVALID_PARAMS', async () => {
    const res = await server.handle({
      token: 't',
      body: rpcBody('tools/call', 1, { arguments: { prompt: 'hi' } }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.INVALID_PARAMS);
  });

  it('params.arguments missing → toolRegistry receives arguments: undefined (let registry validate)', async () => {
    await server.handle({
      token: 't',
      body: rpcBody('tools/call', 1, { name: 'synaps_chat' }),
    });
    expect(fakes.fakeToolRegistry.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: undefined }),
    );
  });

  it('McpToolNotFoundError from registry → METHOD_NOT_FOUND', async () => {
    fakes.fakeToolRegistry.callTool.mockRejectedValue(new McpToolNotFoundError('ghost_tool'));
    const res = await server.handle({
      token: 't',
      body: rpcBody('tools/call', 1, { name: 'ghost_tool', arguments: {} }),
    });
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.METHOD_NOT_FOUND);
  });

  it('McpToolInvalidArgsError from registry → INVALID_PARAMS', async () => {
    fakes.fakeToolRegistry.callTool.mockRejectedValue(
      new McpToolInvalidArgsError('synaps_chat', 'prompt missing'),
    );
    const res = await server.handle({
      token: 't',
      body: rpcBody('tools/call', 1, { name: 'synaps_chat', arguments: {} }),
    });
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.INVALID_PARAMS);
  });

  it('McpToolTimeoutError from registry → TOOL_TIMEOUT', async () => {
    fakes.fakeToolRegistry.callTool.mockRejectedValue(
      new McpToolTimeoutError('synaps_chat', 30_000),
    );
    const res = await server.handle({
      token: 't',
      body: rpcBody('tools/call', 1, { name: 'synaps_chat', arguments: { prompt: 'hi' } }),
    });
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.TOOL_TIMEOUT);
  });

  it('generic Error from registry → INTERNAL_ERROR', async () => {
    fakes.fakeToolRegistry.callTool.mockRejectedValue(new Error('unexpected boom'));
    const res = await server.handle({
      token: 't',
      body: rpcBody('tools/call', 1, { name: 'synaps_chat', arguments: { prompt: 'hi' } }),
    });
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
  });

  it('registry returns isError:true → result is wrapped as JSON-RPC result (NOT JSON-RPC error)', async () => {
    const errResult = { content: [{ type: 'text', text: 'tool failed' }], isError: true };
    fakes.fakeToolRegistry.callTool.mockResolvedValue(errResult);

    const res = await server.handle({
      token: 't',
      body: rpcBody('tools/call', 1, { name: 'synaps_chat', arguments: { prompt: 'hi' } }),
    });
    // Must be in .result, not .error
    expect(res.body.result).toEqual(errResult);
    expect(res.body.error).toBeUndefined();
  });
});

// ─── Unknown / unsupported methods ────────────────────────────────────────────

describe('McpServer — unknown / unsupported methods', () => {
  let fakes, server;

  beforeEach(() => {
    fakes  = makeFakes();
    server = makeServer(fakes);
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
  });

  it('resources/list → METHOD_NOT_FOUND', async () => {
    const res = await server.handle({ token: 't', body: rpcBody('resources/list') });
    expect(res.statusCode).toBe(200);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.METHOD_NOT_FOUND);
  });

  it('prompts/list → METHOD_NOT_FOUND', async () => {
    const res = await server.handle({ token: 't', body: rpcBody('prompts/list') });
    expect(res.statusCode).toBe(200);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.METHOD_NOT_FOUND);
  });

  it('foo/bar → METHOD_NOT_FOUND', async () => {
    const res = await server.handle({ token: 't', body: rpcBody('foo/bar') });
    expect(res.statusCode).toBe(200);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.METHOD_NOT_FOUND);
  });
});

// ─── Audit ────────────────────────────────────────────────────────────────────

describe('McpServer — audit', () => {
  let fakes, server;

  beforeEach(() => {
    fakes  = makeFakes();
    server = makeServer(fakes);
  });

  it('successful initialize → audit.record called with method="initialize", outcome="ok", client_info populated', async () => {
    const clientInfo = { name: 'test-client', version: '1.0.0' };
    await server.handle({
      body: rpcBody('initialize', 1, { protocolVersion: MCP_PROTOCOL_VERSION, clientInfo }),
    });

    expect(fakes.fakeAudit.record).toHaveBeenCalledTimes(1);
    const entry = fakes.fakeAudit.record.mock.calls[0][0];
    expect(entry.method).toBe('initialize');
    expect(entry.outcome).toBe('ok');
    expect(entry.client_info).toEqual(clientInfo);
  });

  it('denied tools/call → audit with outcome="denied", tool_name set', async () => {
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    fakes.fakeApprovalGate.isToolAllowed.mockResolvedValue(false);

    await server.handle({
      token: 't',
      body: rpcBody('tools/call', 1, { name: 'synaps_chat', arguments: {} }),
    });

    const entry = fakes.fakeAudit.record.mock.calls[0][0];
    expect(entry.outcome).toBe('denied');
    expect(entry.tool_name).toBe('synaps_chat');
  });

  it('failed token resolution → audit with synaps_user_id=null, outcome="denied", method=actual-method', async () => {
    fakes.fakeTokenResolver.resolve.mockResolvedValue(null);

    await server.handle({
      token: 'bad',
      body: rpcBody('tools/list', 1),
    });

    const entry = fakes.fakeAudit.record.mock.calls[0][0];
    expect(entry.synaps_user_id).toBeNull();
    expect(entry.outcome).toBe('denied');
    expect(entry.method).toBe('tools/list');
  });

  it('registry error → audit with outcome="error", error_code populated', async () => {
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    fakes.fakeToolRegistry.listTools.mockRejectedValue(new Error('boom'));

    await server.handle({ token: 't', body: rpcBody('tools/list') });

    const entry = fakes.fakeAudit.record.mock.calls[0][0];
    expect(entry.outcome).toBe('error');
    expect(entry.error_code).toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
  });

  it('audit.record throwing never causes the request to fail', async () => {
    fakes.fakeAudit.record.mockRejectedValue(new Error('audit DB down'));

    // Even though audit throws, the initialize response should still be returned.
    const res = await server.handle({ body: rpcBody('initialize') });

    expect(res.statusCode).toBe(200);
    expect(res.body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it('audit.record is called with ts, duration_ms, institution_id fields', async () => {
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    fakes.fakeToolRegistry.listTools.mockResolvedValue([]);
    fakes.fakeApprovalGate.filterTools.mockResolvedValue([]);

    await server.handle({ token: 't', body: rpcBody('tools/list') });

    const entry = fakes.fakeAudit.record.mock.calls[0][0];
    expect(typeof entry.ts).toBe('number');
    expect(typeof entry.duration_ms).toBe('number');
    expect(entry.institution_id).toBe(VALID_IDENTITY.institution_id);
  });
});

// ─── Rate-limit (Wave B1) ──────────────────────────────────────────────────────

describe('McpServer — rate-limit gate', () => {
  it('rateLimiter returning allowed=false → 429 + RATE_LIMITED + scope + retryAfterMs', async () => {
    const fakes = makeFakes();
    const rateLimiter = {
      check: vi.fn().mockReturnValue({ allowed: false, scope: 'token', retryAfterMs: 2000 }),
    };
    const server = makeServer(fakes, { rateLimiter });

    const res = await server.handle({
      token:     'tok',
      tokenHash: 'deadbeef',
      ip:        '1.2.3.4',
      body:      rpcBody('ping', 1),
    });

    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe(MCP_ERROR_CODES.RATE_LIMITED);
    expect(res.body.error.data.scope).toBe('token');
    expect(res.body.error.data.retry_after_ms).toBe(2000);
    expect(res.retryAfterMs).toBe(2000);
    expect(rateLimiter.check).toHaveBeenCalledWith({ tokenHash: 'deadbeef', ip: '1.2.3.4' });
  });

  it('rateLimiter returning allowed=false with ip scope → 429 scope=ip', async () => {
    const fakes = makeFakes();
    const rateLimiter = {
      check: vi.fn().mockReturnValue({ allowed: false, scope: 'ip', retryAfterMs: 500 }),
    };
    const server = makeServer(fakes, { rateLimiter });

    const res = await server.handle({
      tokenHash: null,
      ip:        '10.0.0.1',
      body:      rpcBody('ping', 2),
    });

    expect(res.statusCode).toBe(429);
    expect(res.body.error.data.scope).toBe('ip');
  });

  it('rateLimiter returning allowed=true → request proceeds normally', async () => {
    const fakes = makeFakes();
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    const rateLimiter = {
      check: vi.fn().mockReturnValue({ allowed: true }),
    };
    const server = makeServer(fakes, { rateLimiter });

    const res = await server.handle({
      token:     'valid',
      tokenHash: 'abc',
      ip:        '1.2.3.4',
      body:      rpcBody('ping', 3),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.result).toBeDefined();
  });

  it('no rateLimiter injected → request always proceeds (no check called)', async () => {
    const fakes = makeFakes();
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    const server = makeServer(fakes); // no rateLimiter

    const res = await server.handle({
      token: 'valid',
      body:  rpcBody('ping', 4),
    });

    expect(res.statusCode).toBe(200);
  });

  it('rate-limit fires BEFORE body validation (null body still gets 429)', async () => {
    const fakes = makeFakes();
    const rateLimiter = {
      check: vi.fn().mockReturnValue({ allowed: false, scope: 'token', retryAfterMs: 1000 }),
    };
    const server = makeServer(fakes, { rateLimiter });

    const res = await server.handle({ tokenHash: 'x', ip: '1.2.3.4', body: null });
    // Should be 429, not 400 — rate-limit is evaluated first.
    expect(res.statusCode).toBe(429);
  });
});

// ─── SSE branch (Wave B1) ─────────────────────────────────────────────────────

describe('McpServer — SSE branch', () => {
  it('tools/call with Accept:text/event-stream + sseEnabled=true → sse:true marker + sseDispatcher fn', async () => {
    const fakes = makeFakes();
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    fakes.fakeApprovalGate.isToolAllowed.mockResolvedValue(true);
    fakes.fakeToolRegistry.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'hello from tool' }],
      isError: false,
    });

    const server = makeServer(fakes, { sseEnabled: true });

    const res = await server.handle({
      token:  'valid',
      body:   rpcBody('tools/call', 7, { name: 'synaps_chat', arguments: { prompt: 'hi' } }),
      accept: 'text/event-stream',
    });

    expect(res.statusCode).toBe(200);
    expect(res.sse).toBe(true);
    expect(typeof res.sseDispatcher).toBe('function');
    // body should NOT be present on SSE path
    expect(res.body).toBeUndefined();
  });

  it('sseDispatcher, when called, emits notify then result on the transport', async () => {
    const fakes = makeFakes();
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    fakes.fakeApprovalGate.isToolAllowed.mockResolvedValue(true);
    const toolResult = { content: [{ type: 'text', text: 'streamed' }], isError: false };
    fakes.fakeToolRegistry.callTool.mockResolvedValue(toolResult);

    const server = makeServer(fakes, { sseEnabled: true });

    const res = await server.handle({
      token:  'valid',
      body:   rpcBody('tools/call', 8, { name: 'synaps_chat', arguments: { prompt: 'test' } }),
      accept: 'text/event-stream',
    });

    const transport = {
      notify: vi.fn(),
      result: vi.fn(),
      close:  vi.fn(),
    };

    await res.sseDispatcher(transport);

    expect(transport.notify).toHaveBeenCalledWith('synaps/result', toolResult);
    expect(transport.result).toHaveBeenCalledWith(8, toolResult);
  });

  it('tools/call with Accept:text/event-stream but sseEnabled=false → normal JSON path', async () => {
    const fakes = makeFakes();
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    fakes.fakeApprovalGate.isToolAllowed.mockResolvedValue(true);
    fakes.fakeToolRegistry.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });

    const server = makeServer(fakes, { sseEnabled: false }); // SSE off

    const res = await server.handle({
      token:  'valid',
      body:   rpcBody('tools/call', 9, { name: 'synaps_chat', arguments: { prompt: 'hi' } }),
      accept: 'text/event-stream',
    });

    // Should fall through to normal JSON response
    expect(res.statusCode).toBe(200);
    expect(res.sse).toBeUndefined();
    expect(res.body).toBeDefined();
    expect(res.body.result).toBeDefined();
  });

  it('tools/call WITHOUT Accept header + sseEnabled=true → normal JSON path', async () => {
    const fakes = makeFakes();
    fakes.fakeTokenResolver.resolve.mockResolvedValue(VALID_IDENTITY);
    fakes.fakeApprovalGate.isToolAllowed.mockResolvedValue(true);
    fakes.fakeToolRegistry.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });

    const server = makeServer(fakes, { sseEnabled: true });

    const res = await server.handle({
      token: 'valid',
      body:  rpcBody('tools/call', 10, { name: 'synaps_chat', arguments: { prompt: 'hi' } }),
      // no accept field
    });

    expect(res.statusCode).toBe(200);
    expect(res.sse).toBeUndefined();
    expect(res.body.result).toBeDefined();
  });
});
