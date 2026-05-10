/**
 * @file bridge/core/cred-broker.test.js
 *
 * Tests for CredBroker and NoopCredBroker.
 *
 * All I/O is injected via vi.fn() — no real network, no real Infisical.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CredBroker,
  NoopCredBroker,
  CredsValidationError,
  CredsUnavailableError,
  CredBrokerDisabledError,
} from './cred-broker.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fake Infisical client factory. */
function makeClient(overrides = {}) {
  return {
    getSecret: vi.fn().mockResolvedValue({ value: 'the_actual_token_value', fetchedAt: 1000 }),
    ping: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

/** Fake fetch response factory. */
function makeResponse({ status = 200, headers = {}, body = '{"ok":true}' } = {}) {
  return {
    status,
    headers: { entries: () => Object.entries(headers) },
    text: vi.fn().mockResolvedValue(body),
  };
}

/** Fake logger. */
function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Collect all logger call argument strings (joined flat). */
function allLoggedText(logger) {
  const calls = [
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
    ...logger.debug.mock.calls,
  ];
  return calls.map(args => JSON.stringify(args)).join('\n');
}

/** Fixed clock factory — returns a function with a mutable current time. */
function makeClock(initialMs = 1_000_000) {
  let t = initialMs;
  const fn = vi.fn().mockImplementation(() => t);
  fn.advance = (ms) => { t += ms; fn.mockImplementation(() => t); };
  return fn;
}

/** Minimal valid `use()` args. */
const VALID_ARGS = Object.freeze({
  synapsUserId:  'user-1',
  institutionId: 'inst-1',
  key:           'github.token',
  request: Object.freeze({
    method: 'GET',
    url:    'https://api.example.com/resource',
  }),
});

/** Build a broker with reasonable test defaults. */
function makeBroker({ clientOpts, fetchImpl, loggerOpts, nowFn, cacheTtlSecs } = {}) {
  const client  = makeClient(clientOpts);
  const logger  = makeLogger();
  const now     = nowFn ?? makeClock();
  const fetchFn = fetchImpl ?? vi.fn().mockResolvedValue(makeResponse());

  const broker = new CredBroker({
    infisicalClient: client,
    cacheTtlSecs:    cacheTtlSecs ?? 300,
    fetch:           fetchFn,
    logger:          loggerOpts !== undefined ? loggerOpts : logger,
    now,
  });

  return { broker, client, logger, now, fetchFn };
}

// ─── Validation tests ─────────────────────────────────────────────────────────

describe('CredBroker.use() — validation', () => {
  it('throws CredsValidationError when synapsUserId is missing', async () => {
    const { broker } = makeBroker();
    await expect(broker.use({ ...VALID_ARGS, synapsUserId: '' }))
      .rejects.toThrow(CredsValidationError);
  });

  it('throws CredsValidationError when synapsUserId is not a string', async () => {
    const { broker } = makeBroker();
    await expect(broker.use({ ...VALID_ARGS, synapsUserId: 42 }))
      .rejects.toThrow(CredsValidationError);
  });

  it('throws CredsValidationError when institutionId is missing', async () => {
    const { broker } = makeBroker();
    await expect(broker.use({ ...VALID_ARGS, institutionId: '' }))
      .rejects.toThrow(CredsValidationError);
  });

  it('throws CredsValidationError when institutionId is not a string', async () => {
    const { broker } = makeBroker();
    await expect(broker.use({ ...VALID_ARGS, institutionId: null }))
      .rejects.toThrow(CredsValidationError);
  });

  it('throws CredsValidationError when key is missing', async () => {
    const { broker } = makeBroker();
    await expect(broker.use({ ...VALID_ARGS, key: '' }))
      .rejects.toThrow(CredsValidationError);
  });

  it('throws CredsValidationError when key is not a string', async () => {
    const { broker } = makeBroker();
    await expect(broker.use({ ...VALID_ARGS, key: undefined }))
      .rejects.toThrow(CredsValidationError);
  });

  it('throws CredsValidationError when request is missing', async () => {
    const { broker } = makeBroker();
    await expect(broker.use({ ...VALID_ARGS, request: undefined }))
      .rejects.toThrow(CredsValidationError);
  });

  it('throws CredsValidationError when request is not an object', async () => {
    const { broker } = makeBroker();
    await expect(broker.use({ ...VALID_ARGS, request: 'GET /foo' }))
      .rejects.toThrow(CredsValidationError);
  });

  it('throws CredsValidationError when request.method is missing', async () => {
    const { broker } = makeBroker();
    await expect(broker.use({ ...VALID_ARGS, request: { url: 'https://x.io' } }))
      .rejects.toThrow(CredsValidationError);
  });

  it('throws CredsValidationError when request.method is invalid', async () => {
    const { broker } = makeBroker();
    await expect(broker.use({ ...VALID_ARGS, request: { method: 'BREW', url: 'https://x.io' } }))
      .rejects.toThrow(CredsValidationError);
  });

  it('accepts method in lowercase (case-insensitive)', async () => {
    const { broker } = makeBroker();
    await expect(broker.use({ ...VALID_ARGS, request: { method: 'get', url: 'https://x.io' } }))
      .resolves.toBeDefined();
  });

  it('accepts all valid HTTP methods (POST, PUT, DELETE, PATCH, HEAD)', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
      const { broker } = makeBroker();
      await expect(broker.use({ ...VALID_ARGS, request: { method, url: 'https://x.io' } }))
        .resolves.toBeDefined();
    }
  });

  it('throws CredsValidationError when request.url is missing', async () => {
    const { broker } = makeBroker();
    await expect(broker.use({ ...VALID_ARGS, request: { method: 'GET', url: '' } }))
      .rejects.toThrow(CredsValidationError);
  });

  it('throws CredsValidationError when request.url is not a string', async () => {
    const { broker } = makeBroker();
    await expect(broker.use({ ...VALID_ARGS, request: { method: 'GET', url: 42 } }))
      .rejects.toThrow(CredsValidationError);
  });

  it('error code on CredsValidationError is "invalid_request"', async () => {
    const { broker } = makeBroker();
    const err = await broker.use({ ...VALID_ARGS, synapsUserId: '' }).catch(e => e);
    expect(err.code).toBe('invalid_request');
    expect(err.name).toBe('CredsValidationError');
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('CredBroker.use() — happy path', () => {
  it('returns status, headers, body, cached=false, fetchedAt', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"data":1}' }),
    );
    const { broker } = makeBroker({ fetchImpl: fetchFn });

    const result = await broker.use({ ...VALID_ARGS });
    expect(result.status).toBe(200);
    expect(result.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(result.body).toBe('{"data":1}');
    expect(result.cached).toBe(false);
    expect(typeof result.fetchedAt).toBe('number');
  });

  it('returned object has NO token, Authorization, secret, or secretValue keys', async () => {
    const { broker } = makeBroker();
    const result = await broker.use({ ...VALID_ARGS });
    const keys = Object.keys(result).map(k => k.toLowerCase());
    expect(keys).not.toContain('token');
    expect(keys).not.toContain('authorization');
    expect(keys).not.toContain('secret');
    expect(keys).not.toContain('secretvalue');
  });

  it('calls infisicalClient.getSecret with correct args', async () => {
    const { broker, client } = makeBroker();
    await broker.use({ ...VALID_ARGS });
    expect(client.getSecret).toHaveBeenCalledOnce();
    expect(client.getSecret).toHaveBeenCalledWith({
      institutionId: 'inst-1',
      synapsUserId:  'user-1',
      key:           'github.token',
    });
  });

  it('calls fetch with the correct method, url, and body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { broker } = makeBroker({ fetchImpl: fetchFn });

    await broker.use({
      ...VALID_ARGS,
      request: { method: 'POST', url: 'https://api.example.com/do', body: '{"x":1}' },
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.example.com/do');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"x":1}');
  });
});

// ─── Header injection ─────────────────────────────────────────────────────────

describe('CredBroker.use() — header injection', () => {
  it('injects Authorization: Bearer <token> into fetch headers', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const client = makeClient();
    client.getSecret.mockResolvedValue({ value: 'MY_SECRET_TOKEN', fetchedAt: 100 });
    const broker = new CredBroker({
      infisicalClient: client,
      fetch: fetchFn,
      logger: makeLogger(),
    });

    await broker.use({ ...VALID_ARGS });
    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer MY_SECRET_TOKEN');
  });

  it('overwrites caller-supplied Authorization: Bearer caller_token', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { broker } = makeBroker({ fetchImpl: fetchFn });

    await broker.use({
      ...VALID_ARGS,
      request: {
        method:  'GET',
        url:     'https://x.io',
        headers: { Authorization: 'Bearer caller_token' },
      },
    });

    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer the_actual_token_value');
    expect(init.headers.Authorization).not.toContain('caller_token');
  });

  it('overwrites caller-supplied lowercase "authorization" header (no duplication)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { broker } = makeBroker({ fetchImpl: fetchFn });

    await broker.use({
      ...VALID_ARGS,
      request: {
        method:  'GET',
        url:     'https://x.io',
        headers: { authorization: 'Bearer sneaky_token' },
      },
    });

    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer the_actual_token_value');
    expect('authorization' in init.headers).toBe(false);
  });

  it('preserves other caller-supplied headers (e.g. X-Foo: bar)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { broker } = makeBroker({ fetchImpl: fetchFn });

    await broker.use({
      ...VALID_ARGS,
      request: {
        method:  'GET',
        url:     'https://x.io',
        headers: { 'X-Foo': 'bar', 'X-Bar': 'baz' },
      },
    });

    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers['X-Foo']).toBe('bar');
    expect(init.headers['X-Bar']).toBe('baz');
  });

  it('defaults Accept header to application/json when not set', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { broker } = makeBroker({ fetchImpl: fetchFn });

    await broker.use({ ...VALID_ARGS });

    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers.Accept).toBe('application/json');
  });

  it('preserves caller-supplied Accept header', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { broker } = makeBroker({ fetchImpl: fetchFn });

    await broker.use({
      ...VALID_ARGS,
      request: {
        method:  'GET',
        url:     'https://x.io',
        headers: { Accept: 'text/plain' },
      },
    });

    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers.Accept).toBe('text/plain');
  });
});

