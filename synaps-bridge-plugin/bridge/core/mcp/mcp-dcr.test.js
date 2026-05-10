/**
 * @file bridge/core/mcp/mcp-dcr.test.js
 *
 * Unit tests for McpDcrHandler (Phase 8 — Track 4, Wave A4).
 *
 * All tests run entirely in-memory; no MongoDB, no network.
 *
 * Pool: vmThreads (vitest.config.js)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpDcrHandler } from './mcp-dcr.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal, functional set of stubs/mocks.
 *
 * Individual tests override only the fields they care about.
 */
function makeOpts(overrides = {}) {
  const tokenRepo = {
    create: vi.fn().mockResolvedValue({
      _id:        'mock-oid-123',
      name:       'dcr',
      expires_at: new Date('2026-01-01T00:00:00Z'),
      created_at: new Date('2025-01-01T00:00:00Z'),
    }),
  };

  return {
    registrationSecret: 'super-secret',
    tokenRepo,
    identityRepo:       null,
    generateRawToken:   () => 'a'.repeat(64),   // deterministic 64-char hex stand-in
    hashToken:          (raw) => 'hash-of-' + raw,
    now:                () => new Date('2025-01-01T00:00:00Z').getTime(),
    logger:             { warn: vi.fn(), error: vi.fn() },
    tokenTtlMs:         365 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

/**
 * Build a valid, fully-formed request body.
 */
function validBody(overrides = {}) {
  return {
    client_name:                 'Test Client',
    registration_secret:         'super-secret',
    synaps_user_id:              'user-abc-123',
    grant_types:                 ['client_credentials'],
    token_endpoint_auth_method:  'none',
    ...overrides,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('McpDcrHandler', () => {

  // ── 1. Constructor guards ───────────────────────────────────────────────────

  it('throws if tokenRepo is omitted', () => {
    expect(() => new McpDcrHandler({ registrationSecret: 'x' })).toThrow(TypeError);
  });

  // ── 2. enabled flag ────────────────────────────────────────────────────────

  it('enabled is false when registrationSecret is empty string', () => {
    const h = new McpDcrHandler(makeOpts({ registrationSecret: '' }));
    expect(h.enabled).toBe(false);
  });

  it('enabled is false when registrationSecret is null', () => {
    const h = new McpDcrHandler(makeOpts({ registrationSecret: null }));
    expect(h.enabled).toBe(false);
  });

  it('enabled is false when registrationSecret is whitespace-only', () => {
    const h = new McpDcrHandler(makeOpts({ registrationSecret: '   ' }));
    expect(h.enabled).toBe(false);
  });

  it('enabled is true when registrationSecret is non-empty', () => {
    const h = new McpDcrHandler(makeOpts({ registrationSecret: 'secret' }));
    expect(h.enabled).toBe(true);
  });

  // ── 3. Disabled handler returns 404 ───────────────────────────────────────

  it('returns 404 when handler is disabled (empty secret)', async () => {
    const h = new McpDcrHandler(makeOpts({ registrationSecret: '' }));
    const result = await h.register(validBody());
    expect(result.statusCode).toBe(404);
    expect(result.body).toEqual({ error: 'not_found' });
  });

  // ── 4. Body validation ─────────────────────────────────────────────────────

  it('returns 400 when body is null', async () => {
    const h = new McpDcrHandler(makeOpts());
    const result = await h.register(null);
    expect(result.statusCode).toBe(400);
    expect(result.body.error).toBe('invalid_request');
    expect(result.body.error_description).toMatch(/body must be object/i);
  });

  it('returns 400 when body is a string', async () => {
    const h = new McpDcrHandler(makeOpts());
    const result = await h.register('{"client_name":"x"}');
    expect(result.statusCode).toBe(400);
    expect(result.body.error).toBe('invalid_request');
  });

  it('returns 400 when body is an array', async () => {
    const h = new McpDcrHandler(makeOpts());
    const result = await h.register([{ registration_secret: 'super-secret' }]);
    expect(result.statusCode).toBe(400);
    expect(result.body.error).toBe('invalid_request');
  });

  // ── 5. registration_secret checks ─────────────────────────────────────────

  it('returns 401 when registration_secret is missing', async () => {
    const h = new McpDcrHandler(makeOpts());
    const result = await h.register({ synaps_user_id: 'u1' });
    expect(result.statusCode).toBe(401);
    expect(result.body).toEqual({ error: 'invalid_client' });
  });

  it('returns 401 when registration_secret is wrong', async () => {
    const h = new McpDcrHandler(makeOpts());
    const result = await h.register(validBody({ registration_secret: 'wrong-secret' }));
    expect(result.statusCode).toBe(401);
    expect(result.body).toEqual({ error: 'invalid_client' });
  });

  it('returns 401 and does NOT crash for mismatched-length registration_secret', async () => {
    const h = new McpDcrHandler(makeOpts());
    // One char longer than the real secret — exercises length-mismatch branch.
    const result = await h.register(validBody({ registration_secret: 'super-secretX' }));
    expect(result.statusCode).toBe(401);
    expect(result.body).toEqual({ error: 'invalid_client' });
  });

  it('returns 401 and does NOT crash for empty registration_secret', async () => {
    const h = new McpDcrHandler(makeOpts());
    const result = await h.register(validBody({ registration_secret: '' }));
    expect(result.statusCode).toBe(401);
    expect(result.body).toEqual({ error: 'invalid_client' });
  });

  // ── 6. synaps_user_id checks ──────────────────────────────────────────────

  it('returns 400 when synaps_user_id is missing', async () => {
    const h = new McpDcrHandler(makeOpts());
    const body = validBody();
    delete body.synaps_user_id;
    const result = await h.register(body);
    expect(result.statusCode).toBe(400);
    expect(result.body.error).toBe('invalid_request');
    expect(result.body.error_description).toMatch(/synaps_user_id required/i);
  });

  it('returns 400 when synaps_user_id is an empty string', async () => {
    const h = new McpDcrHandler(makeOpts());
    const result = await h.register(validBody({ synaps_user_id: '' }));
    expect(result.statusCode).toBe(400);
    expect(result.body.error_description).toMatch(/synaps_user_id required/i);
  });

  // ── 7. identityRepo checks ────────────────────────────────────────────────

  it('returns 400 when identityRepo.findById returns falsy', async () => {
    const identityRepo = { findById: vi.fn().mockResolvedValue(null) };
    const h = new McpDcrHandler(makeOpts({ identityRepo }));
    const result = await h.register(validBody());
    expect(result.statusCode).toBe(400);
    expect(result.body.error).toBe('invalid_request');
    expect(result.body.error_description).toMatch(/synaps_user_id not found/i);
  });

  it('returns 400 when identityRepo.findById throws', async () => {
    const identityRepo = { findById: vi.fn().mockRejectedValue(new Error('db down')) };
    const h = new McpDcrHandler(makeOpts({ identityRepo }));
    const result = await h.register(validBody());
    expect(result.statusCode).toBe(400);
    expect(result.body.error_description).toMatch(/synaps_user_id not found/i);
  });

  it('skips identity check when no identityRepo is provided', async () => {
    // No identityRepo — should succeed regardless.
    const h = new McpDcrHandler(makeOpts({ identityRepo: null }));
    const result = await h.register(validBody());
    expect(result.statusCode).toBe(201);
  });

  // ── 8. Success path ───────────────────────────────────────────────────────

  it('returns 201 with RFC 7591 minimal fields on success', async () => {
    const h = new McpDcrHandler(makeOpts());
    const result = await h.register(validBody());

    expect(result.statusCode).toBe(201);
    const b = result.body;
    expect(b).toHaveProperty('client_id');
    expect(b).toHaveProperty('client_secret');
    expect(b).toHaveProperty('client_secret_expires_at');
    expect(b).toHaveProperty('token_endpoint_auth_method', 'client_secret_post');
    expect(b).toHaveProperty('grant_types');
    expect(b.grant_types).toContain('client_credentials');
    expect(b).toHaveProperty('token_type', 'bearer');
  });

  it('client_id is exactly 16 characters', async () => {
    const h = new McpDcrHandler(makeOpts());
    const result = await h.register(validBody());
    expect(result.body.client_id).toHaveLength(16);
  });

  it('client_secret is 64 chars (matching generateRawToken stub)', async () => {
    const h = new McpDcrHandler(makeOpts());
    const result = await h.register(validBody());
    // Our stub returns 'a'.repeat(64)
    expect(result.body.client_secret).toHaveLength(64);
  });

  it('client_secret is a 64-char hex string when using real generateRawToken', async () => {
    // Use real helpers — no stubs for generate/hash.
    const opts = makeOpts();
    delete opts.generateRawToken;
    delete opts.hashToken;
    const h = new McpDcrHandler(opts);
    const result = await h.register(validBody());
    expect(result.body.client_secret).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── 9. tokenRepo.create called with correct shape ─────────────────────────

  it('calls tokenRepo.create with correct shape', async () => {
    const opts = makeOpts();
    const h = new McpDcrHandler(opts);
    await h.register(validBody({ client_name: 'My App' }));

    expect(opts.tokenRepo.create).toHaveBeenCalledOnce();
    const arg = opts.tokenRepo.create.mock.calls[0][0];

    expect(arg).toHaveProperty('token_hash', 'hash-of-' + 'a'.repeat(64));
    expect(arg).toHaveProperty('synaps_user_id', 'user-abc-123');
    expect(arg).toHaveProperty('name', 'My App');
    expect(arg).toHaveProperty('expires_at');
    expect(arg.expires_at).toBeInstanceOf(Date);
  });

  it('uses "dcr" as name label when client_name is absent', async () => {
    const opts = makeOpts();
    const h = new McpDcrHandler(opts);
    const body = validBody();
    delete body.client_name;
    await h.register(body);

    const arg = opts.tokenRepo.create.mock.calls[0][0];
    expect(arg.name).toBe('dcr');
  });

  it('client_id is generated even when client_name is null', async () => {
    const h = new McpDcrHandler(makeOpts());
    const result = await h.register(validBody({ client_name: null }));
    expect(result.statusCode).toBe(201);
    expect(result.body.client_id).toHaveLength(16);
  });

  // ── 10. client_secret_expires_at honors tokenTtlMs ───────────────────────

  it('client_secret_expires_at reflects tokenTtlMs injection', async () => {
    const nowMs      = new Date('2025-06-01T00:00:00Z').getTime();
    const tokenTtlMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    const h = new McpDcrHandler(makeOpts({ now: () => nowMs, tokenTtlMs }));
    const result = await h.register(validBody());

    const expectedSec = Math.floor((nowMs + tokenTtlMs) / 1000);
    expect(result.body.client_secret_expires_at).toBe(expectedSec);
  });

  it('now() injection controls the expiry epoch', async () => {
    const epoch2050Ms = new Date('2050-01-01T00:00:00Z').getTime();
    const ttlMs       = 1 * 24 * 60 * 60 * 1000; // 1 day
    const h = new McpDcrHandler(makeOpts({ now: () => epoch2050Ms, tokenTtlMs: ttlMs }));
    const result = await h.register(validBody());

    const expectedSec = Math.floor((epoch2050Ms + ttlMs) / 1000);
    expect(result.body.client_secret_expires_at).toBe(expectedSec);
  });

  // ── 11. Raw token must never appear in logger output ─────────────────────

  it('does NOT log the raw client_secret at any log level on success', async () => {
    const logMessages = [];
    const logger = {
      warn:  (...args) => logMessages.push(...args),
      error: (...args) => logMessages.push(...args),
      info:  (...args) => logMessages.push(...args),
      debug: (...args) => logMessages.push(...args),
    };

    // Use a unique, recognisable raw token value.
    const knownRaw = 'deadbeef'.repeat(8); // 64 chars
    const h = new McpDcrHandler(makeOpts({
      logger,
      generateRawToken: () => knownRaw,
    }));

    const result = await h.register(validBody());
    expect(result.statusCode).toBe(201);

    // The raw token must not appear in any logged string or serialised object.
    const logDump = JSON.stringify(logMessages);
    expect(logDump).not.toContain(knownRaw);
  });

  // ── 12. identityRepo integration (full success path) ─────────────────────

  it('succeeds with identityRepo when user exists', async () => {
    const identityRepo = { findById: vi.fn().mockResolvedValue({ _id: 'user-abc-123' }) };
    const h = new McpDcrHandler(makeOpts({ identityRepo }));
    const result = await h.register(validBody());
    expect(result.statusCode).toBe(201);
    expect(identityRepo.findById).toHaveBeenCalledWith('user-abc-123');
  });

  // ── 13. tokenRepo.create error ────────────────────────────────────────────

  it('returns 500 when tokenRepo.create throws', async () => {
    const tokenRepo = {
      create: vi.fn().mockRejectedValue(new Error('insert failed')),
    };
    const h = new McpDcrHandler(makeOpts({ tokenRepo }));
    const result = await h.register(validBody());
    expect(result.statusCode).toBe(500);
    expect(result.body.error).toBe('server_error');
  });

  // ── 14. Multiple registrations produce distinct client_ids ───────────────

  it('produces distinct client_ids for successive registrations', async () => {
    const h = new McpDcrHandler(makeOpts());
    const r1 = await h.register(validBody());
    const r2 = await h.register(validBody());
    expect(r1.body.client_id).not.toBe(r2.body.client_id);
  });
});
