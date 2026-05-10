/**
 * @file tests/scp-phase-4/02-cred-broker-control-socket.test.mjs
 *
 * Acceptance tests — ControlSocket `cred_broker_use` op end-to-end.
 *
 * Strategy
 * ────────
 * • A stub credBroker is injected via vi.fn() — this keeps the test
 *   focused on the wire protocol and error-code mapping, not on the
 *   broker internals (which are tested in 00 and 01).
 * • ControlSocket is started on a tmp UDS path per describe block.
 * • Requests are sent via node:net exactly the way the pria Express layer
 *   would call the socket: one JSON line → one JSON response line.
 * • We assert both the shape of successful responses and the exact `code`
 *   values for every mapped error class.
 *
 * Scenarios (8 tests)
 * ─────────────────────
 * 1. Happy path — stub broker returns success; response has
 *    { ok:true, status, headers, body, cached, fetched_at }.
 * 2. snake_case → camelCase translation: wire sends `synaps_user_id`,
 *    broker is called with `synapsUserId`.
 * 3. Missing synaps_user_id → { ok:false, code:'invalid_request' }.
 * 4. Missing institution_id → { ok:false, code:'invalid_request' }.
 * 5. Missing key → { ok:false, code:'invalid_request' }.
 * 6. Missing request object → { ok:false, code:'invalid_request' }.
 * 7. All six error codes round-trip:
 *      creds_unavailable, secret_not_found, broker_auth_failed,
 *      broker_upstream, creds_disabled, internal_error.
 * 8. No credBroker injected (defensive) →
 *    { ok:false, code:'creds_disabled', error containing "not configured" }.
 *
 * Constraints
 * ───────────
 * • ESM only (.mjs)
 * • No top-level await
 * • Each describe block owns its own ControlSocket instance (beforeEach/afterEach)
 * • All sockets unlinked in afterEach
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { ControlSocket }              from '../../bridge/control-socket.js';
import {
  CredsValidationError,
  CredsUnavailableError,
  CredBrokerDisabledError,
}                                     from '../../bridge/core/cred-broker.js';
import {
  InfisicalNotFoundError,
  InfisicalAuthError,
  InfisicalUpstreamError,
}                                     from '../../bridge/core/cred-broker/infisical-client.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let sockCounter = 0;

function tmpSocketPath() {
  return path.join(
    os.tmpdir(),
    `cs-phase4-test-${process.pid}-${++sockCounter}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Minimal fake SessionRouter — required by ControlSocket constructor. */
function makeFakeSessionRouter() {
  return {
    start:              vi.fn(async () => {}),
    stop:               vi.fn(async () => {}),
    listSessions:       vi.fn(async () => []),
    liveSessions:       vi.fn(() => []),
    getOrCreateSession: vi.fn(async () => { throw new Error('not wired'); }),
    closeSession:       vi.fn(async () => {}),
  };
}

/**
 * Build a stub credBroker whose `use()` resolves to `resolvedValue` by default.
 */
function makeStubCredBroker(resolvedValue = null) {
  const defaultResult = resolvedValue ?? {
    status:    200,
    headers:   { 'content-type': 'application/json' },
    body:      '{"ok":true}',
    cached:    false,
    fetchedAt: 1_700_000_000_000,
  };
  return {
    use:   vi.fn().mockResolvedValue(defaultResult),
    ping:  vi.fn().mockResolvedValue({ ok: true, broker: 'infisical' }),
    clear: vi.fn(),
  };
}

/**
 * Send a single JSON line to a UDS, collect the full response, return parsed.
 */
function sendRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';

    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk;
    });
    sock.on('end', () => {
      try {
        resolve(JSON.parse(buf.trim()));
      } catch {
        reject(new Error(`Could not parse response: ${buf}`));
      }
    });
    sock.on('error', reject);
  });
}

// ─── Standard happy-path request ─────────────────────────────────────────────

const HAPPY_REQUEST = Object.freeze({
  op:             'cred_broker_use',
  synaps_user_id: 'u_cs_test_01',
  institution_id: 'inst_cs_001',
  key:            'github.token',
  request: {
    method:  'GET',
    url:     'https://api.github.com/user',
    headers: { 'X-Custom': 'my-header' },
    body:    null,
  },
});

// ─── Factory that creates a fully configured ControlSocket + stub broker ──────

async function buildCs(credBrokerOverride = undefined) {
  const socketPath  = tmpSocketPath();
  const credBroker  = credBrokerOverride !== undefined ? credBrokerOverride : makeStubCredBroker();
  const logger      = makeLogger();

  const cs = new ControlSocket({
    socketPath,
    sessionRouter: makeFakeSessionRouter(),
    credBroker,
    logger,
  });
  await cs.start();

  return {
    cs,
    socketPath,
    credBroker,
    logger,
    async teardown() {
      await cs.stop();
      try { fs.rmSync(socketPath, { force: true }); } catch { /* best-effort */ }
    },
  };
}