// ─── Body forwarding ──────────────────────────────────────────────────────────

describe('CredBroker.use() — body forwarding', () => {
  it('forwards string body on POST', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { broker } = makeBroker({ fetchImpl: fetchFn });

    await broker.use({
      ...VALID_ARGS,
      request: { method: 'POST', url: 'https://x.io', body: 'raw string body' },
    });

    const [, init] = fetchFn.mock.calls[0];
    expect(init.body).toBe('raw string body');
  });

  it('forwards Uint8Array body on PUT', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { broker } = makeBroker({ fetchImpl: fetchFn });
    const bytes = new Uint8Array([1, 2, 3]);

    await broker.use({
      ...VALID_ARGS,
      request: { method: 'PUT', url: 'https://x.io', body: bytes },
    });

    const [, init] = fetchFn.mock.calls[0];
    expect(init.body).toBe(bytes);
  });

  it('sends no body for GET requests', async () => {
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { broker } = makeBroker({ fetchImpl: fetchFn });

    await broker.use({ ...VALID_ARGS, request: { method: 'GET', url: 'https://x.io' } });

    const [, init] = fetchFn.mock.calls[0];
    expect(init.body).toBeUndefined();
  });
});

// ─── Cache behaviour ──────────────────────────────────────────────────────────

