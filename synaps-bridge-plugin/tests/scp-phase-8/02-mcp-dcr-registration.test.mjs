/**
 * @file tests/scp-phase-8/02-mcp-dcr-registration.test.mjs
 *
 * Acceptance test — Track 4: OAuth2 Dynamic Client Registration (RFC 7591)
 *
 * Tests:
 *  1. POST /mcp/v1/register with valid registration_secret + synaps_user_id → 201 + client_secret.
 *  2. POST /mcp/v1/register with wrong registration_secret → 401.
 *  3. POST /mcp/v1/register with missing registration_secret → 401.
 *  4. POST /mcp/v1/register when DCR disabled (no secret configured) → 404.
 *  5. POST /mcp/v1/register with malformed JSON → 400.
 *  6. GET  /mcp/v1/register → 405 Method Not Allowed.
 *  7. Issued token is stored in tokenRepo (verifies repo.create was called).
 *  8. Response body has required RFC 7591 fields (client_id, client_secret, etc.).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { McpDcrHandler } from '../../bridge/core/mcp/mcp-dcr.js';
import { ScpHttpServer } from '../../bridge/core/scp-http-server.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const REG_SECRET = 'super-secret-registration-token';

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

/**
 * Make a fake tokenRepo that records create() calls.
 */
function makeFakeTokenRepo() {
  const created = [];
  return {
    created,
    create: vi.fn(async (row) => {
      created.push(row);
      return { _id: 'fake-mongo-id', ...row };
    }),
  };
}

/** Sends a raw request to a server and returns { statusCode, headers, body }. */
function req({ port, path, method = 'POST', body = null, extraHeaders = {} }) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8') : null;
    const headers = buf
      ? { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...extraHeaders }
      : extraHeaders;

    const r = http.request(
      { hostname: '127.0.0.1', port, path, method, headers },
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
    r.on('error', reject);
    if (buf) r.write(buf);
    r.end();
  });
}

// ─── Server setup ─────────────────────────────────────────────────────────────

let enabledSrv, enabledPort, tokenRepo;
let disabledSrv, disabledPort;

beforeAll(async () => {
  // --- DCR-enabled server ---
  tokenRepo = makeFakeTokenRepo();
  const dcrHandler = new McpDcrHandler({
    registrationSecret: REG_SECRET,
    tokenRepo,
    logger: silent,
  });

  enabledSrv = new ScpHttpServer({
    config: makeConfig(), vncProxy: makeVncProxy(),
    dcrHandler, logger: silent,
  });
  const r1 = await enabledSrv.start();
  enabledPort = r1.port;

  // --- DCR-disabled server (no registration_secret → disabled) ---
  const disabledDcr = new McpDcrHandler({
    registrationSecret: '',   // empty → disabled
    tokenRepo,
    logger: silent,
  });
  disabledSrv = new ScpHttpServer({
    config: makeConfig(), vncProxy: makeVncProxy(),
    dcrHandler: disabledDcr, logger: silent,
  });
  const r2 = await disabledSrv.start();
  disabledPort = r2.port;
});

afterAll(async () => {
  await enabledSrv.stop();
  await disabledSrv.stop();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /mcp/v1/register — DCR enabled', () => {
  it('valid registration_secret + synaps_user_id → 201 + RFC 7591 body', async () => {
    const { statusCode, body } = await req({
      port: enabledPort, path: '/mcp/v1/register',
      body: {
        client_name:         'Claude Desktop',
        redirect_uris:       ['http://localhost'],
        grant_types:         ['client_credentials'],
        synaps_user_id:      'user-42',
        registration_secret: REG_SECRET,
      },
    });

    expect(statusCode).toBe(201);
    expect(typeof body.client_id).toBe('string');
    expect(typeof body.client_secret).toBe('string');
    expect(body.client_secret.length).toBeGreaterThan(10);
    expect(typeof body.client_secret_expires_at).toBe('number');
    expect(body.grant_types).toEqual(['client_credentials']);
  });

  it('issued client_secret is stored in tokenRepo (repo.create called once)', async () => {
    tokenRepo.create.mockClear();

    await req({
      port: enabledPort, path: '/mcp/v1/register',
      body: { synaps_user_id: 'user-99', registration_secret: REG_SECRET },
    });

    expect(tokenRepo.create).toHaveBeenCalledTimes(1);
    const callArg = tokenRepo.create.mock.calls[0][0];
    expect(typeof callArg.token_hash).toBe('string');
    expect(callArg.synaps_user_id).toBe('user-99');
  });

  it('wrong registration_secret → 401 invalid_client', async () => {
    const { statusCode, body } = await req({
      port: enabledPort, path: '/mcp/v1/register',
      body: { synaps_user_id: 'user-1', registration_secret: 'WRONG' },
    });
    expect(statusCode).toBe(401);
    expect(body.error).toBe('invalid_client');
  });

  it('missing registration_secret field → 401 invalid_client', async () => {
    const { statusCode, body } = await req({
      port: enabledPort, path: '/mcp/v1/register',
      body: { synaps_user_id: 'user-1' }, // no registration_secret
    });
    expect(statusCode).toBe(401);
    expect(body.error).toBe('invalid_client');
  });

  it('missing synaps_user_id → 400 invalid_request', async () => {
    const { statusCode, body } = await req({
      port: enabledPort, path: '/mcp/v1/register',
      body: { registration_secret: REG_SECRET }, // no user id
    });
    expect(statusCode).toBe(400);
    expect(body.error).toBe('invalid_request');
  });

  it('malformed JSON body → 400', async () => {
    const { statusCode } = await req({
      port: enabledPort, path: '/mcp/v1/register',
      body: 'this is not json',
    });
    expect(statusCode).toBe(400);
  });

  it('GET /mcp/v1/register → 405 Method Not Allowed', async () => {
    const { statusCode, headers } = await req({
      port: enabledPort, path: '/mcp/v1/register', method: 'GET',
    });
    expect(statusCode).toBe(405);
    expect(headers.allow).toBe('POST');
  });
});

describe('POST /mcp/v1/register — DCR disabled', () => {
  it('registration_secret empty → endpoint disabled → 404', async () => {
    const { statusCode, body } = await req({
      port: disabledPort, path: '/mcp/v1/register',
      body: { synaps_user_id: 'user-1', registration_secret: REG_SECRET },
    });
    expect(statusCode).toBe(404);
    expect(body.error).toBe('not_found');
  });
});