// ─── Test suite 1: happy path ─────────────────────────────────────────────────

describe('ControlSocket cred_broker_use — happy path', () => {
  let ctx;
  beforeEach(async () => { ctx = await buildCs(); });
  afterEach(async  () => { await ctx.teardown(); });

  it('routes to credBroker.use() and returns { ok:true, status, headers, body, cached, fetched_at }', async () => {
    const expectedResult = {
      status:    201,
      headers:   { 'x-rate-limit': '60' },
      body:      '{"login":"synaps-bot"}',
      cached:    true,
      fetchedAt: 1_700_000_000_000,
    };
    ctx.credBroker.use.mockResolvedValueOnce(expectedResult);

    const resp = await sendRequest(ctx.socketPath, HAPPY_REQUEST);

    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(201);
    expect(resp.headers).toMatchObject({ 'x-rate-limit': '60' });
    expect(resp.body).toBe('{"login":"synaps-bot"}');
    expect(resp.cached).toBe(true);
    // fetchedAt (camelCase) is mapped to fetched_at (snake_case) on the wire.
    expect(resp.fetched_at).toBe(1_700_000_000_000);
  });
});

// ─── Test suite 2: snake_case ↔ camelCase translation ────────────────────────

describe('ControlSocket cred_broker_use — wire-format translation', () => {
  let ctx;
  beforeEach(async () => { ctx = await buildCs(); });
  afterEach(async  () => { await ctx.teardown(); });

  it('translates synaps_user_id → synapsUserId and institution_id → institutionId before calling broker', async () => {
    await sendRequest(ctx.socketPath, {
      ...HAPPY_REQUEST,
      synaps_user_id: 'u_wire_translate',
      institution_id: 'inst_wire_001',
      key:            'wire.translate.key',
    });

    expect(ctx.credBroker.use).toHaveBeenCalledOnce();

    const [callArgs] = ctx.credBroker.use.mock.calls[0];
    // camelCase args MUST be passed to broker.
    expect(callArgs.synapsUserId).toBe('u_wire_translate');
    expect(callArgs.institutionId).toBe('inst_wire_001');
    expect(callArgs.key).toBe('wire.translate.key');
    // snake_case forms must NOT appear in call args.
    expect(callArgs.synaps_user_id).toBeUndefined();
    expect(callArgs.institution_id).toBeUndefined();
  });

  it('forwards request.method and request.url verbatim', async () => {
    await sendRequest(ctx.socketPath, {
      ...HAPPY_REQUEST,
      request: { method: 'POST', url: 'https://upstream.example.com/path' },
    });

    const [callArgs] = ctx.credBroker.use.mock.calls[0];
    expect(callArgs.request.method).toBe('POST');
    expect(callArgs.request.url).toBe('https://upstream.example.com/path');
  });

  it('translates request.body: null → undefined before passing to broker', async () => {
    await sendRequest(ctx.socketPath, {
      ...HAPPY_REQUEST,
      request: { method: 'GET', url: 'https://example.com', body: null },
    });

    const [callArgs] = ctx.credBroker.use.mock.calls[0];
    expect(callArgs.request.body).toBeUndefined();
  });
});

// ─── Test suite 3: wire-level input validation ────────────────────────────────

