/**
 * @file tests/scp-phase-8/03-per-tool-surfacing.test.mjs
 *
 * Acceptance test — Track 2: Per-Tool Surfacing of SynapsRpc Registry
 *
 * Tests:
 *  1. tools/list with surface_rpc_tools=true + mock rpc returning 2 tools →
 *     merged list has synaps_chat + 2 rpc tools (3 total).
 *  2. tools/list with surface_rpc_tools=false → only synaps_chat (1 tool).
 *  3. tools/call for a known rpc tool (web_fetch) → routed through rpcRouter.callTool().
 *  4. tools/call for unknown tool with surface_rpc_tools=false → -32601 Method Not Found.
 *  5. SynapsRpcSessionRouter.listTools(): cache hit (second call reuses cached list).
 *  6. SynapsRpcSessionRouter.listTools(): rpcFactory failure → returns [] (fault-tolerant).
 *  7. SynapsRpcSessionRouter.callTool(): ok response → correct MCP content shape.
 *  8. SynapsRpcSessionRouter.callTool(): rpcFactory error → isError:true response.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { SynapsRpcSessionRouter } from '../../bridge/core/synaps-rpc-session-router.js';
import { McpToolRegistry } from '../../bridge/core/mcp/mcp-tool-registry.js';
import { McpServer, MCP_ERROR_CODES } from '../../bridge/core/mcp/mcp-server.js';
import { ScpHttpServer } from '../../bridge/core/scp-http-server.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeConfig() {
  return {
    platform: { mode: 'scp' },
    web:      { enabled: true, http_port: 0, bind: '127.0.0.1',
                trust_proxy_header: 'x-synaps-user-id', allowed_origin: '' },
  };
}
function makeVncProxy() {
  return { middleware: () => (_req, _res, next) => next(), upgrade: () => {} };
}

/** Two fake rpc tools returned by the mock workspace. */
const RPC_TOOLS = [
  { name: 'web_fetch',  description: 'Fetch a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];

/** Build a rpcFactory stub that returns a handle. */
function makeRpcFactory({ toolsResponse = { ok: true, tools: RPC_TOOLS }, callResponse = null } = {}) {
  return vi.fn(async () => ({
    send: vi.fn(async (op) => {
      if (op.op === 'tools_list') return toolsResponse;
      if (op.op === 'tool_call')  return callResponse ?? { ok: true, result: `result-of-${op.name}` };
      return { ok: false };
    }),
  }));
}

/** fake sessionRouter for synaps_chat path. */
function makeSessionRouter() {
  return {
    getOrCreate: vi.fn(async () => ({
      prompt: vi.fn(async () => 'synaps-chat-response'),
    })),
  };
}

function post(port, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/mcp/v1', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...extraHeaders } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

const VALID_TOKEN = 'valid-bearer';
const USER_ID     = 'user-surf-1';

function makeTokenResolver() {
  return {
    resolve: async (t) =>
      t === VALID_TOKEN
        ? { synaps_user_id: USER_ID, institution_id: 'inst-1', token_id: 'tok-1' }
        : null,
  };
}

const ALLOW_ALL_GATE = {
  filterTools:   async (tools) => tools,
  isToolAllowed: async ()      => true,
};

// ─── Unit tests: SynapsRpcSessionRouter ──────────────────────────────────────

describe('SynapsRpcSessionRouter — unit', () => {
  it('listTools() returns [] when rpcFactory throws', async () => {
    const router = new SynapsRpcSessionRouter({
      rpcFactory: async () => { throw new Error('cannot connect'); },
      logger: silent,
    });
    const tools = await router.listTools('u1');
    expect(tools).toEqual([]);
  });

  it('listTools() returns [] when response has ok=false', async () => {
    const router = new SynapsRpcSessionRouter({
      rpcFactory: makeRpcFactory({ toolsResponse: { ok: false } }),
      logger: silent,
    });
    const tools = await router.listTools('u2');
    expect(tools).toEqual([]);
  });

  it('listTools() returns tool list on ok=true response', async () => {
    const router = new SynapsRpcSessionRouter({
      rpcFactory: makeRpcFactory(),
      logger: silent,
    });
    const tools = await router.listTools('u3');
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('web_fetch');
  });

  it('listTools() cache: second call reuses cached list (rpcFactory called once)', async () => {
    const factory = makeRpcFactory();
    const router = new SynapsRpcSessionRouter({
      rpcFactory: factory,
      cacheTtlMs: 60_000,
      logger: silent,
    });
    await router.listTools('u4');
    await router.listTools('u4');
    // rpcFactory called only once (second call uses cache)
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('callTool() returns correct MCP content shape on success', async () => {
    const router = new SynapsRpcSessionRouter({
      rpcFactory: makeRpcFactory({ callResponse: { ok: true, result: 'fetch-result' } }),
      logger: silent,
    });
    const result = await router.callTool({ synapsUserId: 'u5', name: 'web_fetch', args: { url: 'https://example.com' } });
    expect(result.isError).toBe(false);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('fetch-result');
  });

  it('callTool() returns isError:true when rpcFactory throws', async () => {
    const router = new SynapsRpcSessionRouter({
      rpcFactory: async () => { throw new Error('rpc down'); },
      logger: silent,
    });
    const result = await router.callTool({ synapsUserId: 'u6', name: 'web_fetch', args: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('rpc down');
  });
});

// ─── HTTP harness — tools/list merging ───────────────────────────────────────

describe('McpServer — tools/list with surface_rpc_tools (HTTP harness)', () => {
  let srvSurface, portSurface;
  let srvNoSurface, portNoSurface;

  beforeAll(async () => {
    // Surfacing-ON server
    const rpcRouter = new SynapsRpcSessionRouter({ rpcFactory: makeRpcFactory(), logger: silent });
    const toolRegSurface = new McpToolRegistry({
      sessionRouter: makeSessionRouter(),
      rpcRouter,
      surfaceRpcTools: true,
      logger: silent,
    });
    const mcpSurface = new McpServer({
      tokenResolver: makeTokenResolver(),
      toolRegistry:  toolRegSurface,
      approvalGate:  ALLOW_ALL_GATE,
      logger: silent,
    });
    srvSurface = new ScpHttpServer({
      config: makeConfig(), vncProxy: makeVncProxy(),
      mcpServer: mcpSurface, logger: silent,
    });
    portSurface = (await srvSurface.start()).port;

    // Surfacing-OFF server
    const toolRegNoSurface = new McpToolRegistry({
      sessionRouter: makeSessionRouter(),
      surfaceRpcTools: false,
      logger: silent,
    });
    const mcpNoSurface = new McpServer({
      tokenResolver: makeTokenResolver(),
      toolRegistry:  toolRegNoSurface,
      approvalGate:  ALLOW_ALL_GATE,
      logger: silent,
    });
    srvNoSurface = new ScpHttpServer({
      config: makeConfig(), vncProxy: makeVncProxy(),
      mcpServer: mcpNoSurface, logger: silent,
    });
    portNoSurface = (await srvNoSurface.start()).port;
  });

  afterAll(async () => {
    await srvSurface.stop();
    await srvNoSurface.stop();
  });

  it('surface_rpc_tools=true: tools/list returns synaps_chat + 2 rpc tools (3 total)', async () => {
    const { statusCode, body } = await post(portSurface,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { 'mcp-token': VALID_TOKEN },
    );
    expect(statusCode).toBe(200);
    const tools = body.result.tools;
    expect(tools.length).toBe(3);
    expect(tools.map((t) => t.name)).toContain('synaps_chat');
    expect(tools.map((t) => t.name)).toContain('web_fetch');
    expect(tools.map((t) => t.name)).toContain('web_search');
  });

  it('surface_rpc_tools=false: tools/list returns only synaps_chat (1 tool)', async () => {
    const { body } = await post(portNoSurface,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { 'mcp-token': VALID_TOKEN },
    );
    const tools = body.result.tools;
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('synaps_chat');
  });

  it('surface_rpc_tools=false: tools/call for unknown tool → -32601 Method Not Found', async () => {
    const { statusCode, body } = await post(portNoSurface,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'web_fetch', arguments: { url: 'https://x.com' } } },
      { 'mcp-token': VALID_TOKEN },
    );
    expect(statusCode).toBe(200);
    expect(body.error.code).toBe(MCP_ERROR_CODES.METHOD_NOT_FOUND);
  });
});
