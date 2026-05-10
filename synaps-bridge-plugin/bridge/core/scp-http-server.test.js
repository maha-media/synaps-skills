/**
 * @file bridge/core/scp-http-server.test.js
 *
 * Tests for ScpHttpServer.
 *
 * Uses a real http.request against http_port: 0 so the OS picks a free port.
 * A mock VncProxy is injected via vi.fn() to avoid real VNC upstream.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { ScpHttpServer } from './scp-http-server.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeConfig({ mode = 'scp', enabled = true, http_port = 0, bind = '127.0.0.1' } = {}) {
  return {
    platform: { mode },
    web:      { enabled, http_port, bind, trust_proxy_header: 'x-synaps-user-id', allowed_origin: '' },
  };
}

function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Create a mock VncProxy whose middleware() and upgrade() are vi.fn().
 *
 * By default:
 *  - middleware() returns a handler that calls next() (pass-through)
 *  - upgrade() is a no-op
 */
function makeMockVncProxy({ middlewareBehavior = 'next' } = {}) {
  const upgradeHandler = vi.fn();

  let middlewareHandler;
  if (middlewareBehavior === 'next') {
    middlewareHandler = vi.fn((_req, _res, next) => next());
  } else if (middlewareBehavior === 'handle') {
    middlewareHandler = vi.fn((req, res, _next) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('vnc-handled');
    });
  } else {
    middlewareHandler = vi.fn((_req, _res, next) => next());
  }

  const proxy = {
    middleware: vi.fn(() => middlewareHandler),
    upgrade:    upgradeHandler,
    _middlewareHandler: middlewareHandler,
  };
  return proxy;
}

/**
 * Make a simple HTTP request and collect the response.
 *
 * @param {number} port
 * @param {string} path
 * @param {object} [opts]
 * @returns {Promise<{ statusCode: number, headers: object, body: string }>}
 */
function httpGet(port, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: opts.method || 'GET', headers: opts.headers || {} },
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

/**
 * POST a JSON body to the server and collect the response.
 *
 * @param {number} port
 * @param {string} path
 * @param {string|Buffer} rawBody
 * @param {object} [extraHeaders]
 * @returns {Promise<{ statusCode: number, headers: object, body: string }>}
 */
function httpPost(port, path, rawBody, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': bodyBuf.length,
      ...extraHeaders,
    };
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end',  () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

describe('ScpHttpServer — lifecycle', () => {
  let server;

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {});
      server = null;
    }
  });

  it('start() makes server listening; stop() releases port', async () => {
    server = new ScpHttpServer({
      config:   makeConfig(),
      vncProxy: makeMockVncProxy(),
      logger:   makeLogger(),
    });

    expect(server.listening).toBe(false);
    const { port } = await server.start();
    expect(typeof port).toBe('number');
    expect(port).toBeGreaterThan(0);
    expect(server.listening).toBe(true);

    await server.stop();
    expect(server.listening).toBe(false);
    server = null;
  });

  it('stop() when not started resolves silently', async () => {
    server = new ScpHttpServer({
      config:   makeConfig(),
      vncProxy: makeMockVncProxy(),
      logger:   makeLogger(),
    });
    // Should not throw
    await expect(server.stop()).resolves.toBeUndefined();
    server = null;
  });

  it('start() twice rejects with "already started" error', async () => {
    server = new ScpHttpServer({
      config:   makeConfig(),
      vncProxy: makeMockVncProxy(),
      logger:   makeLogger(),
    });

    await server.start();
    await expect(server.start()).rejects.toThrow(/already started/i);
  });

  it('no port leaked between independent server instances', async () => {
    const s1 = new ScpHttpServer({
      config:   makeConfig(),
      vncProxy: makeMockVncProxy(),
      logger:   makeLogger(),
    });
    const { port: port1 } = await s1.start();
    await s1.stop();

    const s2 = new ScpHttpServer({
      config:   makeConfig(),
      vncProxy: makeMockVncProxy(),
      logger:   makeLogger(),
    });
    const { port: port2 } = await s2.start();
    await s2.stop();

    // Both should have gotten valid ports; test just checks no error thrown.
    expect(port1).toBeGreaterThan(0);
    expect(port2).toBeGreaterThan(0);
  });
});

// ─── /health ──────────────────────────────────────────────────────────────────

