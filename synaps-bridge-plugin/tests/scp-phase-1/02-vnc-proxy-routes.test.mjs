/**
 * @file tests/scp-phase-1/02-vnc-proxy-routes.test.mjs
 *
 * Boots a real ScpHttpServer on port 0 (OS-chosen free port) with a mock
 * VncProxy and hits routes via Node's built-in fetch().
 *
 * Covers (≥ 5 tests):
 *   1. /health — correct content-type + body shape
 *   2. /health — ts field is a parseable ISO date
 *   3. /vnc/<id> — calls vncProxy.middleware (middleware is invoked per request)
 *   4. /vnc/<id> — vncProxy middleware can produce its own response (200)
 *   5. Unknown route — 404 JSON { error: 'not_found' }
 *   6. Root path — 404 JSON
 *   7. Concurrent requests do not cross-contaminate (responses match paths)
 *   8. stop() releases the port (second server can bind it)
 *   9. Constructor: missing config throws TypeError
 *  10. Constructor: missing vncProxy throws TypeError
 *  11. /health with mode='bridge' returns mode='bridge' in body
 *  12. ScpHttpServer.listening reflects start/stop lifecycle
 *
 * Constraints:
 *   - ESM only (.mjs)
 *   - No top-level await
 *   - Uses built-in fetch (Node ≥ 18) — no axios, no got
 *   - vitest describe/it/expect/vi/beforeEach/afterEach/beforeAll/afterAll
 *   - No Docker, no MongoDB
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScpHttpServer } from '../../bridge/core/scp-http-server.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a NormalizedConfig stub with only the fields ScpHttpServer needs.
 */
function makeConfig({
  mode = 'scp',
  http_port = 0,
  bind = '127.0.0.1',
} = {}) {
  return {
    platform: { mode },
    web: {
      enabled:             true,
      http_port,
      bind,
      trust_proxy_header:  'x-synaps-user-id',
      allowed_origin:      '',
    },
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
 * Create a mock VncProxy object.
 *
 * @param {'next'|'handle'|'error'} behaviour
 *   - 'next'   → middleware calls next()  (falls through to 404)
 *   - 'handle' → middleware responds 200 with 'vnc-handled'
 *   - 'error'  → middleware responds 500
 */
function makeMockVncProxy({ behaviour = 'next' } = {}) {
  let middlewareImpl;
  if (behaviour === 'handle') {
    middlewareImpl = vi.fn((_req, res, _next) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('vnc-handled');
    });
  } else if (behaviour === 'error') {
    middlewareImpl = vi.fn((_req, res, _next) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_server_error' }));
    });
  } else {
    // 'next' — pass through
    middlewareImpl = vi.fn((_req, _res, next) => next());
  }

  return {
    middleware:         vi.fn(() => middlewareImpl),
    upgrade:            vi.fn(),
    _middlewareImpl:    middlewareImpl,
  };
}

/**
 * Convenience: fetch from 127.0.0.1:<port><path> and return { status, contentType, json, text }.
 */
async function httpFetch(port, path, { headers = {} } = {}) {
  const url = `http://127.0.0.1:${port}${path}`;
  const res  = await fetch(url, { headers });
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: res.status, contentType, text, json };
}

// ─── shared server lifecycle ──────────────────────────────────────────────────

/** Holds the server being tested in a given block so afterEach can clean up. */
let currentServer = null;

afterEach(async () => {
  if (currentServer) {
    await currentServer.stop().catch(() => {});
    currentServer = null;
  }
});

/**
 * Start a new ScpHttpServer and track it for cleanup.
 */
async function startServer({ mode = 'scp', proxyBehaviour = 'next' } = {}) {
  const proxy  = makeMockVncProxy({ behaviour: proxyBehaviour });
  const server = new ScpHttpServer({
    config:   makeConfig({ mode }),
    vncProxy: proxy,
    logger:   makeLogger(),
  });
  currentServer = server;
  const { port } = await server.start();
  return { server, proxy, port };
}

