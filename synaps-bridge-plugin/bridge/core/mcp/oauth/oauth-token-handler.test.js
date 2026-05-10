/**
 * @file bridge/core/mcp/oauth/oauth-token-handler.test.js
 *
 * Tests for OauthTokenHandler.
 *
 * Uses in-memory stubs for codeRepo and tokenRepo.
 *
 * Spec reference: Phase 9 brief § Track 3 — Token handler; 12 tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { OauthTokenHandler } from './oauth-token-handler.js';

// ── PKCE helper ───────────────────────────────────────────────────────────────

const VERIFIER  = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256')
  .update(VERIFIER, 'ascii')
  .digest()
  .toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ── stubs ─────────────────────────────────────────────────────────────────────

function makeCodeRepo({ redeemResult = null } = {}) {
  return {
    async redeem(_code) {
      return redeemResult;
    },
  };
}

/** A realistic stored doc that matches valid request params. */
const STORED_DOC = Object.freeze({
  code:                  'auth-code-abc',
  client_id:             'my-client',
  synaps_user_id:        '507f1f77bcf86cd799439011',
  institution_id:        '507f1f77bcf86cd799439012',
  redirect_uri:          'http://localhost:3000/callback',
  code_challenge:        CHALLENGE,
  code_challenge_method: 'S256',
  scope:                 'openid profile',
  redeemed_at:           new Date(),
});

function makeTokenRepo() {
  const tokens = [];
  return {
    _tokens: tokens,
    async create(params) {
      const doc = { _id: 'tok-1', ...params, created_at: new Date() };
      tokens.push(doc);
      return doc;
    },
  };
}

function makeConfig(overrides = {}) {
  return {
    token_ttl_ms: 2_592_000_000, // 30 days
    ...overrides,
  };
}

// ── mock response helper ──────────────────────────────────────────────────────

function mockRes() {
  const r = {
    _status:     null,
    _headers:    {},
    _body:       '',
    headersSent: false,
    writeHead(status, headers = {}) {
      r._status  = status;
      r._headers = { ...r._headers, ...headers };
      r.headersSent = true;
    },
    end(body = '') { r._body += body; },
    json() { return JSON.parse(r._body); },
  };
  return r;
}

function makeBody(overrides = {}) {
  return new URLSearchParams({
    grant_type:    'authorization_code',
    code:          'auth-code-abc',
    code_verifier: VERIFIER,
    client_id:     'my-client',
    redirect_uri:  'http://localhost:3000/callback',
    ...overrides,
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('OauthTokenHandler', () => {
  let tokenRepo;
  let handler;

  beforeEach(() => {
    tokenRepo = makeTokenRepo();
    handler   = new OauthTokenHandler({
      config:    makeConfig(),
      codeRepo:  makeCodeRepo({ redeemResult: { ...STORED_DOC } }),
      tokenRepo,
    });
  });

  // ── success path ──────────────────────────────────────────────────────────

  it('success → 200 with access_token, token_type, expires_in, scope', async () => {
    const res = mockRes();
    await handler.handle({}, res, makeBody());
    expect(res._status).toBe(200);
    const json = res.json();
    expect(typeof json.access_token).toBe('string');
    expect(json.access_token.length).toBeGreaterThan(0);
    expect(json.token_type).toBe('bearer');
    expect(typeof json.expires_in).toBe('number');
    expect(json.scope).toBe('openid profile');
  });

  it('Content-Type is application/json on success', async () => {
    const res = mockRes();
    await handler.handle({}, res, makeBody());
    expect(res._headers['Content-Type']).toContain('application/json');
  });

  // ── missing required fields ───────────────────────────────────────────────

  it('missing grant_type → 400 invalid_request', async () => {
    const res = mockRes();
    await handler.handle({}, res, new URLSearchParams({
      code: 'x', code_verifier: VERIFIER, client_id: 'c', redirect_uri: 'https://x.com',
    }));
    expect(res._status).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('wrong grant_type → 400 unsupported_grant_type', async () => {
    const res = mockRes();
    await handler.handle({}, res, makeBody({ grant_type: 'client_credentials' }));
    expect(res._status).toBe(400);
    expect(res.json().error).toBe('unsupported_grant_type');
  });

  it('missing code → 400 invalid_request', async () => {
    const res  = mockRes();
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code_verifier: VERIFIER,
      client_id: 'c', redirect_uri: 'https://x.com',
    });
    await handler.handle({}, res, body);
    expect(res._status).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('missing code_verifier → 400 invalid_request', async () => {
    const res  = mockRes();
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code: 'abc',
      client_id: 'c', redirect_uri: 'https://x.com',
    });
    await handler.handle({}, res, body);
    expect(res._status).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('missing client_id → 400 invalid_request', async () => {
    const res  = mockRes();
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code: 'abc',
      code_verifier: VERIFIER, redirect_uri: 'https://x.com',
    });
    await handler.handle({}, res, body);
    expect(res._status).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('missing redirect_uri → 400 invalid_request', async () => {
    const res  = mockRes();
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code: 'abc',
      code_verifier: VERIFIER, client_id: 'c',
    });
    await handler.handle({}, res, body);
    expect(res._status).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  // ── invalid_grant scenarios ────────────────────────────────────────────────

  it('code not found / expired / already redeemed → 400 invalid_grant', async () => {
    const h = new OauthTokenHandler({
      config:    makeConfig(),
      codeRepo:  makeCodeRepo({ redeemResult: null }), // redeem returns null
      tokenRepo,
    });
    const res = mockRes();
    await h.handle({}, res, makeBody());
    expect(res._status).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
  });

  it('client_id mismatch → 400 invalid_grant', async () => {
    const res = mockRes();
    await handler.handle({}, res, makeBody({ client_id: 'different-client' }));
    expect(res._status).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
  });

  it('redirect_uri mismatch → 400 invalid_grant', async () => {
    const res = mockRes();
    await handler.handle({}, res, makeBody({ redirect_uri: 'http://localhost:9999/other' }));
    expect(res._status).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
  });

  it('wrong code_verifier → 400 invalid_grant', async () => {
    const res = mockRes();
    await handler.handle({}, res, makeBody({ code_verifier: 'wrong-verifier-value-that-does-not-match-' }));
    expect(res._status).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
  });

  it('token is stored in tokenRepo with correct fields', async () => {
    const res = mockRes();
    await handler.handle({}, res, makeBody());
    expect(tokenRepo._tokens).toHaveLength(1);
    const tok = tokenRepo._tokens[0];
    expect(tok.name).toBe('my-client');
    expect(String(tok.synaps_user_id)).toBe(STORED_DOC.synaps_user_id);
    expect(tok.expires_at).toBeInstanceOf(Date);
    // token_hash must never equal the raw access_token
    const json = res.json();
    expect(tok.token_hash).not.toBe(json.access_token);
  });
});
