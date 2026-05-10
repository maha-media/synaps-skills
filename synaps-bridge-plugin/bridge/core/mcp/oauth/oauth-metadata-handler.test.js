/**
 * @file bridge/core/mcp/oauth/oauth-metadata-handler.test.js
 *
 * Tests for OauthMetadataHandler.
 *
 * Uses Node's http module to make real HTTP requests via a local test server,
 * mirroring the scp-http-server test pattern.
 *
 * Spec reference: Phase 9 brief § Track 3 — Metadata handler; 4 tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { OauthMetadataHandler } from './oauth-metadata-handler.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
  return {
    issuer:         'http://localhost:18080',
    authorize_path: '/mcp/v1/authorize',
    token_path:     '/mcp/v1/token',
    ...overrides,
  };
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get(
      { hostname: '127.0.0.1', port, path },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode, headers: res.headers, body }),
        );
      },
    ).on('error', reject);
  });
}

// ── test server ───────────────────────────────────────────────────────────────

let server;
let port;
let handler;

beforeAll(async () => {
  handler = new OauthMetadataHandler({ config: makeConfig() });

  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const handled  = handler.handle(req, res, pathname);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
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

afterAll(() => new Promise((resolve) => server.close(resolve)));

// ── tests ─────────────────────────────────────────────────────────────────────

describe('OauthMetadataHandler', () => {
  it('GET /.well-known/oauth-authorization-server → 200 with RFC 8414 fields', async () => {
    const { statusCode, body, headers } = await httpGet(
      port,
      '/.well-known/oauth-authorization-server',
    );
    expect(statusCode).toBe(200);
    const json = JSON.parse(body);
    expect(json.issuer).toBe('http://localhost:18080');
    expect(json.authorization_endpoint).toBe('http://localhost:18080/mcp/v1/authorize');
    expect(json.token_endpoint).toBe('http://localhost:18080/mcp/v1/token');
    expect(json.response_types_supported).toEqual(['code']);
    expect(json.grant_types_supported).toEqual(['authorization_code']);
    expect(json.code_challenge_methods_supported).toEqual(['S256']);
    expect(json.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(headers['content-type']).toContain('application/json');
  });

  it('GET /.well-known/oauth-protected-resource → 200 with RFC 9728 fields', async () => {
    const { statusCode, body, headers } = await httpGet(
      port,
      '/.well-known/oauth-protected-resource',
    );
    expect(statusCode).toBe(200);
    const json = JSON.parse(body);
    expect(json.resource).toBe('http://localhost:18080');
    expect(json.authorization_servers).toEqual(['http://localhost:18080']);
    expect(headers['content-type']).toContain('application/json');
  });

  it('non-matching path → returns false (test server returns 404)', async () => {
    const { statusCode } = await httpGet(port, '/.well-known/unknown');
    expect(statusCode).toBe(404);
  });

  it('Content-Type is application/json for both well-known endpoints', async () => {
    const r1 = await httpGet(port, '/.well-known/oauth-authorization-server');
    const r2 = await httpGet(port, '/.well-known/oauth-protected-resource');
    expect(r1.headers['content-type']).toContain('application/json');
    expect(r2.headers['content-type']).toContain('application/json');
  });
});
