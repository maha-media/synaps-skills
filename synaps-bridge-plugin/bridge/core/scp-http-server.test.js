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