describe('ScpHttpServer — GET /health', () => {
  let server;
  let port;

  beforeEach(async () => {
    server = new ScpHttpServer({
      config:   makeConfig({ mode: 'scp' }),
      vncProxy: makeMockVncProxy(),
      logger:   makeLogger(),
    });
    ({ port } = await server.start());
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 200 with JSON {status, mode, ts}', async () => {
    const { statusCode, headers, body } = await httpGet(port, '/health');
    expect(statusCode).toBe(200);
    expect(headers['content-type']).toMatch(/application\/json/);
    const json = JSON.parse(body);
    expect(json.status).toBe('ok');
    expect(json.mode).toBe('scp');
    expect(typeof json.ts).toBe('string');
    // ts should be a parseable ISO date
    expect(() => new Date(json.ts)).not.toThrow();
    expect(new Date(json.ts).getTime()).toBeGreaterThan(0);
  });

  it('/health reflects mode from config', async () => {
    await server.stop();
    server = new ScpHttpServer({
      config:   makeConfig({ mode: 'bridge' }),
      vncProxy: makeMockVncProxy(),
      logger:   makeLogger(),
    });
    ({ port } = await server.start());

    const { body } = await httpGet(port, '/health');
    expect(JSON.parse(body).mode).toBe('bridge');
  });
});

// ─── /vnc/* delegation ────────────────────────────────────────────────────────

describe('ScpHttpServer — GET /vnc/:id delegates to vncProxy.middleware', () => {
  let server;
  let port;
  let proxy;

  beforeEach(async () => {
    proxy  = makeMockVncProxy({ middlewareBehavior: 'handle' });
    server = new ScpHttpServer({
      config:   makeConfig(),
      vncProxy: proxy,
      logger:   makeLogger(),
    });
    ({ port } = await server.start());
  });

  afterEach(async () => {
    await server.stop();
  });

  it('calls vncProxy.middleware() once on construction and invokes handler per request', async () => {
    const { statusCode, body } = await httpGet(port, '/vnc/abc', {
      headers: { 'x-synaps-user-id': 'user-1' },
    });
    // proxy middleware said 200 + 'vnc-handled'
    expect(statusCode).toBe(200);
    expect(body).toBe('vnc-handled');
    expect(proxy.middleware).toHaveBeenCalledTimes(1); // called once in start()
    expect(proxy._middlewareHandler).toHaveBeenCalled();
  });
});

// ─── WebSocket upgrade ────────────────────────────────────────────────────────

describe('ScpHttpServer — WebSocket upgrade for /vnc/* delegates to vncProxy.upgrade', () => {
  it('calls vncProxy.upgrade for /vnc/* WebSocket upgrades', async () => {
    const proxy = makeMockVncProxy();
    // Make upgrade write a fake 101 so the raw socket gets a response and closes
    proxy.upgrade = vi.fn((req, socket, _head) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
      socket.destroy(); // close promptly so server.close() can complete
    });

    const server = new ScpHttpServer({
      config:   makeConfig(),
      vncProxy: proxy,
      logger:   makeLogger(),
    });
    const { port } = await server.start();

    try {
      // Use raw net socket to send the WebSocket upgrade request
      const net = await import('node:net');
      await new Promise((resolve, reject) => {
        const sock = net.default.createConnection({ port, host: '127.0.0.1' }, () => {
          sock.write(
            'GET /vnc/abc HTTP/1.1\r\n' +
            'Host: localhost\r\n' +
            'Connection: Upgrade\r\n' +
            'Upgrade: websocket\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            'x-synaps-user-id: user-test\r\n' +
            '\r\n',
          );
        });
        sock.once('data', () => {
          sock.destroy();
          resolve();
        });
        sock.on('close', resolve);
        sock.on('error', reject);
        sock.setTimeout(5000, () => {
          sock.destroy();
          reject(new Error('socket timed out'));
        });
      });
    } finally {
      await server.stop();
    }

    expect(proxy.upgrade).toHaveBeenCalledTimes(1);
    const upgradeReq = proxy.upgrade.mock.calls[0][0];
    expect(upgradeReq.url).toBe('/vnc/abc');
  }, 15000); // give this test more time
});

// ─── unknown route → 404 ──────────────────────────────────────────────────────

describe('ScpHttpServer — unknown route returns 404 JSON', () => {
  let server;
  let port;

  beforeEach(async () => {
    server = new ScpHttpServer({
      config:   makeConfig(),
      vncProxy: makeMockVncProxy(),
      logger:   makeLogger(),
    });
    ({ port } = await server.start());
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 404 JSON for unknown path', async () => {
    const { statusCode, headers, body } = await httpGet(port, '/no/such/path');
    expect(statusCode).toBe(404);
    expect(headers['content-type']).toMatch(/application\/json/);
    const json = JSON.parse(body);
    expect(json.error).toBe('not_found');
  });

  it('returns 404 JSON for root path', async () => {
    const { statusCode, body } = await httpGet(port, '/');
    expect(statusCode).toBe(404);
    expect(JSON.parse(body).error).toBe('not_found');
  });
});

// ─── constructor validation ───────────────────────────────────────────────────