// ─── 1 & 2. /health ──────────────────────────────────────────────────────────

describe('ScpHttpServer routes — GET /health', () => {
  it('returns 200 with application/json content-type', async () => {
    const { port } = await startServer();
    const { status, contentType } = await httpFetch(port, '/health');

    expect(status).toBe(200);
    expect(contentType).toMatch(/application\/json/);
  });

  it('response body has { status, mode, ts } shape', async () => {
    const { port } = await startServer({ mode: 'scp' });
    const { json } = await httpFetch(port, '/health');

    expect(json).not.toBeNull();
    expect(json.status).toBe('ok');
    expect(json.mode).toBe('scp');
    expect(typeof json.ts).toBe('string');
  });

  it('ts is a parseable ISO 8601 date string', async () => {
    const { port } = await startServer();
    const { json } = await httpFetch(port, '/health');

    const parsed = new Date(json.ts);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(parsed.getTime()).toBeGreaterThan(0);
  });

  it('/health reflects mode="bridge" from config', async () => {
    const { port } = await startServer({ mode: 'bridge' });
    const { json } = await httpFetch(port, '/health');

    expect(json.mode).toBe('bridge');
    expect(json.status).toBe('ok');
  });

  it('/health?t=1 (with query string) still returns 200 ok', async () => {
    const { port } = await startServer();
    const { status, json } = await httpFetch(port, '/health?t=1');

    expect(status).toBe(200);
    expect(json.status).toBe('ok');
  });
});

// ─── 3 & 4. /vnc/<id> delegation ─────────────────────────────────────────────

describe('ScpHttpServer routes — /vnc/<id> proxy delegation', () => {
  it('vncProxy.middleware() is called exactly once when server starts', async () => {
    const { proxy } = await startServer({ proxyBehaviour: 'handle' });

    // middleware() (the factory) should be called once — the result is reused per req
    expect(proxy.middleware).toHaveBeenCalledTimes(1);
  });

  it('vncProxy middleware handler is invoked on /vnc/<id> request', async () => {
    const { proxy, port } = await startServer({ proxyBehaviour: 'handle' });

    await httpFetch(port, '/vnc/abc123', {
      headers: { 'x-synaps-user-id': 'user-1' },
    });

    expect(proxy._middlewareImpl).toHaveBeenCalled();
  });

  it('vncProxy middleware response (200) reaches the client', async () => {
    const { port } = await startServer({ proxyBehaviour: 'handle' });
    const { status, text } = await httpFetch(port, '/vnc/some-workspace-id', {
      headers: { 'x-synaps-user-id': 'user-test' },
    });

    expect(status).toBe(200);
    expect(text).toBe('vnc-handled');
  });

  it('/vnc/<id> falls through to 404 when middleware calls next()', async () => {
    // 'next' behaviour: middleware calls next() → server emits 404
    const { port } = await startServer({ proxyBehaviour: 'next' });
    const { status, json } = await httpFetch(port, '/vnc/abc', {
      headers: { 'x-synaps-user-id': 'user-1' },
    });

    expect(status).toBe(404);
    expect(json.error).toBe('not_found');
  });

  it('vncProxy middleware is invoked for nested path /vnc/<id>/some/path', async () => {
    const { proxy, port } = await startServer({ proxyBehaviour: 'handle' });

    await httpFetch(port, '/vnc/abc123/some/nested/path', {
      headers: { 'x-synaps-user-id': 'user-nested' },
    });

    expect(proxy._middlewareImpl).toHaveBeenCalled();
  });
});

// ─── 5 & 6. Unknown route → 404 ──────────────────────────────────────────────

