/**
 * @file tests/scp-phase-7/00-mcp-initialize-handshake.test.mjs
 *
 * End-to-end JSON-RPC handshake against an in-process HTTP server running
 * ScpHttpServer with a real McpServer (no Mongo — all collaborators mocked).
 *
 * Tests:
 *   1. POST /mcp/v1 with `initialize` → 200 + valid response, protocolVersion echoed
 *   2. POST /mcp/v1 with `notifications/initialized` → 202, no body
 *   3. POST /mcp/v1 with `ping` after init → 200 + empty result
 *   4. POST /mcp/v1 with malformed JSON → 400 + parse error envelope
 *   5. POST /mcp/v1 with oversized body (maxBodyBytes=1024, body=2KB) → 413
 *   6. POST /mcp/v1 without MCP-Token header on `tools/list` → 401 + AUTH_REQUIRED
 *   7. GET  /mcp/v1 → 405 with Allow: POST
 *   8. POST without mcpServer wired (mcpServer:null) → 404
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { ScpHttpServer }      from '../../bridge/core/scp-http-server.js';
import { McpServer, MCP_PROTOCOL_VERSION, MCP_ERROR_CODES } from '../../bridge/core/mcp/mcp-server.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeConfig(overrides = {}) {
  return {
    platform: { mode: 'scp' },
    web:      {
      enabled:               true,
      http_port:             0,
      bind:                  '127.0.0.1',
      trust_proxy_header:    'x-synaps-user-id',
      allowed_origin:        '',
      ...overrides,
    },
  };
}

function makeVncProxy() {
  return {
    middleware: () => (_req, _res, next) => next(),
    upgrade:    () => {},
  };
}

/**
 * Build a minimal McpServer with full mocks for collaborators.
 *
 * tokenResolver resolves 'valid-token' → a fake user context.
 * toolRegistry  returns an empty tool list (approval gate will filter anyway).
 * approvalGate  allows everything.
 */
function makeMockMcpServer() {
  const tokenResolver = {
    resolve: async (token) =>
      token === 'valid-token'
        ? { synaps_user_id: 'user-1', institution_id: 'inst-1', token_id: 'tok-1' }
        : null,
  };

  const toolRegistry = {
    listTools:  async () => [],
    callTool:   async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  };

  const approvalGate = {
    filterTools:   async (tools) => tools,
    isToolAllowed: async ()      => true,
  };

  return new McpServer({
    tokenResolver,
    toolRegistry,
    approvalGate,
    logger: silent,
  });
}

/**
 * POST JSON to the server.  Returns { statusCode, headers, body }.
 * body is parsed JSON when parseable, raw string otherwise.
 */
function post(port, rawBody, headers = {}) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody), 'utf8');
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path:     '/mcp/v1',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end',  () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = body; }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function get(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/mcp/v1', method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end',  () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── Shared server ─────────────────────────────────────────────────────────

let srv;        // ScpHttpServer with mcpServer
let port;       // bound port
let noMcpSrv;  // ScpHttpServer without mcpServer
let noMcpPort;

beforeAll(async () => {
  const mcpServer = makeMockMcpServer();

  srv = new ScpHttpServer({
    config:   makeConfig(),
    vncProxy: makeVncProxy(),
    mcpServer,
    logger:   silent,
  });
  const result  = await srv.start();
  port          = result.port;

  noMcpSrv = new ScpHttpServer({
    config:   makeConfig(),
    vncProxy: makeVncProxy(),
    mcpServer: null,
    logger:   silent,
  });
  const noMcpResult = await noMcpSrv.start();
  noMcpPort         = noMcpResult.port;
});

afterAll(async () => {
  await srv.stop();
  await noMcpSrv.stop();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MCP handshake — initialize', () => {
  it('POST /mcp/v1 initialize → 200 + protocolVersion echoed in result', async () => {
    const { statusCode, body } = await post(port, {
      jsonrpc: '2.0',
      id:      1,
      method:  'initialize',
      params:  {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities:    {},
        clientInfo:      { name: 'test-client', version: '0.0.1' },
      },
    }, { 'mcp-token': 'valid-token' });

    expect(statusCode).toBe(200);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(body.result.serverInfo).toBeDefined();
    expect(body.result.capabilities).toBeDefined();
  });
});

describe('MCP handshake — notifications/initialized', () => {
  it('POST /mcp/v1 notifications/initialized → 202, no body', async () => {
    const { statusCode, body } = await post(port, {
      jsonrpc: '2.0',
      method:  'notifications/initialized',
      params:  {},
    });

    expect(statusCode).toBe(202);
    // 202 response has no body
    expect(body === '' || body === null || (typeof body === 'string' && body.trim() === '')).toBe(true);
  });
});

describe('MCP handshake — ping', () => {
  it('POST /mcp/v1 ping with valid token → 200 + empty result', async () => {
    const { statusCode, body } = await post(port, {
      jsonrpc: '2.0',
      id:      2,
      method:  'ping',
    }, { 'mcp-token': 'valid-token' });

    expect(statusCode).toBe(200);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(2);
    // ping result is an empty object
    expect(body.result).toBeDefined();
    expect(body.error).toBeUndefined();
  });
});

describe('MCP handshake — malformed JSON', () => {
  it('POST /mcp/v1 with malformed JSON → 400 + parse error envelope', async () => {
    const { statusCode, body } = await post(port, 'this is {not json}');

    expect(statusCode).toBe(400);
    // Body should be a JSON-RPC error envelope
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(MCP_ERROR_CODES.PARSE_ERROR);
  });
});

describe('MCP handshake — body too large', () => {
  let smallSrv, smallPort;

  beforeAll(async () => {
    smallSrv = new ScpHttpServer({
      config:       makeConfig(),
      vncProxy:     makeVncProxy(),
      mcpServer:    makeMockMcpServer(),
      maxBodyBytes: 1024,
      logger:       silent,
    });
    const r  = await smallSrv.start();
    smallPort = r.port;
  });

  afterAll(async () => { await smallSrv.stop(); });

  it('body > maxBodyBytes (1024) → 413', async () => {
    const bigBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { pad: 'x'.repeat(2048) } });
    const { statusCode } = await post(smallPort, bigBody);
    expect(statusCode).toBe(413);
  });
});

describe('MCP handshake — missing auth', () => {
  it('POST /mcp/v1 tools/list without MCP-Token → 401 + AUTH_REQUIRED error code', async () => {
    const { statusCode, body } = await post(port, {
      jsonrpc: '2.0',
      id:      3,
      method:  'tools/list',
      params:  {},
      // No 'mcp-token' header
    });

    expect(statusCode).toBe(401);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(MCP_ERROR_CODES.AUTH_REQUIRED);
  });
});

describe('MCP handshake — wrong HTTP method', () => {
  it('GET /mcp/v1 → 405 with Allow: POST header', async () => {
    const { statusCode, headers } = await get(port);
    expect(statusCode).toBe(405);
    expect(headers.allow).toBe('POST');
  });
});

describe('MCP handshake — no mcpServer wired', () => {
  it('POST /mcp/v1 when mcpServer is null → 404', async () => {
    const { statusCode } = await post(noMcpPort, {
      jsonrpc: '2.0',
      id:      1,
      method:  'initialize',
      params:  {},
    });
    expect(statusCode).toBe(404);
  });
});