describe('ScpHttpServer — constructor validation', () => {
  it('throws when config is missing', () => {
    expect(() => new ScpHttpServer({ vncProxy: makeMockVncProxy() })).toThrow(TypeError);
  });

  it('throws when vncProxy is missing', () => {
    expect(() => new ScpHttpServer({ config: makeConfig() })).toThrow(TypeError);
  });
});

// ─── /health — Wave B2: component table + graduated status ───────────────────

/**
 * Build a synthetic heartbeat document as HeartbeatRepo.findAll() returns.
 *
 * @param {object} opts
 * @param {string}  opts.component
 * @param {string}  opts.id
 * @param {number}  opts.ageMs     - How many ms in the past the beat was recorded.
 * @param {boolean} [opts.healthy=true]
 * @returns {object}
 */
function mkBeat({ component, id, ageMs, healthy = true }) {
  return {
    component,
    id,
    healthy,
    ts:      new Date(Date.now() - ageMs),
    details: {},
  };
}

/**
 * Create a mock HeartbeatRepo whose findAll() resolves with the given beats.
 *
 * @param {object[]} beats
 * @returns {{ findAll: import('vitest').MockedFunction }}
 */
function makeRepo(beats) {
  return { findAll: vi.fn().mockResolvedValue(beats) };
}

