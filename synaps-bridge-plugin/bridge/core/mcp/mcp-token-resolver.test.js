/**
 * @file bridge/core/mcp/mcp-token-resolver.test.js
 *
 * Tests for hashToken, generateRawToken, and McpTokenResolver.
 *
 * No real DB — uses vi.fn() stubs for McpTokenRepo.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { hashToken, generateRawToken, McpTokenResolver } from './mcp-token-resolver.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const silentLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

/** Reset all logger spies before each test */
beforeEach(() => {
  vi.clearAllMocks();
});

// ── hashToken ─────────────────────────────────────────────────────────────────

describe('hashToken', () => {
  it('returns a 64-char lowercase hex string for a normal input', () => {
    const result = hashToken('hello');
    expect(typeof result).toBe('string');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws TypeError for an empty string', () => {
    expect(() => hashToken('')).toThrow(TypeError);
    expect(() => hashToken('')).toThrow('hashToken: rawToken must be a non-empty string');
  });

  it('throws TypeError for null', () => {
    expect(() => hashToken(null)).toThrow(TypeError);
  });

  it('throws TypeError for a number', () => {
    expect(() => hashToken(123)).toThrow(TypeError);
  });

  it('produces different hashes for "a" and "A" (no auto-lowercase of input)', () => {
    expect(hashToken('a')).not.toBe(hashToken('A'));
  });

  it('is deterministic — same input always yields the same output', () => {
    expect(hashToken('synaps')).toBe(hashToken('synaps'));
  });

  it('matches the known SHA-256 vector for "abc"', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

// ── generateRawToken ──────────────────────────────────────────────────────────

describe('generateRawToken', () => {
  it('returns a 64-character string', () => {
    expect(generateRawToken()).toHaveLength(64);
  });

  it('returns unique values across 10 consecutive calls', () => {
    const tokens = Array.from({ length: 10 }, () => generateRawToken());
    const unique  = new Set(tokens);
    expect(unique.size).toBe(10);
  });

  it('contains only lowercase hex characters [0-9a-f]', () => {
    expect(generateRawToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── McpTokenResolver — constructor ────────────────────────────────────────────

describe('McpTokenResolver — constructor', () => {
  it('throws TypeError when tokenRepo is not provided', () => {
    expect(() => new McpTokenResolver({ logger: silentLogger }))
      .toThrow(TypeError);
    expect(() => new McpTokenResolver({}))
      .toThrow('McpTokenResolver: tokenRepo required');
  });

  it('does not throw when tokenRepo is provided', () => {
    const repo = { findActive: vi.fn(), touch: vi.fn() };
    expect(() => new McpTokenResolver({ tokenRepo: repo })).not.toThrow();
  });
});

// ── McpTokenResolver — resolve() guard clauses ────────────────────────────────

describe('McpTokenResolver.resolve() — guard clauses', () => {
  let fakeRepo;
  let resolver;

  beforeEach(() => {
    fakeRepo = {
      findActive: vi.fn(),
      touch:      vi.fn().mockResolvedValue(undefined),
    };
    resolver = new McpTokenResolver({ tokenRepo: fakeRepo, logger: silentLogger });
  });

  it('returns null for null', async () => {
    expect(await resolver.resolve(null)).toBeNull();
    expect(fakeRepo.findActive).not.toHaveBeenCalled();
  });

  it('returns null for an empty string', async () => {
    expect(await resolver.resolve('')).toBeNull();
    expect(fakeRepo.findActive).not.toHaveBeenCalled();
  });

  it('returns null for a number', async () => {
    expect(await resolver.resolve(123)).toBeNull();
    expect(fakeRepo.findActive).not.toHaveBeenCalled();
  });

  it('returns null for undefined', async () => {
    expect(await resolver.resolve(undefined)).toBeNull();
    expect(fakeRepo.findActive).not.toHaveBeenCalled();
  });
});

// ── McpTokenResolver — resolve() happy path ───────────────────────────────────

describe('McpTokenResolver.resolve() — happy path', () => {
  const RAW_TOKEN = 'valid';
  const EXPECTED_HASH = hashToken(RAW_TOKEN);

  const fakeRow = {
    _id:            'tok_001',
    synaps_user_id: 'user_abc',
    institution_id: 'inst_xyz',
  };

  let fakeRepo;
  let resolver;

  beforeEach(() => {
    fakeRepo = {
      findActive: vi.fn().mockResolvedValue(fakeRow),
      touch:      vi.fn().mockResolvedValue(undefined),
    };
    resolver = new McpTokenResolver({ tokenRepo: fakeRepo, logger: silentLogger });
  });

  it('hashes the raw token and calls findActive with the correct SHA-256 hash', async () => {
    await resolver.resolve(RAW_TOKEN);
    expect(fakeRepo.findActive).toHaveBeenCalledOnce();
    expect(fakeRepo.findActive).toHaveBeenCalledWith(EXPECTED_HASH);
  });

  it('returns {synaps_user_id, institution_id, token_id} on a valid token', async () => {
    const result = await resolver.resolve(RAW_TOKEN);
    expect(result).toEqual({
      synaps_user_id: fakeRow.synaps_user_id,
      institution_id: fakeRow.institution_id,
      token_id:       fakeRow._id,
    });
  });

  it('calls touch with the row _id after a successful lookup', async () => {
    await resolver.resolve(RAW_TOKEN);
    // touch is fire-and-forget but still called synchronously before resolve returns
    await vi.waitFor(() => expect(fakeRepo.touch).toHaveBeenCalledOnce());
    expect(fakeRepo.touch).toHaveBeenCalledWith(fakeRow._id);
  });
});

// ── McpTokenResolver — resolve() miss ────────────────────────────────────────

describe('McpTokenResolver.resolve() — miss', () => {
  let fakeRepo;
  let resolver;

  beforeEach(() => {
    fakeRepo = {
      findActive: vi.fn().mockResolvedValue(null),
      touch:      vi.fn().mockResolvedValue(undefined),
    };
    resolver = new McpTokenResolver({ tokenRepo: fakeRepo, logger: silentLogger });
  });

  it('returns null when findActive returns null', async () => {
    expect(await resolver.resolve('sometoken')).toBeNull();
  });

  it('does not call touch when findActive returns null', async () => {
    await resolver.resolve('sometoken');
    expect(fakeRepo.touch).not.toHaveBeenCalled();
  });
});

// ── McpTokenResolver — findActive error ──────────────────────────────────────

describe('McpTokenResolver.resolve() — findActive throws', () => {
  let fakeRepo;
  let resolver;

  beforeEach(() => {
    fakeRepo = {
      findActive: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      touch:      vi.fn().mockResolvedValue(undefined),
    };
    resolver = new McpTokenResolver({ tokenRepo: fakeRepo, logger: silentLogger });
  });

  it('returns null when findActive throws', async () => {
    expect(await resolver.resolve('sometoken')).toBeNull();
  });

  it('logs a warn that includes a hashPrefix of length 8', async () => {
    await resolver.resolve('sometoken');
    expect(silentLogger.warn).toHaveBeenCalledOnce();
    const [, meta] = silentLogger.warn.mock.calls[0];
    expect(typeof meta.hashPrefix).toBe('string');
    expect(meta.hashPrefix).toHaveLength(8);
  });

  it('does NOT include the raw token in the warn log', async () => {
    const RAW = 'my-secret-raw-token';
    await resolver.resolve(RAW);
    const loggedArgs = silentLogger.warn.mock.calls[0];
    const serialised = JSON.stringify(loggedArgs);
    expect(serialised).not.toContain(RAW);
  });

  it('does NOT include the full hash in the warn log', async () => {
    const RAW  = 'sometoken';
    const FULL = hashToken(RAW);
    await resolver.resolve(RAW);
    const loggedArgs = silentLogger.warn.mock.calls[0];
    const serialised = JSON.stringify(loggedArgs);
    expect(serialised).not.toContain(FULL);
  });
});

// ── McpTokenResolver — touch error ───────────────────────────────────────────

describe('McpTokenResolver.resolve() — touch rejects', () => {
  const fakeRow = {
    _id:            { toString: () => 'tok_objectid_42' },  // simulate ObjectId
    synaps_user_id: 'user_abc',
    institution_id: 'inst_xyz',
  };

  let fakeRepo;
  let resolver;

  beforeEach(() => {
    fakeRepo = {
      findActive: vi.fn().mockResolvedValue(fakeRow),
      touch:      vi.fn().mockRejectedValue(new Error('write timeout')),
    };
    resolver = new McpTokenResolver({ tokenRepo: fakeRepo, logger: silentLogger });
  });

  it('does NOT propagate the touch error — resolve still returns the row data', async () => {
    const result = await resolver.resolve('validtoken');
    expect(result).toEqual({
      synaps_user_id: fakeRow.synaps_user_id,
      institution_id: fakeRow.institution_id,
      token_id:       fakeRow._id,
    });
  });

  it('logs a warn when touch rejects', async () => {
    await resolver.resolve('validtoken');
    // wait for the unhandled rejection to be caught by the .catch handler
    await vi.waitFor(() => expect(silentLogger.warn).toHaveBeenCalled());
    const [msg] = silentLogger.warn.mock.calls[0];
    expect(msg).toContain('touch failed');
  });

  it('includes a string token_id (not the raw ObjectId object) in the touch-error warn log', async () => {
    await resolver.resolve('validtoken');
    await vi.waitFor(() => expect(silentLogger.warn).toHaveBeenCalled());
    const [, meta] = silentLogger.warn.mock.calls[0];
    expect(typeof meta.token_id).toBe('string');
    expect(meta.token_id).toBe('tok_objectid_42');
  });
});

// ── Audit: resolve() never logs raw token or full hash at info level ──────────

describe('resolve() — security audit: no raw token / full hash at info level', () => {
  it('never calls logger.info during a successful resolution', async () => {
    const infoSpy = vi.fn();
    const repo = {
      findActive: vi.fn().mockResolvedValue({
        _id: 'tid', synaps_user_id: 'u', institution_id: 'i',
      }),
      touch: vi.fn().mockResolvedValue(undefined),
    };
    const r = new McpTokenResolver({ tokenRepo: repo, logger: { info: infoSpy, warn: vi.fn() } });
    await r.resolve('supersecrettoken');
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('never calls logger.info during a failed resolution (findActive throws)', async () => {
    const infoSpy = vi.fn();
    const repo = {
      findActive: vi.fn().mockRejectedValue(new Error('oops')),
      touch:      vi.fn(),
    };
    const r = new McpTokenResolver({ tokenRepo: repo, logger: { info: infoSpy, warn: vi.fn() } });
    await r.resolve('supersecrettoken');
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
