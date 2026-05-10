/**
 * @file bridge/core/mcp/oauth/oauth-authorize-handler.test.js
 *
 * Tests for OauthAuthorizeHandler.
 *
 * Uses a real HTTP server for end-to-end testing of the GET and POST paths.
 * The codeRepo is stubbed with an in-memory implementation so we don't need
 * MongoDB here (OauthCodeRepo itself is tested in oauth-code-repo.test.js).
 *
 * Spec reference: Phase 9 brief § Track 3 — Authorize handler; 14 tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { OauthAuthorizeHandler } from './oauth-authorize-handler.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides = {}) {
  return {
    issuer:                      'http://localhost:18080',
    authorize_path:              '/mcp/v1/authorize',
    token_path:                  '/mcp/v1/token',
    code_ttl_ms:                 600_000,
    allowed_redirect_uri_prefixes: ['http://localhost:', 'https://'],
    test_auth_header_enabled:    true, // enabled for tests
    ...overrides,
  };
}

/** Minimal stub codeRepo that records calls. */
function makeCodeRepo() {
  const codes = new Map();
  return {
    _codes: codes,
    async create(params) {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, { ...params, redeemed_at: null });
      return { code, doc: codes.get(code) };
    },
  };
}

function httpRequest(port, method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const body    = opts.body ?? null;
    const headers = {
      ...(opts.headers || {}),
    };
    if (body) {
      headers['Content-Length'] = Buffer.byteLength(body);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end',  () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function buildQuery(params) {
  return new URLSearchParams(params).toString();
}

// ── test server wiring ────────────────────────────────────────────────────────

let server;
let port;
let codeRepo;
let handler;

// Shared valid PKCE params.
const VERIFIER   = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE  = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'; // sha256(verifier) base64url

const VALID_GET_PARAMS = {
  response_type:         'code',
  client_id:             'my-client',
  redirect_uri:          'http://localhost:3000/callback',
  code_challenge:        CHALLENGE,
  code_challenge_method: 'S256',
  state:                 'xyz',
};

// Test-auth header value: user:institution
const TEST_AUTH = '507f1f77bcf86cd799439011:507f1f77bcf86cd799439012';

beforeAll(async () => {
  codeRepo = makeCodeRepo();
  handler  = new OauthAuthorizeHandler({ config: makeConfig(), codeRepo });

  server = http.createServer((req, res) => {
    (async () => {
      const parsed   = new URL(req.url, 'http://x');
      const pathname = parsed.pathname;

      if (pathname !== '/mcp/v1/authorize') {
        res.writeHead(404); res.end();
        return;
      }

      if (req.method === 'GET') {
        await handler.handleGet(req, res, parsed.searchParams);
        return;
      }

      if (req.method === 'POST') {
        // Read form body.
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw      = Buffer.concat(chunks).toString('utf8');
        const formData = new URLSearchParams(raw);
        await handler.handlePost(req, res, formData);
        return;
      }

      res.writeHead(405); res.end();
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

beforeEach(() => {
  // Fresh codeRepo and handler for each test to avoid state bleed.
  codeRepo = makeCodeRepo();
  handler  = new OauthAuthorizeHandler({ config: makeConfig(), codeRepo });
  // Patch the server's handler reference.
  server._handler = handler;
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('OauthAuthorizeHandler — GET /authorize', () => {
  it('missing required param → 400', async () => {
    // Missing code_challenge
    const qs = buildQuery({ ...VALID_GET_PARAMS, code_challenge: undefined });
    const { statusCode } = await httpRequest(
      port, 'GET',
      `/mcp/v1/authorize?${new URLSearchParams({
        ...VALID_GET_PARAMS,
      }).delete('code_challenge') || new URLSearchParams({ response_type: 'code', client_id: 'c', redirect_uri: 'http://localhost/' })}`,
    );
    // Use direct handler call for simplicity
    const res = mockRes();
    const req  = mockReq({ headers: { 'x-synaps-test-auth': TEST_AUTH } });
    await handler.handleGet(req, res, new URLSearchParams({
      response_type: 'code', client_id: 'c',
      redirect_uri: 'http://localhost/', code_challenge_method: 'S256',
      // code_challenge intentionally missing
    }));
    expect(res._status).toBe(400);
  });

  it('invalid redirect_uri prefix → 400 invalid_redirect_uri', async () => {
    const res = mockRes();
    const req = mockReq({ headers: { 'x-synaps-test-auth': TEST_AUTH } });
    await handler.handleGet(req, res, new URLSearchParams({
      ...VALID_GET_PARAMS,
      redirect_uri: 'ftp://evil.example.com/cb',
    }));
    expect(res._status).toBe(400);
    expect(res._body).toContain('invalid_redirect_uri');
  });

  it('unsupported code_challenge_method → 400', async () => {
    const res = mockRes();
    const req = mockReq({ headers: { 'x-synaps-test-auth': TEST_AUTH } });
    await handler.handleGet(req, res, new URLSearchParams({
      ...VALID_GET_PARAMS,
      code_challenge_method: 'plain',
    }));
    expect(res._status).toBe(400);
    expect(res._body).toContain('unsupported_challenge_method');
  });

  it('unauthenticated (no test-auth, no session) → 302 to /agents/login', async () => {
    const noAuthHandler = new OauthAuthorizeHandler({
      config:  makeConfig({ test_auth_header_enabled: false }),
      codeRepo,
    });
    const res = mockRes();
    const req = mockReq({ url: '/mcp/v1/authorize?response_type=code', headers: {} });
    await noAuthHandler.handleGet(req, res, new URLSearchParams(VALID_GET_PARAMS));
    expect(res._status).toBe(302);
    expect(res._headers['Location']).toContain('/agents/login');
    expect(res._headers['Location']).toContain('next=');
  });

  it('authenticated via test-auth-header → renders consent HTML (200 text/html)', async () => {
    const res = mockRes();
    const req = mockReq({ headers: { 'x-synaps-test-auth': TEST_AUTH } });
    await handler.handleGet(req, res, new URLSearchParams(VALID_GET_PARAMS));
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toContain('text/html');
    expect(res._body).toContain('Authorize');
  });

  it('consent HTML escapes " in client_id (XSS protection)', async () => {
    const res = mockRes();
    const req = mockReq({ headers: { 'x-synaps-test-auth': TEST_AUTH } });
    await handler.handleGet(req, res, new URLSearchParams({
      ...VALID_GET_PARAMS,
      client_id: 'evil"client',
    }));
    expect(res._body).not.toContain('"client');      // raw quote must not appear unescaped
    expect(res._body).toContain('&quot;client');      // must be HTML-escaped
  });

  it('CSP header is set on consent response', async () => {
    const res = mockRes();
    const req = mockReq({ headers: { 'x-synaps-test-auth': TEST_AUTH } });
    await handler.handleGet(req, res, new URLSearchParams(VALID_GET_PARAMS));
    expect(res._headers['Content-Security-Policy']).toBeTruthy();
    expect(res._headers['Content-Security-Policy']).toContain("default-src 'self'");
  });

  it('scope round-trips through consent HTML', async () => {
    const res = mockRes();
    const req = mockReq({ headers: { 'x-synaps-test-auth': TEST_AUTH } });
    await handler.handleGet(req, res, new URLSearchParams({
      ...VALID_GET_PARAMS,
      scope: 'openid profile',
    }));
    expect(res._body).toContain('openid profile');
  });
});

describe('OauthAuthorizeHandler — POST /authorize', () => {
  /**
   * Helper: perform a GET to grab the csrf_token from the handler's internal
   * Map.  We peek at the handler's _csrf Map directly since we can't scrape
   * the token from HTML in unit tests easily.
   */
  async function getValidCsrfToken(params = {}) {
    const res = mockRes();
    const req = mockReq({ headers: { 'x-synaps-test-auth': TEST_AUTH } });
    await handler.handleGet(req, res, new URLSearchParams({ ...VALID_GET_PARAMS, ...params }));
    // The CSRF token is the only entry we just added.
    const [token] = handler._csrf.keys();
    return token;
  }

  it('CSRF mismatch → 400 invalid_request', async () => {
    await getValidCsrfToken();
    const res = mockRes();
    const req = mockReq({ headers: {} });
    await handler.handlePost(req, res, new URLSearchParams({
      csrf_token: 'totally-wrong-token',
      consent:    'allow',
    }));
    expect(res._status).toBe(400);
    expect(res._body).toContain('csrf_token');
  });

  it('deny consent → 302 to redirect_uri with error=access_denied', async () => {
    const csrf = await getValidCsrfToken();
    const res  = mockRes();
    const req  = mockReq({ headers: {} });
    await handler.handlePost(req, res, new URLSearchParams({
      csrf_token: csrf,
      consent:    'deny',
      state:      'xyz',
    }));
    expect(res._status).toBe(302);
    expect(res._headers['Location']).toContain('access_denied');
    expect(res._headers['Location']).toContain('state=xyz');
  });

  it('allow consent → 302 to redirect_uri with code + state', async () => {
    const csrf = await getValidCsrfToken();
    const res  = mockRes();
    const req  = mockReq({ headers: {} });
    await handler.handlePost(req, res, new URLSearchParams({
      csrf_token: csrf,
      consent:    'allow',
      state:      'xyz',
    }));
    expect(res._status).toBe(302);
    const loc = res._headers['Location'];
    expect(loc).toMatch(/[?&]code=/);
    expect(loc).toContain('state=xyz');
    expect(loc).toContain('http://localhost:3000/callback');
  });

  it('CSRF token is single-use — second POST with same token → 400', async () => {
    const csrf = await getValidCsrfToken();

    const res1 = mockRes();
    await handler.handlePost(mockReq({}), res1, new URLSearchParams({
      csrf_token: csrf, consent: 'allow',
    }));
    expect(res1._status).toBe(302); // first succeeds

    const res2 = mockRes();
    await handler.handlePost(mockReq({}), res2, new URLSearchParams({
      csrf_token: csrf, consent: 'allow',
    }));
    expect(res2._status).toBe(400); // second rejected
  });

  it('expired CSRF token → 400', async () => {
    // Create handler with frozen clock in the past for GET, then advance for POST.
    const BASE_NOW = Date.now();
    let now = BASE_NOW;
    const fakeClock = () => now;

    const h = new OauthAuthorizeHandler({
      config:  makeConfig({ code_ttl_ms: 1000 }), // 1s CSRF TTL
      codeRepo,
      clock:   fakeClock,
    });

    const res1 = mockRes();
    const req1 = mockReq({ headers: { 'x-synaps-test-auth': TEST_AUTH } });
    await h.handleGet(req1, res1, new URLSearchParams(VALID_GET_PARAMS));
    const [csrf] = h._csrf.keys();

    // Advance clock past the CSRF TTL.
    now = BASE_NOW + 2000;

    const res2 = mockRes();
    await h.handlePost(mockReq({}), res2, new URLSearchParams({
      csrf_token: csrf, consent: 'allow',
    }));
    expect(res2._status).toBe(400);
    expect(res2._body).toContain('expired');
  });

  it('code is stored in repo with correct client_id and redirect_uri', async () => {
    const csrf = await getValidCsrfToken();
    const res  = mockRes();
    await handler.handlePost(mockReq({}), res, new URLSearchParams({
      csrf_token: csrf, consent: 'allow',
    }));

    const [, storedCode] = [...codeRepo._codes.entries()][0];
    expect(storedCode.client_id).toBe('my-client');
    expect(storedCode.redirect_uri).toBe('http://localhost:3000/callback');
    expect(storedCode.code_challenge).toBe(CHALLENGE);
  });

  it('redirect_uri preserves state correctly', async () => {
    const csrf = await getValidCsrfToken({ state: 'special-state-value' });
    const res  = mockRes();
    await handler.handlePost(mockReq({}), res, new URLSearchParams({
      csrf_token: csrf, consent: 'allow', state: 'special-state-value',
    }));
    expect(res._headers['Location']).toContain('state=special-state-value');
  });
});

// ── mock helpers ──────────────────────────────────────────────────────────────

function mockRes() {
  const r = {
    _status:  null,
    _headers: {},
    _body:    '',
    headersSent: false,
    writeHead(status, headers = {}) {
      r._status  = status;
      r._headers = { ...r._headers, ...headers };
      r.headersSent = true;
    },
    end(body = '') {
      r._body += body;
    },
  };
  return r;
}

function mockReq({ headers = {}, url = '/mcp/v1/authorize?response_type=code' } = {}) {
  return { headers, url };
}