describe('ScpHttpServer — /health with heartbeatRepo (Wave B2)', () => {
  /**
   * Helper: spin up a server with the given heartbeatRepo + optional
   * bridgeCriticalMs, make a GET /health, stop the server, return parsed JSON
   * and HTTP status code.
   */
  async function healthCheck({ repo, bridgeCriticalMs } = {}) {
    const srv = new ScpHttpServer({
      config:          makeConfig({ mode: 'scp' }),
      vncProxy:        makeMockVncProxy(),
      logger:          makeLogger(),
      heartbeatRepo:   repo,
      bridgeCriticalMs,
    });
    const { port } = await srv.start();
    try {
      const { statusCode, body } = await httpGet(port, '/health');
      return { statusCode, json: JSON.parse(body) };
    } finally {
      await srv.stop();
    }
  }

  // ── Test 1: backward compat — no repo → Phase-1 shape ──────────────────────
  it('1: no heartbeatRepo → 200 Phase-1 shape: {status,mode,ts}, no components', async () => {
    const { statusCode, json } = await healthCheck({ repo: null });

    expect(statusCode).toBe(200);
    expect(json.status).toBe('ok');
    expect(json.mode).toBe('scp');
    expect(typeof json.ts).toBe('string');
    expect(json.components).toBeUndefined();
  });

  // ── Test 2: repo returns no beats → no bridge anchor → 503 down ────────────
  it('2: repo present, no heartbeats → 503 down (no bridge anchor)', async () => {
    const { statusCode, json } = await healthCheck({ repo: makeRepo([]) });

    expect(statusCode).toBe(503);
    expect(json.status).toBe('down');
    expect(Array.isArray(json.components)).toBe(true);
    expect(json.components).toHaveLength(0);
  });

  // ── Test 3: bridge healthy + recent → 200 ok ───────────────────────────────
  it('3: bridge healthy + recent → 200 ok, components includes bridge', async () => {
    const beats = [mkBeat({ component: 'bridge', id: 'main', ageMs: 500 })];
    const { statusCode, json } = await healthCheck({ repo: makeRepo(beats) });

    expect(statusCode).toBe(200);
    expect(json.status).toBe('ok');
    expect(json.components).toHaveLength(1);
    expect(json.components[0].component).toBe('bridge');
    expect(json.components[0].id).toBe('main');
    expect(json.components[0].healthy).toBe(true);
  });

  // ── Test 4: bridge healthy but stale → 503 down ────────────────────────────
  it('4: bridge healthy but ageMs > bridgeCriticalMs → 503 down', async () => {
    const beats = [mkBeat({ component: 'bridge', id: 'main', ageMs: 70_000 })];
    // bridgeCriticalMs = 60_000 (default)
    const { statusCode, json } = await healthCheck({ repo: makeRepo(beats) });

    expect(statusCode).toBe(503);
    expect(json.status).toBe('down');
  });

  // ── Test 5: bridge.healthy === false → 503 down ────────────────────────────
  it('5: bridge.healthy=false → 503 down', async () => {
    const beats = [mkBeat({ component: 'bridge', id: 'main', ageMs: 500, healthy: false })];
    const { statusCode, json } = await healthCheck({ repo: makeRepo(beats) });

    expect(statusCode).toBe(503);
    expect(json.status).toBe('down');
  });

  // ── Test 6: bridge ok + workspace stale → 200 degraded ─────────────────────
  it('6: bridge ok + workspace stale → 200 degraded', async () => {
    const beats = [
      mkBeat({ component: 'bridge',    id: 'main',     ageMs: 500 }),
      mkBeat({ component: 'workspace', id: 'ws_alice', ageMs: 90_000 }), // stale
    ];
    const { statusCode, json } = await healthCheck({ repo: makeRepo(beats) });

    expect(statusCode).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.components).toHaveLength(2);
  });

  // ── Test 7: bridge ok + workspace.healthy=false → 200 degraded ─────────────
  it('7: bridge ok + workspace.healthy=false → 200 degraded', async () => {
    const beats = [
      mkBeat({ component: 'bridge',    id: 'main',     ageMs: 500 }),
      mkBeat({ component: 'workspace', id: 'ws_bob',   ageMs: 1000, healthy: false }),
    ];
    const { statusCode, json } = await healthCheck({ repo: makeRepo(beats) });

    expect(statusCode).toBe(200);
    expect(json.status).toBe('degraded');
  });

  // ── Test 8: bridge ok + rpc stale → 200 degraded ───────────────────────────
  it('8: bridge ok + rpc stale → 200 degraded', async () => {
    const beats = [
      mkBeat({ component: 'bridge', id: 'main',     ageMs: 500 }),
      mkBeat({ component: 'rpc',    id: 'sess_xyz', ageMs: 80_000 }), // stale
    ];
    const { statusCode, json } = await healthCheck({ repo: makeRepo(beats) });

    expect(statusCode).toBe(200);
    expect(json.status).toBe('degraded');
  });

  // ── Test 9: bridge ok + scp stale → 200 degraded ───────────────────────────
  it('9: bridge ok + scp stale → 200 degraded', async () => {
    const beats = [
      mkBeat({ component: 'bridge', id: 'main', ageMs: 500 }),
      mkBeat({ component: 'scp',    id: 'scp0', ageMs: 75_000 }), // stale, non-bridge
    ];
    const { statusCode, json } = await healthCheck({ repo: makeRepo(beats) });

    expect(statusCode).toBe(200);
    expect(json.status).toBe('degraded');
  });

  // ── Test 10: repo throws → 503 down, error:'heartbeat_unavailable' ──────────
  it('10: repo.findAll() throws → 503 down with error:heartbeat_unavailable', async () => {
    const errRepo = { findAll: vi.fn().mockRejectedValue(new Error('mongo exploded')) };
    const { statusCode, json } = await healthCheck({ repo: errRepo });

    expect(statusCode).toBe(503);
    expect(json.status).toBe('down');
    expect(json.error).toBe('heartbeat_unavailable');
    expect(Array.isArray(json.components)).toBe(true);
    expect(json.components).toHaveLength(0);
  });

  // ── Test 11: multiple all-healthy components → 200 ok, all listed ───────────
  it('11: multiple components all healthy → 200 ok, all appear in components array', async () => {
    const beats = [
      mkBeat({ component: 'bridge',    id: 'main',     ageMs: 500 }),
      mkBeat({ component: 'workspace', id: 'ws_alice', ageMs: 1000 }),
      mkBeat({ component: 'rpc',       id: 'sess_xyz', ageMs: 2000 }),
      mkBeat({ component: 'scp',       id: 'scp0',     ageMs: 800 }),
    ];
    const { statusCode, json } = await healthCheck({ repo: makeRepo(beats) });

    expect(statusCode).toBe(200);
    expect(json.status).toBe('ok');
    expect(json.components).toHaveLength(4);
    const names = json.components.map((c) => c.component);
    expect(names).toContain('bridge');
    expect(names).toContain('workspace');
    expect(names).toContain('rpc');
    expect(names).toContain('scp');
  });

  // ── Test 12: ageMs is a positive number for recent beats ────────────────────
  it('12: ageMs is a positive number proportional to the beat age', async () => {
    const TARGET_AGE_MS = 3_000;
    const beats = [mkBeat({ component: 'bridge', id: 'main', ageMs: TARGET_AGE_MS })];
    const { json } = await healthCheck({ repo: makeRepo(beats) });

    const { ageMs } = json.components[0];
    expect(typeof ageMs).toBe('number');
    // Allow ±500 ms slop for test-execution time
    expect(ageMs).toBeGreaterThanOrEqual(TARGET_AGE_MS - 500);
    expect(ageMs).toBeLessThan(TARGET_AGE_MS + 500);
  });

  // ── Bonus: bridgeCriticalMs is respected when customised ────────────────────
  it('13: custom bridgeCriticalMs=5000 makes bridge stale at 6s', async () => {
    const beats = [mkBeat({ component: 'bridge', id: 'main', ageMs: 6_000 })];
    const { statusCode, json } = await healthCheck({
      repo: makeRepo(beats),
      bridgeCriticalMs: 5_000,
    });

    expect(statusCode).toBe(503);
    expect(json.status).toBe('down');
  });

  it('14: custom bridgeCriticalMs=5000: bridge at 4s is still ok', async () => {
    const beats = [mkBeat({ component: 'bridge', id: 'main', ageMs: 4_000 })];
    const { statusCode, json } = await healthCheck({
      repo: makeRepo(beats),
      bridgeCriticalMs: 5_000,
    });

    expect(statusCode).toBe(200);
    expect(json.status).toBe('ok');
  });
});

