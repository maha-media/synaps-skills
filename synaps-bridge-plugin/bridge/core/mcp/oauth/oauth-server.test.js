/**
 * @file bridge/core/mcp/oauth/oauth-server.test.js
 *
 * Tests for OauthServer.
 *
 * Uses real HTTP requests against a local test server, with stub handlers
 * that record calls and return predictable responses.
 *
 * Spec reference: Phase 9 brief § Track 3 — OAuth server dispatcher; 8 tests.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { OauthServer } from './oauth-server.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
  return {
    issuer:         'http://localhost:18080',
    authorize_path: '/mcp/v1/authorize',
    token_path:     '/mcp/v1/token',
    max_body_bytes: 16_384,
    ...overrides,
  };
}

/** Stub metadata handler. */
function makeMetaHandler() {
  return {
    handle: vi.fn((req, res, pathname) => {
      if (
        pathname === '/.well-known/oauth-authorization-server' ||
        pathname === '/.well-known/oauth-protected-resource'
      ) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stub: 'metadata' }));
        return true;
      }
      return false;
    }),
  };
}

/** Stub authorize handler. */
function makeAuthHandler() {
  return {
    handleGet:  vi.fn(async (_req, res, _q) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>consent</html>');
    }),
    handlePost: vi.fn(async (_req, res, _form) => {
      res.writeHead(302, { Location: 'http://localhost:3000/callback?code=abc' });
      res.end();
    }),
  };
}

/** Stub token handler. */
function makeTokenHandler() {
  return {
    handle: vi.fn(async (_req, res, _body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'tok', token_type: 'bearer', expires_in: 3600, scope: '' }));
    }),
  };
}

function httpRequest(port, method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const body    = opts.body ?? null;
    const headers = { ...(opts.headers || {}) };
    if (body) {
      headers['Content-Type']   = headers['Content-Type'] ?? 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode, headers: res.headers, body: data }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── test server ───────────────────────────────────────────────────────────────

let server;
let port;
let oauthServer;
let authorizeHandler;
let tokenHandler;
let metadataHandler;

beforeAll(async () => {
  authorizeHandler = makeAuthHandler();
  tokenHandler     = makeTokenHandler();
  metadataHandler  = makeMetaHandler();

  oauthServer = new OauthServer({
    config:           makeConfig(),
    authorizeHandler,
    tokenHandler,
    metadataHandler,
  });

  server = http.createServer((req, res) => {
    (async () => {
      const parsed   = new URL(req.url, 'http://x');
      const pathname = parsed.pathname;
      const query    = parsed.searchParams;
      const handled  = await oauthServer.handle(req, res, pathname, query);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      }
    })().catch((err) => {
      if (!res.headersSent) { res.writeHead(500); res.end(err.message); }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      port = server.address().port;
      resolve();
    });
  });
});

afterAll(() => new Promise((r) => server.close(r)));

// ── tests ─────────────────────────────────────────────────────────────────────

describe('OauthServer.handle()', () => {
  it('GET /.well-known/oauth-authorization-server → metadata handler called, 200', async () => {
    const { statusCode, body } = await httpRequest(
      port, 'GET', '/.well-known/oauth-authorization-server',
    );
    expect(statusCode).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ stub: 'metadata' });
    expect(metadataHandler.handle).toHaveBeenCalled();
  });

  it('GET /.well-known/oauth-protected-resource → metadata handler, 200', async () => {
    const { statusCode } = await httpRequest(
      port, 'GET', '/.well-known/oauth-protected-resource',
    );
    expect(statusCode).toBe(200);
  });

  it('GET /mcp/v1/authorize → authorizeHandler.handleGet called, 200', async () => {
    const { statusCode } = await httpRequest(
      port, 'GET', '/mcp/v1/authorize?response_type=code&client_id=x&redirect_uri=http://localhost:3000/&code_challenge=E9M&code_challenge_method=S256',
    );
    expect(statusCode).toBe(200);
    expect(authorizeHandler.handleGet).toHaveBeenCalled();
  });

  it('POST /mcp/v1/authorize → body parsed + authorizeHandler.handlePost called, 302', async () => {
    const { statusCode, headers } = await httpRequest(
      port, 'POST', '/mcp/v1/authorize',
      { body: 'csrf_token=tok&consent=allow&state=s1' },
    );
    expect(statusCode).toBe(302);
    expect(headers['location']).toContain('callback');
    expect(authorizeHandler.handlePost).toHaveBeenCalled();
  });

  it('GET /mcp/v1/token → 405 Method Not Allowed', async () => {
    const { statusCode } = await httpRequest(port, 'GET', '/mcp/v1/token');
    expect(statusCode).toBe(405);
  });

  it('POST /mcp/v1/token → tokenHandler.handle called, 200', async () => {
    const body = 'grant_type=authorization_code&code=x&code_verifier=v&client_id=c&redirect_uri=https%3A%2F%2Fx.com';
    const { statusCode, body: respBody } = await httpRequest(
      port, 'POST', '/mcp/v1/token', { body },
    );
    expect(statusCode).toBe(200);
    expect(JSON.parse(respBody)).toMatchObject({ token_type: 'bearer' });
    expect(tokenHandler.handle).toHaveBeenCalled();
  });

  it('body exceeding max_body_bytes → 413', async () => {
    const smallServer = new OauthServer({
      config: makeConfig({ max_body_bytes: 10 }), // tiny limit
      authorizeHandler: makeAuthHandler(),
      tokenHandler:     makeTokenHandler(),
      metadataHandler:  makeMetaHandler(),
    });

    const miniServer = http.createServer((req, res) => {
      (async () => {
        const parsed = new URL(req.url, 'http://x');
        const handled = await smallServer.handle(req, res, parsed.pathname, parsed.searchParams);
        if (!handled) { res.writeHead(404); res.end(); }
      })().catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
    });

    const p = await new Promise((resolve, reject) => {
      miniServer.once('error', reject);
      miniServer.listen(0, '127.0.0.1', () => {
        miniServer.removeListener('error', reject);
        resolve(miniServer.address().port);
      });
    });

    try {
      const { statusCode } = await httpRequest(
        p, 'POST', '/mcp/v1/token',
        { body: 'grant_type=authorization_code&code=averylongcodethatexceedsthebodylimit&code_verifier=v' },
      );
      expect(statusCode).toBe(413);
    } finally {
      await new Promise((r) => miniServer.close(r));
    }
  });

  it('unknown path → returns false (test server returns 404)', async () => {
    const { statusCode } = await httpRequest(port, 'GET', '/mcp/v1/unknown-endpoint');
    expect(statusCode).toBe(404);
  });
});
