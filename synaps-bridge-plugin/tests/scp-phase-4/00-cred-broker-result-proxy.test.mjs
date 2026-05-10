/**
 * @file tests/scp-phase-4/00-cred-broker-result-proxy.test.mjs
 *
 * Acceptance tests — CredBroker result-proxy end-to-end.
 *
 * Strategy
 * ────────
 * • MockInfisical — a real Node http.createServer returning canned
 *   `{ secret: { secretValue: 'GHP_FAKE_TOKEN_12345' } }` for any request.
 * • MockUpstream — a real Node http.createServer that echoes the incoming
 *   Authorization header and (for POST) the request body back as JSON:
 *   `{ received_authorization: '…', received_body: '…' }`.
 * • InfisicalClient is wired to MockInfisical (real HTTP, real fetch).
 * • CredBroker is wired to the real InfisicalClient and real fetch.
 * • A tmp file on disk holds the fake service token so InfisicalClient
 *   reads it the same way it would in production.
 *
 * Result-proxy guarantee
 * ───────────────────────
 * The token NEVER appears in the top-level result object's own properties
 * (outside of `body`, which is the proxied upstream response — the upstream
 * echo server is deliberately crafted to mirror back what the broker sent it,
 * so `body` *will* contain the token; that is the whole point of the test).
 * What must NOT happen is the token leaking into `status`, `headers`,
 * `cached`, or `fetchedAt`, and the broker must never surface a `token`,
 * `Authorization`, or `secret` *key* at the top level.
 *
 * Logger token-leak audit
 * ────────────────────────
 * We collect all logger call arguments.  The token string must not appear in
 * any logger call across the entire suite.
 *
 * Scenarios (6 tests)
 * ─────────────────────
 * 1. GET — upstream echo confirms Bearer token injected correctly.
 * 2. POST with body — body forwarded; echo confirms token + body.
 * 3. Caller-supplied Authorization header overridden by broker.
 * 4. Caller-supplied X-Foo header preserved.
 * 5. HTTP 500 from upstream → result.status === 500 (not a thrown error).
 * 6. Result-proxy: top-level result fields outside `body` are token-free.
 *
 * Constraints
 * ───────────
 * • ESM only (.mjs)
 * • No top-level await
 * • All servers / tmp files cleaned up in afterAll
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { InfisicalClient } from '../../bridge/core/cred-broker/infisical-client.js';
import { CredBroker }      from '../../bridge/core/cred-broker.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const FAKE_TOKEN   = 'GHP_FAKE_TOKEN_12345';
const SYNAPS_USER  = 'u_test_proxy';
const INSTITUTION  = 'inst_proxy_001';
const SECRET_KEY   = 'github.token';

// ─── Shared state ─────────────────────────────────────────────────────────────

let mockInfisical;
let mockUpstream;
let infisicalBaseUrl;
let upstreamBaseUrl;
let tokenFilePath;
let broker;

// Capture all logger args so we can audit for token leaks at the end.
const loggedArgs = [];

const capturingLogger = {
  info:  (...a) => { loggedArgs.push(['info',  ...a]); },
  warn:  (...a) => { loggedArgs.push(['warn',  ...a]); },
  error: (...a) => { loggedArgs.push(['error', ...a]); },
  debug: (...a) => { loggedArgs.push(['debug', ...a]); },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Start an http.Server on an ephemeral port, resolve when listening.
 * @param {http.RequestListener} handler
 * @returns {Promise<{ server: http.Server, url: string }>}
 */
function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/** Gracefully close an http.Server. */
function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Read the full request body as a string. */
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => resolve(buf));
  });
}

// ─── beforeAll / afterAll ─────────────────────────────────────────────────────