// ─── /mcp/v1 route ────────────────────────────────────────────────────────────

/**
 * Spin up a server with an optional mcpServer mock and optional maxBodyBytes.
 * Returns { port, srv }.
 */
async function startMcpServer({ mcpServer = null, maxBodyBytes } = {}) {
  const opts = {
    config:   makeConfig({ mode: 'scp' }),
    vncProxy: makeMockVncProxy(),
    logger:   makeLogger(),
    mcpServer,
  };
  if (maxBodyBytes !== undefined) opts.maxBodyBytes = maxBodyBytes;
  const srv = new ScpHttpServer(opts);
  const { port } = await srv.start();
  return { port, srv };
}

describe('ScpHttpServer — POST /mcp/v1 with mcpServer = null', () => {
  it('POST /mcp/v1 → 404 when mcpServer is null', async () => {
    const { port, srv } = await startMcpServer({ mcpServer: null });
    try {
      const { statusCode, body } = await httpPost(port, '/mcp/v1', '{"method":"ping"}');
      expect(statusCode).toBe(404);
      expect(JSON.parse(body).error).toBe('not_found');
    } finally {
      await srv.stop();
    }
  });
});

describe('ScpHttpServer — POST /mcp/v1 with fake mcpServer', () => {
  it('valid body → 200 and handle() called with {token, body}', async () => {
    const fakeHandle = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: { jsonrpc: '2.0', id: 1, result: 'pong' },
    });
    const { port, srv } = await startMcpServer({ mcpServer: { handle: fakeHandle } });
    try {
      const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
      const { statusCode, body } = await httpPost(port, '/mcp/v1', payload, {
        'mcp-token': 'tok-abc',
      });
      expect(statusCode).toBe(200);
      const json = JSON.parse(body);
      expect(json.result).toBe('pong');
      expect(fakeHandle).toHaveBeenCalledOnce();
      const callArg = fakeHandle.mock.calls[0][0];
      expect(callArg.token).toBe('tok-abc');
      expect(callArg.body).toMatchObject({ method: 'ping' });
    } finally {
      await srv.stop();
    }
  });

  it('non-JSON body → 400 + parse-error envelope', async () => {
    const fakeHandle = vi.fn();
    const { port, srv } = await startMcpServer({ mcpServer: { handle: fakeHandle } });
    try {
      const { statusCode, body } = await httpPost(port, '/mcp/v1', 'this is not json');
      expect(statusCode).toBe(400);
      const json = JSON.parse(body);
      expect(json.jsonrpc).toBe('2.0');
      expect(json.error.code).toBe(-32700);
      expect(fakeHandle).not.toHaveBeenCalled();
    } finally {
      await srv.stop();
    }
  });

  it('body > maxBodyBytes → 413 + code -32600', async () => {
    const fakeHandle = vi.fn();
    const { port, srv } = await startMcpServer({
      mcpServer: { handle: fakeHandle },
      maxBodyBytes: 10,
    });
    try {
      const { statusCode, body } = await httpPost(port, '/mcp/v1', '{"method":"this-is-long-enough"}');
      expect(statusCode).toBe(413);
      const json = JSON.parse(body);
      expect(json.error.code).toBe(-32600);
      expect(fakeHandle).not.toHaveBeenCalled();
    } finally {
      await srv.stop();
    }
  });

  it('no MCP-Token header → token forwarded as null, handle() still called', async () => {
    const fakeHandle = vi.fn().mockResolvedValue({
      statusCode: 200,
      body: { ok: true },
    });
    const { port, srv } = await startMcpServer({ mcpServer: { handle: fakeHandle } });
    try {
      await httpPost(port, '/mcp/v1', '{"method":"ping"}');
      expect(fakeHandle).toHaveBeenCalledOnce();
      expect(fakeHandle.mock.calls[0][0].token).toBeNull();
    } finally {
      await srv.stop();
    }
  });

  it('MCP-Token header present → that string is forwarded', async () => {
    const fakeHandle = vi.fn().mockResolvedValue({ statusCode: 200, body: {} });
    const { port, srv } = await startMcpServer({ mcpServer: { handle: fakeHandle } });
    try {
      await httpPost(port, '/mcp/v1', '{"method":"ping"}', { 'mcp-token': 'my-token-xyz' });
      expect(fakeHandle.mock.calls[0][0].token).toBe('my-token-xyz');
    } finally {
      await srv.stop();
    }
  });

  it('GET /mcp/v1 when mcpServer present → 405 with Allow: POST header', async () => {
    const { port, srv } = await startMcpServer({
      mcpServer: { handle: vi.fn() },
    });
    try {
      const { statusCode, headers } = await httpGet(port, '/mcp/v1');
      expect(statusCode).toBe(405);
      expect(headers['allow']).toBe('POST');
    } finally {
      await srv.stop();
    }
  });

  it('handle() returns 401 + body envelope → response is 401 with that body', async () => {
    const errBody = { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } };
    const fakeHandle = vi.fn().mockResolvedValue({ statusCode: 401, body: errBody });
    const { port, srv } = await startMcpServer({ mcpServer: { handle: fakeHandle } });
    try {
      const { statusCode, body } = await httpPost(port, '/mcp/v1', '{"method":"ping"}');
      expect(statusCode).toBe(401);
      expect(JSON.parse(body)).toMatchObject(errBody);
    } finally {
      await srv.stop();
    }
  });

  it('handle() returns {statusCode:202, body:null} → 202 empty response', async () => {
    const fakeHandle = vi.fn().mockResolvedValue({ statusCode: 202, body: null });
    const { port, srv } = await startMcpServer({ mcpServer: { handle: fakeHandle } });
    try {
      const { statusCode, body } = await httpPost(port, '/mcp/v1', '{"method":"ping"}');
      expect(statusCode).toBe(202);
      expect(body).toBe('');
    } finally {
      await srv.stop();
    }
  });

  it('handle() throws → 500 via existing error handler', async () => {
    const fakeHandle = vi.fn().mockRejectedValue(new Error('mcp exploded'));
    const { port, srv } = await startMcpServer({ mcpServer: { handle: fakeHandle } });
    try {
      const { statusCode, body } = await httpPost(port, '/mcp/v1', '{"method":"ping"}');
      expect(statusCode).toBe(500);
      expect(JSON.parse(body).error).toBe('internal');
    } finally {
      await srv.stop();
    }
  });
});