describe('CredBroker.use() — cache', () => {
  it('does NOT call getSecret a second time within TTL', async () => {
    const { broker, client } = makeBroker();

    await broker.use({ ...VALID_ARGS });
    await broker.use({ ...VALID_ARGS });

    expect(client.getSecret).toHaveBeenCalledOnce();
  });

  it('second call within TTL returns cached: true', async () => {
    const { broker } = makeBroker();

    await broker.use({ ...VALID_ARGS });
    const second = await broker.use({ ...VALID_ARGS });

    expect(second.cached).toBe(true);
  });

  it('first call returns cached: false', async () => {
    const { broker } = makeBroker();
    const first = await broker.use({ ...VALID_ARGS });
    expect(first.cached).toBe(false);
  });

  it('calls getSecret again after TTL expiry', async () => {
    const now = makeClock();
    const { broker, client } = makeBroker({ nowFn: now, cacheTtlSecs: 300 });

    await broker.use({ ...VALID_ARGS });

    // Advance past TTL.
    now.advance(301 * 1000);

    await broker.use({ ...VALID_ARGS });

    expect(client.getSecret).toHaveBeenCalledTimes(2);
  });

  it('clear() resets cache — next call re-fetches', async () => {
    const { broker, client } = makeBroker();

    await broker.use({ ...VALID_ARGS });
    broker.clear();
    await broker.use({ ...VALID_ARGS });

    expect(client.getSecret).toHaveBeenCalledTimes(2);
  });

  it('different (institutionId, synapsUserId, key) use separate cache entries', async () => {
    const { broker, client } = makeBroker();

    await broker.use({ ...VALID_ARGS });
    await broker.use({ ...VALID_ARGS, key: 'slack.token' });

    expect(client.getSecret).toHaveBeenCalledTimes(2);
  });
});