beforeAll(async () => {
  // 1. Write the fake service token to a tmp file.
  const tmpDir  = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-phase4-proxy-'));
  tokenFilePath = path.join(tmpDir, 'infisical-token');
  await fs.writeFile(tokenFilePath, FAKE_TOKEN + '\n', { mode: 0o600 });

  // 2. MockInfisical — returns canned secret for any GET /api/v3/secrets/raw.
  //    HEAD /api/status → 200 (for ping()).
  //    Everything else → 200 with the canned secret payload.
  const infisical = await startServer((req, res) => {
    if (req.method === 'HEAD' && req.url === '/api/status') {
      res.writeHead(200);
      res.end();
      return;
    }
    const body = JSON.stringify({ secret: { secretValue: FAKE_TOKEN } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  mockInfisical    = infisical.server;
  infisicalBaseUrl = infisical.url;

  // 3. MockUpstream — flexible echo server.
  //    GET/HEAD /echo-*          → echoes Authorization header.
  //    POST /echo-*              → echoes Authorization header + request body.
  //    GET  /status-500          → returns HTTP 500 with a JSON body.
  //    Everything else           → echoes Authorization + X-Foo header.
  const upstream = await startServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/status-500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'simulated server error' }));
      return;
    }

    const reqBody = (req.method === 'POST' || req.method === 'PUT')
      ? await readBody(req)
      : undefined;

    const payload = {
      received_authorization: req.headers['authorization'] ?? null,
      received_xfoo:          req.headers['x-foo']         ?? null,
    };
    if (reqBody !== undefined) {
      payload.received_body = reqBody;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  mockUpstream    = upstream.server;
  upstreamBaseUrl = upstream.url;

  // 4. Wire real InfisicalClient → real CredBroker (real globalThis.fetch).
  const infisicalClient = new InfisicalClient({
    baseUrl:   infisicalBaseUrl,
    tokenFile: tokenFilePath,
    logger:    capturingLogger,
  });

  broker = new CredBroker({
    infisicalClient,
    cacheTtlSecs: 300,
    logger:       capturingLogger,
  });
}, 15_000);

afterAll(async () => {
  await stopServer(mockInfisical);
  await stopServer(mockUpstream);
  try {
    const dir = path.dirname(tokenFilePath);
    await fs.rm(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CredBroker result-proxy — GET request', () => {
  it('upstream echo confirms the broker injected the correct Bearer token', async () => {
    const result = await broker.use({
      synapsUserId:  SYNAPS_USER,
      institutionId: INSTITUTION,
      key:           SECRET_KEY,
      request: {
        method: 'GET',
        url:    `${upstreamBaseUrl}/echo-get`,
      },
    });

    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.received_authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });
});

describe('CredBroker result-proxy — POST request with body', () => {
  it('forwards request body and injects correct Authorization on POST', async () => {
    const requestBody = JSON.stringify({ action: 'create', name: 'synaps' });

    const result = await broker.use({
      synapsUserId:  SYNAPS_USER,
      institutionId: INSTITUTION,
      key:           SECRET_KEY,
      request: {
        method: 'POST',
        url:    `${upstreamBaseUrl}/echo-post`,
        body:   requestBody,
      },
    });

    expect(result.status).toBe(200);
    const parsed = JSON.parse(result.body);
    // Token injected.
    expect(parsed.received_authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    // Body forwarded verbatim.
    expect(parsed.received_body).toBe(requestBody);
  });
});

describe('CredBroker result-proxy — caller Authorization header override', () => {
  it('caller-supplied Authorization is overridden; upstream sees the real token', async () => {
    const result = await broker.use({
      synapsUserId:  SYNAPS_USER,
      institutionId: INSTITUTION,
      key:           SECRET_KEY,
      request: {
        method:  'GET',
        url:     `${upstreamBaseUrl}/echo-override`,
        headers: { Authorization: 'Bearer CALLER_TOKEN_MUST_NOT_REACH_UPSTREAM' },
      },
    });

    const parsed = JSON.parse(result.body);
    // Upstream MUST see the real (injected) token.
    expect(parsed.received_authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    // Caller token must NOT reach upstream.
    expect(parsed.received_authorization).not.toContain('CALLER_TOKEN_MUST_NOT_REACH_UPSTREAM');
  });
});

describe('CredBroker result-proxy — custom headers preserved', () => {
  it('X-Foo header supplied by caller is preserved alongside injected Authorization', async () => {
    const result = await broker.use({
      synapsUserId:  SYNAPS_USER,
      institutionId: INSTITUTION,
      key:           SECRET_KEY,
      request: {
        method:  'GET',
        url:     `${upstreamBaseUrl}/echo-xfoo`,
        headers: { 'X-Foo': 'my-custom-value' },
      },
    });

    const parsed = JSON.parse(result.body);
    // Custom header preserved.
    expect(parsed.received_xfoo).toBe('my-custom-value');
    // Authorization still injected correctly.
    expect(parsed.received_authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });
});

describe('CredBroker result-proxy — upstream HTTP 500', () => {
  it('HTTP 500 from upstream surfaces as result.status === 500 (not a thrown error)', async () => {
    let thrown = null;
    let result = null;

    try {
      result = await broker.use({
        synapsUserId:  SYNAPS_USER,
        institutionId: INSTITUTION,
        key:           SECRET_KEY,
        request: {
          method: 'GET',
          url:    `${upstreamBaseUrl}/status-500`,
        },
      });
    } catch (err) {
      thrown = err;
    }

    // Must NOT throw — 5xx from upstream is not a broker-level error.
    expect(thrown).toBeNull();
    expect(result).not.toBeNull();
    expect(result.status).toBe(500);
    // Shape is still complete.
    expect(typeof result.body).toBe('string');
    expect(typeof result.cached).toBe('boolean');
  });
});

describe('CredBroker result-proxy — result-proxy guarantee', () => {
  it('top-level result keys outside body contain no token value; no token/authorization/secret key exposed', async () => {
    const result = await broker.use({
      synapsUserId:  'u_proxy_audit',
      institutionId: 'inst_proxy_audit',
      key:           SECRET_KEY,
      request: {
        method: 'GET',
        url:    `${upstreamBaseUrl}/echo-audit`,
      },
    });

    // Check that no top-level *key name* exposes the token.
    const topLevelKeys = Object.keys(result).map((k) => k.toLowerCase());
    expect(topLevelKeys).not.toContain('token');
    expect(topLevelKeys).not.toContain('authorization');
    expect(topLevelKeys).not.toContain('secret');
    expect(topLevelKeys).not.toContain('secretvalue');

    // Verify that non-body result fields do not contain the token string.
    // (result.body is the proxied response and legitimately echoes the token
    //  back — that is the whole point of the echo test.  We only check that
    //  the broker does not add its own secret-bearing fields.)
    const nonBodyFields = { ...result };
    delete nonBodyFields.body;
    const serialisedNonBody = JSON.stringify(nonBodyFields);
    expect(serialisedNonBody).not.toContain(FAKE_TOKEN);

    // Sanity: the broker did produce a valid result shape.
    expect(typeof result.status).toBe('number');
    expect(typeof result.headers).toBe('object');
    expect(typeof result.cached).toBe('boolean');
    expect(typeof result.fetchedAt).toBe('number');
    expect(result.fetchedAt).toBeGreaterThan(0);
  });

  it('logger never emits the raw token string across all calls in this suite', () => {
    // This assertion runs AFTER all other tests have executed because vitest
    // runs tests within a describe sequentially and this describe block is
    // last.  All logger calls captured by capturingLogger are checked here.
    const logText = JSON.stringify(loggedArgs);
    // Token must never appear in any log output.
    expect(logText).not.toContain(FAKE_TOKEN);
    // "Bearer GHP_…" form must also never appear.
    expect(logText).not.toContain(`Bearer ${FAKE_TOKEN}`);
  });
});