// ─── Wave B2 — rate-limit 429 sets Retry-After ─────────────────────────────────

describe('ScpHttpServer — rate-limit Retry-After header (Wave B2)', () => {
  it('mcpServer.handle returning statusCode=429 + retryAfterMs=2000 → sets Retry-After: 2', async () => {
    const fakeHandle = vi.fn().mockResolvedValue({
      statusCode:   429,
      retryAfterMs: 2000,
      body: {
        jsonrpc: '2.0', id: null,
        error: { code: -32029, message: 'Too many requests', data: { scope: 'token' } },
      },
    });
    const { port, srv } = await startMcpServer({ mcpServer: { handle: fakeHandle } });
    try {
      const { statusCode, headers } = await httpPost(port, '/mcp/v1', '{"jsonrpc":"2.0","id":1,"method":"ping"}');
      expect(statusCode).toBe(429);
      expect(headers['retry-after']).toBe('2');
    } finally {
      await srv.stop();
    }
  });

  it('mcpServer.handle returning statusCode=429 + retryAfterMs=1 → Retry-After: 1 (ceiling)', async () => {
    const fakeHandle = vi.fn().mockResolvedValue({
      statusCode:   429,
      retryAfterMs: 1,
      body: { jsonrpc: '2.0', id: null, error: { code: -32029, message: 'Too many requests' } },
    });
    const { port, srv } = await startMcpServer({ mcpServer: { handle: fakeHandle } });
    try {
      const { statusCode, headers } = await httpPost(port, '/mcp/v1', '{"jsonrpc":"2.0","id":1,"method":"ping"}');
      expect(statusCode).toBe(429);
      expect(headers['retry-after']).toBe('1');
    } finally {
      await srv.stop();
    }
  });
});

// ─── Wave B2 — DCR endpoint ─────────────────────────────────────────────────────

async function startDcrServer({ dcrHandler = null } = {}) {
  const srv = new ScpHttpServer({
    config:     makeConfig({ mode: 'scp' }),
    vncProxy:   makeMockVncProxy(),
    logger:     makeLogger(),
    dcrHandler,
  });
  const { port } = await srv.start();
  return { port, srv };
}