describe('ScpHttpServer routes — unknown route returns 404 JSON', () => {
  it('returns 404 JSON { error: "not_found" } for an unknown path', async () => {
    const { port } = await startServer();
    const { status, contentType, json } = await httpFetch(port, '/no/such/route');

    expect(status).toBe(404);
    expect(contentType).toMatch(/application\/json/);
    expect(json.error).toBe('not_found');
  });

  it('returns 404 JSON for the root path "/"', async () => {
    const { port } = await startServer();
    const { status, json } = await httpFetch(port, '/');

    expect(status).toBe(404);
    expect(json.error).toBe('not_found');
  });

  it('returns 404 JSON for /api/v1/unknown', async () => {
    const { port } = await startServer();
    const { status, json } = await httpFetch(port, '/api/v1/unknown');

    expect(status).toBe(404);
    expect(json.error).toBe('not_found');
  });
});

// ─── 7. Concurrent requests ───────────────────────────────────────────────────

describe('ScpHttpServer routes — concurrent requests', () => {
  it('handles concurrent /health requests without cross-contamination', async () => {
    const { port } = await startServer({ mode: 'scp' });

    // Fire 5 requests concurrently
    const results = await Promise.all(
      Array.from({ length: 5 }, () => httpFetch(port, '/health')),
    );

    for (const { status, json } of results) {
      expect(status).toBe(200);
      expect(json.status).toBe('ok');
      expect(json.mode).toBe('scp');
    }
  });

  it('handles concurrent mixed-route requests independently', async () => {
    const { port } = await startServer({ proxyBehaviour: 'handle' });

    const [healthResult, unknownResult, vncResult] = await Promise.all([
      httpFetch(port, '/health'),
      httpFetch(port, '/no/such/path'),
      httpFetch(port, '/vnc/ws-123', { headers: { 'x-synaps-user-id': 'u1' } }),
    ]);

    expect(healthResult.status).toBe(200);
    expect(healthResult.json.status).toBe('ok');

    expect(unknownResult.status).toBe(404);
    expect(unknownResult.json.error).toBe('not_found');

    expect(vncResult.status).toBe(200);
    expect(vncResult.text).toBe('vnc-handled');
  });
});

// ─── 8. stop() releases the port ─────────────────────────────────────────────

describe('ScpHttpServer lifecycle — stop() releases port', () => {
  it('a new server can start on the same port after stop()', async () => {
    // Start and stop first server — record port
    const proxy1  = makeMockVncProxy();
    const server1 = new ScpHttpServer({
      config:   makeConfig(),
      vncProxy: proxy1,
      logger:   makeLogger(),
    });
    const { port } = await server1.start();
    await server1.stop();

    // Start a SECOND server requesting the same explicit port
    const proxy2  = makeMockVncProxy();
    const server2 = new ScpHttpServer({
      config:   makeConfig({ http_port: port }),
      vncProxy: proxy2,
      logger:   makeLogger(),
    });
    currentServer = server2; // track for cleanup

    await expect(server2.start()).resolves.toMatchObject({ port });
    const { status } = await httpFetch(port, '/health');
    expect(status).toBe(200);
  });
});

// ─── 9 & 10. Constructor validation ──────────────────────────────────────────

describe('ScpHttpServer constructor validation', () => {
  it('throws TypeError when config is missing', () => {
    expect(() => new ScpHttpServer({ vncProxy: makeMockVncProxy() })).toThrow(TypeError);
  });

  it('throws TypeError when vncProxy is missing', () => {
    expect(() => new ScpHttpServer({ config: makeConfig() })).toThrow(TypeError);
  });
});

// ─── 12. listening getter ─────────────────────────────────────────────────────

describe('ScpHttpServer.listening getter', () => {
  it('is false before start() and true after start()', async () => {
    const proxy  = makeMockVncProxy();
    const server = new ScpHttpServer({
      config:   makeConfig(),
      vncProxy: proxy,
      logger:   makeLogger(),
    });
    currentServer = server;

    expect(server.listening).toBe(false);
    await server.start();
    expect(server.listening).toBe(true);
  });

  it('is false after stop()', async () => {
    const { server } = await startServer();
    expect(server.listening).toBe(true);
    await server.stop();
    expect(server.listening).toBe(false);
    currentServer = null; // already stopped
  });
});