describe('ControlSocket cred_broker_use — wire-level validation (invalid_request)', () => {
  let ctx;
  beforeEach(async () => { ctx = await buildCs(); });
  afterEach(async  () => { await ctx.teardown(); });

  it('missing synaps_user_id → { ok:false, code:"invalid_request" }', async () => {
    const resp = await sendRequest(ctx.socketPath, {
      op: 'cred_broker_use', institution_id: 'inst', key: 'k',
      request: { method: 'GET', url: 'https://x.io' },
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
  });

  it('missing institution_id → { ok:false, code:"invalid_request" }', async () => {
    const resp = await sendRequest(ctx.socketPath, {
      op: 'cred_broker_use', synaps_user_id: 'uid', key: 'k',
      request: { method: 'GET', url: 'https://x.io' },
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
  });

  it('missing key → { ok:false, code:"invalid_request" }', async () => {
    const resp = await sendRequest(ctx.socketPath, {
      op: 'cred_broker_use', synaps_user_id: 'uid', institution_id: 'inst',
      request: { method: 'GET', url: 'https://x.io' },
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
  });

  it('missing request object → { ok:false, code:"invalid_request" }', async () => {
    const resp = await sendRequest(ctx.socketPath, {
      op: 'cred_broker_use', synaps_user_id: 'uid', institution_id: 'inst', key: 'k',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
  });
});

// ─── Test suite 4: all error codes round-trip ────────────────────────────────

describe('ControlSocket cred_broker_use — all error codes round-trip', () => {
  // Each test builds its own ControlSocket so mock state stays isolated.

  it('CredsValidationError from broker → code:"invalid_request"', async () => {
    const broker = makeStubCredBroker();
    broker.use.mockRejectedValueOnce(new CredsValidationError('bad method: BREW'));
    const ctx = await buildCs(broker);
    try {
      const resp = await sendRequest(ctx.socketPath, HAPPY_REQUEST);
      expect(resp.ok).toBe(false);
      expect(resp.code).toBe('invalid_request');
      expect(typeof resp.error).toBe('string');
    } finally {
      await ctx.teardown();
    }
  });

  it('CredBrokerDisabledError from broker → code:"creds_disabled"', async () => {
    const broker = makeStubCredBroker();
    broker.use.mockRejectedValueOnce(new CredBrokerDisabledError('creds broker is disabled'));
    const ctx = await buildCs(broker);
    try {
      const resp = await sendRequest(ctx.socketPath, HAPPY_REQUEST);
      expect(resp.ok).toBe(false);
      expect(resp.code).toBe('creds_disabled');
    } finally {
      await ctx.teardown();
    }
  });

  it('CredsUnavailableError from broker → code:"creds_unavailable"', async () => {
    const broker = makeStubCredBroker();
    broker.use.mockRejectedValueOnce(new CredsUnavailableError('infisical down'));
    const ctx = await buildCs(broker);
    try {
      const resp = await sendRequest(ctx.socketPath, HAPPY_REQUEST);
      expect(resp.ok).toBe(false);
      expect(resp.code).toBe('creds_unavailable');
    } finally {
      await ctx.teardown();
    }
  });

  it('InfisicalNotFoundError from broker → code:"secret_not_found"', async () => {
    const broker = makeStubCredBroker();
    broker.use.mockRejectedValueOnce(new InfisicalNotFoundError('secret not found: github.token'));
    const ctx = await buildCs(broker);
    try {
      const resp = await sendRequest(ctx.socketPath, HAPPY_REQUEST);
      expect(resp.ok).toBe(false);
      expect(resp.code).toBe('secret_not_found');
    } finally {
      await ctx.teardown();
    }
  });

  it('InfisicalAuthError from broker → code:"broker_auth_failed"', async () => {
    const broker = makeStubCredBroker();
    broker.use.mockRejectedValueOnce(new InfisicalAuthError('auth failed: 401'));
    const ctx = await buildCs(broker);
    try {
      const resp = await sendRequest(ctx.socketPath, HAPPY_REQUEST);
      expect(resp.ok).toBe(false);
      expect(resp.code).toBe('broker_auth_failed');
    } finally {
      await ctx.teardown();
    }
  });

  it('InfisicalUpstreamError from broker → code:"broker_upstream"', async () => {
    const broker = makeStubCredBroker();
    broker.use.mockRejectedValueOnce(new InfisicalUpstreamError('network timeout'));
    const ctx = await buildCs(broker);
    try {
      const resp = await sendRequest(ctx.socketPath, HAPPY_REQUEST);
      expect(resp.ok).toBe(false);
      expect(resp.code).toBe('broker_upstream');
    } finally {
      await ctx.teardown();
    }
  });

  it('unknown/generic Error from broker → code:"internal_error"', async () => {
    const broker = makeStubCredBroker();
    broker.use.mockRejectedValueOnce(new Error('something exploded internally'));
    const ctx = await buildCs(broker);
    try {
      const resp = await sendRequest(ctx.socketPath, HAPPY_REQUEST);
      expect(resp.ok).toBe(false);
      expect(resp.code).toBe('internal_error');
    } finally {
      await ctx.teardown();
    }
  });
});

// ─── Test suite 5: no credBroker injected (defensive) ────────────────────────

describe('ControlSocket cred_broker_use — no credBroker injected (defensive)', () => {
  it('returns { ok:false, code:"creds_disabled" } when no credBroker is configured', async () => {
    const sockPath = tmpSocketPath();
    const cs = new ControlSocket({
      socketPath:    sockPath,
      sessionRouter: makeFakeSessionRouter(),
      // credBroker intentionally omitted — defensive guard for misconfigured daemon
      logger:        makeLogger(),
    });
    await cs.start();

    try {
      const resp = await sendRequest(sockPath, HAPPY_REQUEST);
      expect(resp.ok).toBe(false);
      expect(resp.code).toBe('creds_disabled');
      expect(resp.error).toMatch(/not configured/);
    } finally {
      await cs.stop();
      try { fs.rmSync(sockPath, { force: true }); } catch { /* best-effort */ }
    }
  });
});