describe('ScpHttpServer — POST /mcp/v1/register DCR (Wave B2)', () => {
  it('dcrHandler null → 404 not_found', async () => {
    const { port, srv } = await startDcrServer({ dcrHandler: null });
    try {
      const { statusCode, body } = await httpPost(port, '/mcp/v1/register', '{}');
      expect(statusCode).toBe(404);
      expect(JSON.parse(body).error).toBe('not_found');
    } finally {
      await srv.stop();
    }
  });

  it('dcrHandler.enabled = false → 404 not_found', async () => {
    const { port, srv } = await startDcrServer({ dcrHandler: { enabled: false, register: async () => ({ statusCode: 404, body: { error: 'not_found' } }) } });
    try {
      const { statusCode, body } = await httpPost(port, '/mcp/v1/register', '{}');
      expect(statusCode).toBe(404);
      expect(JSON.parse(body).error).toBe('not_found');
    } finally {
      await srv.stop();
    }
  });

  it('dcrHandler.enabled=true + register() returns 201 → 201 response body forwarded', async () => {
    const regResponse = {
      client_id:                'abc123',
      client_secret:            'raw-token-xyz',
      client_secret_expires_at: 9999999999,
    };
    const dcrHandler = {
      enabled:  true,
      register: vi.fn().mockResolvedValue({ statusCode: 201, body: regResponse }),
    };
    const { port, srv } = await startDcrServer({ dcrHandler });
    try {
      const { statusCode, body } = await httpPost(port, '/mcp/v1/register',
        JSON.stringify({ client_name: 'TestClient', registration_secret: 's3cr3t', synaps_user_id: 'u1' }),
      );
      expect(statusCode).toBe(201);
      const parsed = JSON.parse(body);
      expect(parsed.client_id).toBe('abc123');
      expect(parsed.client_secret).toBe('raw-token-xyz');
      expect(dcrHandler.register).toHaveBeenCalledTimes(1);
    } finally {
      await srv.stop();
    }
  });

  it('dcrHandler.enabled=true + register() returns 401 (wrong secret) → 401', async () => {
    const dcrHandler = {
      enabled:  true,
      register: vi.fn().mockResolvedValue({ statusCode: 401, body: { error: 'invalid_client' } }),
    };
    const { port, srv } = await startDcrServer({ dcrHandler });
    try {
      const { statusCode, body } = await httpPost(port, '/mcp/v1/register',
        JSON.stringify({ registration_secret: 'wrong', synaps_user_id: 'u1' }),
      );
      expect(statusCode).toBe(401);
      expect(JSON.parse(body).error).toBe('invalid_client');
    } finally {
      await srv.stop();
    }
  });
});

// ─── Phase 9 Wave C Track 6 — /metrics endpoint ───────────────────────────────

describe('ScpHttpServer — /metrics endpoint (Phase 9 C3 Track 6)', () => {
  /** Start a server with optional metricsRegistry + metricsConfig. */
  async function startMetricsServer({ metricsRegistry = null, metricsConfig = null } = {}) {
    const srv = new ScpHttpServer({
      config:     makeConfig({ mode: 'scp' }),
      vncProxy:   makeMockVncProxy(),
      logger:     makeLogger(),
      metricsRegistry,
      metricsConfig,
    });
    const { port } = await srv.start();
    return { port, srv };
  }

  it('/metrics returns 404 when metricsRegistry is null', async () => {
    const { port, srv } = await startMetricsServer({ metricsRegistry: null });
    try {
      const { statusCode } = await httpGet(port, '/metrics');
      expect(statusCode).toBe(404);
    } finally {
      await srv.stop();
    }
  });

  it('/metrics returns 200 with Prometheus text when registry provided and request from 127.0.0.1', async () => {
    // Build a simple fake MetricsRegistry that returns known text.
    const fakeRegistry = {
      render: vi.fn().mockReturnValue('# HELP test_gauge A test gauge\n# TYPE test_gauge gauge\ntest_gauge 1\n'),
    };
    const { port, srv } = await startMetricsServer({
      metricsRegistry: fakeRegistry,
      metricsConfig:   { enabled: true, path: '/metrics', bind: '127.0.0.1' },
    });
    try {
      const { statusCode, headers, body } = await httpGet(port, '/metrics');
      expect(statusCode).toBe(200);
      expect(headers['content-type']).toMatch(/text\/plain/);
      expect(headers['content-type']).toMatch(/0\.0\.4/);
      expect(body).toContain('test_gauge');
      expect(fakeRegistry.render).toHaveBeenCalledOnce();
    } finally {
      await srv.stop();
    }
  });

  it('/metrics returns 403 when request is from a non-localhost address', async () => {
    // We cannot change the real socket's remoteAddress in tests (always 127.0.0.1).
    // Instead, test the guard logic by using a registry + metricsConfig where
    // bind = '10.0.0.5' and send from 127.0.0.1.  Since 127.0.0.1 IS in the
    // LOCALHOST_ADDRS set, this request would still get 200 via the localhost bypass.
    // To properly test the 403 path we exercise the request handler directly.
    //
    // Strategy: start the server, grab its Node.js http.Server listener, then
    // invoke it with a mock req whose socket.remoteAddress = '10.0.0.5'.
    const fakeRegistry = { render: vi.fn().mockReturnValue('# HELP x x\n') };
    const metricsConfig = { enabled: true, path: '/metrics', bind: '127.0.0.1' };
    const srv = new ScpHttpServer({
      config:          makeConfig({ mode: 'scp' }),
      vncProxy:        makeMockVncProxy(),
      logger:          makeLogger(),
      metricsRegistry: fakeRegistry,
      metricsConfig,
    });
    await srv.start();

    try {
      // Build a minimal mock req / res.
      const reqMock = {
        url:     '/metrics',
        method:  'GET',
        headers: {},
        socket:  { remoteAddress: '10.0.0.5' },
        on:      vi.fn(),
        resume:  vi.fn(),
      };
      let capturedStatus = null;
      let capturedBody   = '';
      const resMock = {
        headersSent: false,
        writeHead(status) { capturedStatus = status; this.headersSent = true; },
        end(body) { capturedBody = body ?? ''; },
        setHeader() {},
      };

      // Get the 'request' listener registered by start() and call it.
      const listeners = srv._server.listeners('request');
      expect(listeners.length).toBeGreaterThan(0);
      listeners[0](reqMock, resMock);
      // Wait for the async IIFE to resolve.
      await new Promise((r) => setTimeout(r, 20));

      expect(capturedStatus).toBe(403);
    } finally {
      await srv.stop();
    }
  });
});