// ─── Graceful degradation ─────────────────────────────────────────────────────

describe('CredBroker.use() — graceful degradation', () => {
  it('serves stale cache with warn log when Infisical is down, within 2× TTL', async () => {
    const now = makeClock();
    const ttlSecs = 300;
    const { broker, client, logger } = makeBroker({ nowFn: now, cacheTtlSecs: ttlSecs });

    // Prime the cache.
    await broker.use({ ...VALID_ARGS });

    // Advance past TTL but inside 2× TTL.
    now.advance(400 * 1000);

    // Make Infisical fail.
    client.getSecret.mockRejectedValueOnce(new Error('Infisical down'));

    const result = await broker.use({ ...VALID_ARGS });
    expect(result.cached).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('throws CredsUnavailableError when Infisical is down beyond 2× TTL', async () => {
    const now = makeClock();
    const ttlSecs = 300;
    const { broker, client } = makeBroker({ nowFn: now, cacheTtlSecs: ttlSecs });

    // Prime the cache.
    await broker.use({ ...VALID_ARGS });

    // Advance past 2× TTL.
    now.advance(700 * 1000);

    client.getSecret.mockRejectedValueOnce(new Error('Infisical down'));

    await expect(broker.use({ ...VALID_ARGS }))
      .rejects.toThrow(CredsUnavailableError);
  });

  it('throws CredsUnavailableError when no cache and Infisical is down (network)', async () => {
    const { broker, client } = makeBroker();
    client.getSecret.mockRejectedValueOnce(new Error('Network error'));

    await expect(broker.use({ ...VALID_ARGS }))
      .rejects.toThrow(CredsUnavailableError);
  });

  it('rethrows InfisicalNotFoundError (typed, no cache)', async () => {
    const { broker, client } = makeBroker();
    const notFound = new Error('secret not found');
    notFound.name = 'InfisicalNotFoundError';
    client.getSecret.mockRejectedValueOnce(notFound);

    const err = await broker.use({ ...VALID_ARGS }).catch(e => e);
    expect(err.name).toBe('InfisicalNotFoundError');
  });

  it('rethrows InfisicalAuthError (typed, no cache)', async () => {
    const { broker, client } = makeBroker();
    const authErr = new Error('unauthorized');
    authErr.name = 'InfisicalAuthError';
    client.getSecret.mockRejectedValueOnce(authErr);

    const err = await broker.use({ ...VALID_ARGS }).catch(e => e);
    expect(err.name).toBe('InfisicalAuthError');
  });

  it('rethrows InfisicalUpstreamError (typed, no cache)', async () => {
    const { broker, client } = makeBroker();
    const upErr = new Error('502 bad gateway');
    upErr.name = 'InfisicalUpstreamError';
    client.getSecret.mockRejectedValueOnce(upErr);

    const err = await broker.use({ ...VALID_ARGS }).catch(e => e);
    expect(err.name).toBe('InfisicalUpstreamError');
  });

  it('token stays cached after a network fetch failure', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(makeResponse())          // first call succeeds
      .mockRejectedValueOnce(new Error('ECONNRESET')); // second call fails
    const { broker, client } = makeBroker({ fetchImpl: fetchFn });

    // Prime the cache via a successful call.
    await broker.use({ ...VALID_ARGS });
    // Second upstream call fails.
    await expect(broker.use({ ...VALID_ARGS })).rejects.toThrow(CredsUnavailableError);
    // Cache still holds the token — third call succeeds without re-fetching from Infisical.
    fetchFn.mockResolvedValueOnce(makeResponse());
    await broker.use({ ...VALID_ARGS });
    expect(client.getSecret).toHaveBeenCalledOnce();
  });
});

// ─── Network error path ───────────────────────────────────────────────────────

describe('CredBroker.use() — network error', () => {
  it('throws CredsUnavailableError when fetch throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { broker } = makeBroker({ fetchImpl: fetchFn });

    await expect(broker.use({ ...VALID_ARGS }))
      .rejects.toThrow(CredsUnavailableError);
  });

  it('thrown CredsUnavailableError has code "creds_unavailable"', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('timeout'));
    const { broker } = makeBroker({ fetchImpl: fetchFn });

    const err = await broker.use({ ...VALID_ARGS }).catch(e => e);
    expect(err.code).toBe('creds_unavailable');
  });

  it('upstream fetch failure preserves cause', async () => {
    const cause = new Error('ECONNREFUSED');
    const fetchFn = vi.fn().mockRejectedValue(cause);
    const { broker } = makeBroker({ fetchImpl: fetchFn });

    const err = await broker.use({ ...VALID_ARGS }).catch(e => e);
    expect(err.cause).toBe(cause);
  });
});