// ─── oauthServer wiring (Phase 9 Wave C) ─────────────────────────────────────

describe('ScpHttpServer — oauthServer wiring (Phase 9 Wave C)', () => {
  it('with oauthServer = null, OAuth path returns 404 (Phase 8 baseline unchanged)', async () => {
    const srv = new ScpHttpServer({
      config:   makeConfig(),
      vncProxy: makeMockVncProxy(),
      logger:   makeLogger(),
      // oauthServer intentionally omitted / null
    });
    await srv.start();
    const { port } = await srv.start().catch(() => ({ port: srv._server.address().port }));
    const addr = srv._server.address().port;
    try {
      const { statusCode } = await httpGet(addr, '/.well-known/oauth-authorization-server');
      expect(statusCode).toBe(404);
    } finally {
      await srv.stop();
    }
  });

  it('with mock oauthServer whose .handle returns true, request is handled', async () => {
    const mockOauthServer = {
      handle: vi.fn(async (_req, res, _pathname, _query) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stub: 'oauth' }));
        return true;
      }),
    };

    const srv = new ScpHttpServer({
      config:      makeConfig(),
      vncProxy:    makeMockVncProxy(),
      logger:      makeLogger(),
      oauthServer: mockOauthServer,
    });
    await srv.start();
    const addr = srv._server.address().port;
    try {
      const { statusCode, body } = await httpGet(addr, '/.well-known/oauth-authorization-server');
      expect(statusCode).toBe(200);
      expect(JSON.parse(body)).toMatchObject({ stub: 'oauth' });
      expect(mockOauthServer.handle).toHaveBeenCalled();
    } finally {
      await srv.stop();
    }
  });

  it('metadata path works alongside existing /health route', async () => {
    const mockOauthServer = {
      handle: vi.fn(async (_req, res, pathname, _query) => {
        if (pathname === '/.well-known/oauth-authorization-server') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ issuer: 'http://localhost:18080' }));
          return true;
        }
        return false;
      }),
    };

    const srv = new ScpHttpServer({
      config:      makeConfig(),
      vncProxy:    makeMockVncProxy(),
      logger:      makeLogger(),
      oauthServer: mockOauthServer,
    });
    await srv.start();
    const addr = srv._server.address().port;
    try {
      const healthRes = await httpGet(addr, '/health');
      expect(healthRes.statusCode).toBe(200);

      const oauthRes = await httpGet(addr, '/.well-known/oauth-authorization-server');
      expect(oauthRes.statusCode).toBe(200);
      expect(JSON.parse(oauthRes.body).issuer).toBe('http://localhost:18080');
    } finally {
      await srv.stop();
    }
  });

  it('POST /mcp/v1/token with valid body passes through to oauthServer', async () => {
    const mockOauthServer = {
      handle: vi.fn(async (req, res, pathname) => {
        if (pathname === '/mcp/v1/token' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'test-token', token_type: 'bearer', expires_in: 3600, scope: '' }));
          return true;
        }
        return false;
      }),
    };

    const srv = new ScpHttpServer({
      config:      makeConfig(),
      vncProxy:    makeMockVncProxy(),
      logger:      makeLogger(),
      oauthServer: mockOauthServer,
    });
    await srv.start();
    const addr = srv._server.address().port;
    try {
      const body = 'grant_type=authorization_code&code=abc&code_verifier=v&client_id=c&redirect_uri=https%3A%2F%2Fx.com';
      const { statusCode, body: respBody } = await httpPost(addr, '/mcp/v1/token', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(statusCode).toBe(200);
      expect(JSON.parse(respBody)).toMatchObject({ token_type: 'bearer' });
      expect(mockOauthServer.handle).toHaveBeenCalled();
    } finally {
      await srv.stop();
    }
  });
});