// ─── Logging / token-leak audit ───────────────────────────────────────────────

describe('CredBroker.use() — logging / token-leak', () => {
  it('never logs the raw token value', async () => {
    const logger = makeLogger();
    const client = makeClient();
    client.getSecret.mockResolvedValue({ value: 'SUPER_SECRET_12345', fetchedAt: 1 });

    const broker = new CredBroker({
      infisicalClient: client,
      fetch: vi.fn().mockResolvedValue(makeResponse()),
      logger,
    });

    await broker.use({ ...VALID_ARGS });

    const logged = allLoggedText(logger);
    expect(logged).not.toContain('SUPER_SECRET_12345');
  });

  it('never logs "Bearer <token>" string', async () => {
    const logger = makeLogger();
    const client = makeClient();
    client.getSecret.mockResolvedValue({ value: 'SUPER_SECRET_12345', fetchedAt: 1 });

    const broker = new CredBroker({
      infisicalClient: client,
      fetch: vi.fn().mockResolvedValue(makeResponse()),
      logger,
    });

    await broker.use({ ...VALID_ARGS });

    const logged = allLoggedText(logger);
    expect(logged).not.toContain('Bearer SUPER_SECRET_12345');
  });

  it('warn log on stale-cache degradation includes errorClass, not token value', async () => {
    const now = makeClock();
    const logger = makeLogger();
    const client = makeClient();
    client.getSecret.mockResolvedValue({ value: 'STALE_TOKEN_VALUE', fetchedAt: 1 });

    const broker = new CredBroker({
      infisicalClient: client,
      fetch: vi.fn().mockResolvedValue(makeResponse()),
      logger,
      now,
      cacheTtlSecs: 300,
    });

    await broker.use({ ...VALID_ARGS });

    // Advance into graceful-degradation window.
    now.advance(400 * 1000);
    client.getSecret.mockRejectedValueOnce(new Error('InfisicalUpstreamError'));

    await broker.use({ ...VALID_ARGS });

    const logged = allLoggedText(logger);
    expect(logged).not.toContain('STALE_TOKEN_VALUE');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('info log includes synapsUserId, institutionId, key, method, url', async () => {
    const logger = makeLogger();
    const broker = new CredBroker({
      infisicalClient: makeClient(),
      fetch: vi.fn().mockResolvedValue(makeResponse()),
      logger,
    });

    await broker.use({ ...VALID_ARGS });

    const logged = allLoggedText(logger);
    expect(logged).toContain('user-1');
    expect(logged).toContain('inst-1');
    expect(logged).toContain('github.token');
    expect(logged).toContain('GET');
    expect(logged).toContain('https://api.example.com/resource');
  });

  it('debug log includes cached, status, duration_ms — but NOT the token', async () => {
    const logger = makeLogger();
    const client = makeClient();
    client.getSecret.mockResolvedValue({ value: 'TOKEN_SHOULD_NOT_APPEAR', fetchedAt: 1 });

    const broker = new CredBroker({
      infisicalClient: client,
      fetch: vi.fn().mockResolvedValue(makeResponse({ status: 201 })),
      logger,
    });

    await broker.use({ ...VALID_ARGS });

    const debugLogs = logger.debug.mock.calls.map(a => JSON.stringify(a)).join('\n');
    expect(debugLogs).not.toContain('TOKEN_SHOULD_NOT_APPEAR');
    expect(debugLogs).toContain('201');
    expect(debugLogs).toContain('cached');
    expect(debugLogs).toContain('duration_ms');
  });
});

// ─── ping() ───────────────────────────────────────────────────────────────────

describe('CredBroker.ping()', () => {
  it('returns ok: true and broker: "infisical" on success', async () => {
    const { broker } = makeBroker();
    const result = await broker.ping();
    expect(result.ok).toBe(true);
    expect(result.broker).toBe('infisical');
  });

  it('returns ok: false with error message when client.ping throws', async () => {
    const client = makeClient();
    client.ping.mockRejectedValueOnce(new Error('connection refused'));
    const broker = new CredBroker({
      infisicalClient: client,
      fetch: vi.fn(),
      logger: makeLogger(),
    });

    const result = await broker.ping();
    expect(result.ok).toBe(false);
    expect(result.broker).toBe('infisical');
    expect(result.error).toBe('connection refused');
  });
});

// ─── NoopCredBroker ───────────────────────────────────────────────────────────

describe('NoopCredBroker', () => {
  it('use() throws CredBrokerDisabledError', async () => {
    const noop = new NoopCredBroker();
    await expect(noop.use({ ...VALID_ARGS }))
      .rejects.toThrow(CredBrokerDisabledError);
  });

  it('use() error has code "creds_disabled"', async () => {
    const noop = new NoopCredBroker();
    const err = await noop.use({ ...VALID_ARGS }).catch(e => e);
    expect(err.code).toBe('creds_disabled');
  });

  it('use() error message is "creds broker is disabled"', async () => {
    const noop = new NoopCredBroker();
    const err = await noop.use({}).catch(e => e);
    expect(err.message).toBe('creds broker is disabled');
  });

  it('ping() returns { ok: false, broker: "noop" }', async () => {
    const noop = new NoopCredBroker();
    const result = await noop.ping();
    expect(result).toEqual({ ok: false, broker: 'noop' });
  });

  it('clear() is a no-op (does not throw)', () => {
    const noop = new NoopCredBroker();
    expect(() => noop.clear()).not.toThrow();
  });
});

// ─── Error class properties ───────────────────────────────────────────────────

describe('Error classes', () => {
  it('CredsValidationError has correct name and code', () => {
    const e = new CredsValidationError('bad input');
    expect(e.name).toBe('CredsValidationError');
    expect(e.code).toBe('invalid_request');
    expect(e instanceof Error).toBe(true);
  });

  it('CredsUnavailableError has correct name and code', () => {
    const e = new CredsUnavailableError('unavailable');
    expect(e.name).toBe('CredsUnavailableError');
    expect(e.code).toBe('creds_unavailable');
  });

  it('CredBrokerDisabledError has correct name and code', () => {
    const e = new CredBrokerDisabledError('disabled');
    expect(e.name).toBe('CredBrokerDisabledError');
    expect(e.code).toBe('creds_disabled');
  });

  it('CredsUnavailableError supports { cause } option', () => {
    const cause = new Error('original');
    const e = new CredsUnavailableError('wrapped', { cause });
    expect(e.cause).toBe(cause);
  });
});
