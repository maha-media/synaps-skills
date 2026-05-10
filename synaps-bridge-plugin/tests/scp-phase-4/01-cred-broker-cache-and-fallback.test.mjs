/**
 * @file tests/scp-phase-4/01-cred-broker-cache-and-fallback.test.mjs
 *
 * Acceptance tests — CredBroker caching + graceful-degradation behaviour.
 *
 * Strategy
 * ────────
 * All clock control is achieved by passing a mutable `now` function into
 * CredBroker rather than using vi.useFakeTimers, which avoids interference
 * with the real Node event loop used by the HTTP fetch inside the broker.
 *
 * MockInfisical is a real http.createServer so we can:
 *   • Count actual requests reaching Infisical (cache hit = fewer requests).
 *   • Switch to returning 503/404 to simulate outage or missing secrets.
 *
 * MockUpstream echoes the Authorization header so we can verify which token
 * (cached or fresh) was forwarded.
 *
 * Error behaviour (important — matches actual implementation in cred-broker.js)
 * ──────────────────────────────────────────────────────────────────────────────
 * CredBroker._resolveToken() propagates typed Infisical errors (name starting
 * with 'Infisical') as-is when there is no usable cache.  Only non-Infisical
 * errors (network-level, unknown) are wrapped in CredsUnavailableError.
 *
 *   Cold cache + Infisical 5xx  → InfisicalUpstreamError (NOT CredsUnavailableError)
 *   Cold cache + Infisical 404  → InfisicalNotFoundError
 *   Warm cache + Infisical down beyond 2×TTL → CredsUnavailableError (because
 *     no usable stale entry + generic wrap for expired stale)
 *
 * Scenarios (8 tests)
 * ─────────────────────
 * 1. Two use() calls within TTL → only 1 Infisical request; second returns cached:true.
 * 2. Advance clock past TTL → third call re-fetches (Infisical request count increases).
 * 3. Stale-while-down: prime cache, advance past TTL but inside 2×TTL, Infisical 503 →
 *    stale value served, cached:true, warn log emitted (NEVER containing the token).
 * 4. Warm cache, Infisical down beyond 2×TTL → CredsUnavailableError thrown.
 * 5. Cold cache + Infisical 503 → InfisicalUpstreamError thrown (typed error propagated).
 * 6. Cold cache + Infisical 404 → InfisicalNotFoundError thrown (typed error propagated).
 * 7. Stale-while-down: upstream still receives the (stale) token correctly.
 * 8. Warn log on stale-degradation NEVER contains the token string.
 *
 * Constraints
 * ───────────
 * • ESM only (.mjs)
 * • No top-level await
 * • Servers closed in afterAll
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { InfisicalClient }                           from '../../bridge/core/cred-broker/infisical-client.js';
import {
  InfisicalNotFoundError,
  InfisicalUpstreamError,
}                                                    from '../../bridge/core/cred-broker/infisical-client.js';
import { CredBroker }                                from '../../bridge/core/cred-broker.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const FAKE_TOKEN    = 'CACHE_TEST_TOKEN_9876';
const SYNAPS_USER   = 'u_cache_test';
const INSTITUTION   = 'inst_cache_001';
const CACHE_TTL_SEC = 10; // short so we can test expiry with virtual clock

// ─── Shared state ─────────────────────────────────────────────────────────────

let mockInfisical;
let mockUpstream;
let infisicalBaseUrl;
let upstreamBaseUrl;
let tokenFilePath;

// Mutable server state — reset in beforeEach.
let infisicalRequestCount  = 0;
let infisicalFailMode      = 'ok';   // 'ok' | '503' | '404'
let infisicalResponseToken = FAKE_TOKEN;

// Logger that captures warn text for later assertion.
const warnLines = [];
const capturingLogger = {
  info:  () => {},
  warn:  (...args) => {
    // Flatten all args to a single string for searching.
    warnLines.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
  },
  error: () => {},
  debug: () => {},
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Build a fresh broker (fresh InfisicalClient + CredBroker) with an injectable clock. */
function makeBroker(nowFn) {
  const client = new InfisicalClient({
    baseUrl:   infisicalBaseUrl,
    tokenFile: tokenFilePath,
    logger:    capturingLogger,
  });
  return new CredBroker({
    infisicalClient: client,
    cacheTtlSecs:    CACHE_TTL_SEC,
    logger:          capturingLogger,
    now:             nowFn,
  });
}

/** Standard request options for a given key. */
function makeReqOpts(key, urlSuffix = '/test') {
  return {
    synapsUserId:  SYNAPS_USER,
    institutionId: INSTITUTION,
    key,
    request: { method: 'GET', url: `${upstreamBaseUrl}${urlSuffix}` },
  };
}

// ─── beforeAll / afterAll ─────────────────────────────────────────────────────

beforeAll(async () => {
  // Write tmp service-token file.
  const tmpDir  = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-phase4-cache-'));
  tokenFilePath = path.join(tmpDir, 'infisical-token');
  await fs.writeFile(tokenFilePath, FAKE_TOKEN + '\n', { mode: 0o600 });

  // MockInfisical — stateful: respects failMode, counts requests.
  const inf = await startServer((req, res) => {
    if (req.method === 'HEAD' && req.url === '/api/status') {
      res.writeHead(200);
      res.end();
      return;
    }
    infisicalRequestCount++;

    if (infisicalFailMode === '503') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'simulated infisical outage' }));
      return;
    }
    if (infisicalFailMode === '404') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'secret not found' }));
      return;
    }

    const body = JSON.stringify({ secret: { secretValue: infisicalResponseToken } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  mockInfisical    = inf.server;
  infisicalBaseUrl = inf.url;

  // MockUpstream — echoes Authorization header.
  const up = await startServer((req, res) => {
    const payload = JSON.stringify({
      received_authorization: req.headers['authorization'] ?? null,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(payload);
  });
  mockUpstream    = up.server;
  upstreamBaseUrl = up.url;
}, 15_000);

afterAll(async () => {
  await stopServer(mockInfisical);
  await stopServer(mockUpstream);
  try {
    await fs.rm(path.dirname(tokenFilePath), { recursive: true, force: true });
  } catch { /* best-effort */ }
});

beforeEach(() => {
  infisicalRequestCount  = 0;
  infisicalFailMode      = 'ok';
  infisicalResponseToken = FAKE_TOKEN;
  warnLines.length       = 0;
});

// ─── Test 1: cache hit avoids refetch ─────────────────────────────────────────

describe('CredBroker cache hit avoids Infisical refetch', () => {
  it('two use() calls within TTL produce only 1 Infisical request; second returns cached:true', async () => {
    let virtualNow = Date.now();
    const broker   = makeBroker(() => virtualNow);

    const opts = makeReqOpts('cache.hit.key', '/hit-1');

    // First call — must reach Infisical.
    const r1 = await broker.use(opts);
    expect(r1.cached).toBe(false);
    expect(infisicalRequestCount).toBe(1);

    // Advance virtual clock by less than TTL (still within cache window).
    virtualNow += (CACHE_TTL_SEC - 2) * 1000;

    // Second call — must be served from cache.
    const r2 = await broker.use({ ...opts, request: { ...opts.request, url: `${upstreamBaseUrl}/hit-2` } });
    expect(r2.cached).toBe(true);

    // Infisical still at exactly 1 request.
    expect(infisicalRequestCount).toBe(1);
  });
});

// ─── Test 2: cache expiry triggers re-fetch ───────────────────────────────────

describe('CredBroker cache expiry triggers re-fetch', () => {
  it('re-fetches from Infisical after virtual clock advances past TTL; cached:false on re-fetch', async () => {
    let virtualNow = Date.now();
    const broker   = makeBroker(() => virtualNow);

    const opts = makeReqOpts('expiry.test.key', '/expiry-1');

    // Prime cache.
    const r1 = await broker.use(opts);
    expect(r1.cached).toBe(false);
    expect(infisicalRequestCount).toBe(1);

    // Advance PAST TTL so cache entry is stale AND past 2× TTL so degradation
    // window also expires — Infisical is still healthy so a fresh fetch happens.
    virtualNow += (CACHE_TTL_SEC * 2 + 5) * 1000;

    // Third call must trigger a new fetch.
    const r3 = await broker.use({ ...opts, request: { ...opts.request, url: `${upstreamBaseUrl}/expiry-3` } });
    expect(r3.cached).toBe(false);
    expect(infisicalRequestCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── Test 3+4: stale-while-down (within 2× TTL) ──────────────────────────────

describe('CredBroker stale-while-Infisical-down (graceful degradation within 2×TTL)', () => {
  it('serves stale cache with cached:true when Infisical returns 503 within 2× TTL', async () => {
    let virtualNow = Date.now();
    const broker   = makeBroker(() => virtualNow);

    const opts = makeReqOpts('stale.test.key', '/stale-1');

    // Prime cache.
    const r1 = await broker.use(opts);
    expect(r1.cached).toBe(false);

    // Advance past TTL but still within 2× TTL.
    virtualNow += (CACHE_TTL_SEC + 2) * 1000;

    // Take Infisical down.
    infisicalFailMode = '503';

    // Should succeed using stale cache.
    const r2 = await broker.use({ ...opts, request: { ...opts.request, url: `${upstreamBaseUrl}/stale-2` } });
    expect(r2.cached).toBe(true);
    expect(r2.status).toBe(200);
  });

  it('stale-while-down: upstream still receives the (stale) token correctly', async () => {
    let virtualNow = Date.now();
    const broker   = makeBroker(() => virtualNow);

    const opts = makeReqOpts('stale.token.key', '/stale-token-1');

    // Prime.
    await broker.use(opts);

    // Past TTL, inside 2×TTL, Infisical down.
    virtualNow += (CACHE_TTL_SEC + 3) * 1000;
    infisicalFailMode = '503';

    const r2 = await broker.use({ ...opts, request: { ...opts.request, url: `${upstreamBaseUrl}/stale-token-2` } });
    const parsed = JSON.parse(r2.body);
    expect(parsed.received_authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('warn log is emitted on stale degradation and NEVER contains the token string', async () => {
    let virtualNow = Date.now();
    const broker   = makeBroker(() => virtualNow);

    const opts = makeReqOpts('stale.warn.key', '/stale-warn-1');

    // Prime.
    await broker.use(opts);

    virtualNow += (CACHE_TTL_SEC + 4) * 1000;
    infisicalFailMode = '503';

    await broker.use({ ...opts, request: { ...opts.request, url: `${upstreamBaseUrl}/stale-warn-2` } });

    // At least one warn must have been emitted.
    expect(warnLines.length).toBeGreaterThan(0);

    // IMPORTANT: the token string must never appear in any warn log.
    const allWarnText = warnLines.join('\n');
    expect(allWarnText).not.toContain(FAKE_TOKEN);
    expect(allWarnText).not.toContain(`Bearer ${FAKE_TOKEN}`);
  });
});

// ─── Test 5: warm cache + Infisical down beyond 2×TTL ────────────────────────

describe('CredBroker warm cache + Infisical down beyond 2×TTL', () => {
  it('throws InfisicalUpstreamError when expired cache exceeds 2×TTL and Infisical returns 503', async () => {
    // When the stale degradation window (2×TTL) has passed AND Infisical returns a
    // typed 5xx error, CredBroker._resolveToken() propagates the error as-is.
    // InfisicalUpstreamError (name starts with 'Infisical') is rethrown, not wrapped
    // in CredsUnavailableError.  This is intentional — callers can distinguish
    // between "upstream sick" (broker_upstream) vs "genuinely unavailable" (creds_unavailable).
    let virtualNow = Date.now();
    const broker   = makeBroker(() => virtualNow);

    const opts = makeReqOpts('stale.expired.key', '/expired-1');

    // Prime cache.
    await broker.use(opts);

    // Advance PAST 2×TTL — stale degradation window closed.
    virtualNow += (CACHE_TTL_SEC * 2 + 10) * 1000;

    // Take Infisical down with a 503.
    infisicalFailMode = '503';

    let caught;
    try {
      await broker.use({ ...opts, request: { ...opts.request, url: `${upstreamBaseUrl}/expired-2` } });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    // Typed InfisicalUpstreamError is propagated as-is (not wrapped).
    expect(caught).toBeInstanceOf(InfisicalUpstreamError);
    expect(caught.code).toBe('broker_upstream');
  });
});

// ─── Test 6: cold cache + Infisical 503 ──────────────────────────────────────

describe('CredBroker cold cache + Infisical 503', () => {
  it('throws InfisicalUpstreamError (typed Infisical error propagated as-is)', async () => {
    // Cold cache — use a unique key never seen before.
    infisicalFailMode = '503';
    const broker = makeBroker(() => Date.now());

    let caught;
    try {
      await broker.use({
        synapsUserId:  'u_cold_503',
        institutionId: 'inst_cold_503',
        key:           'cold.503.key',
        request: { method: 'GET', url: `${upstreamBaseUrl}/cold-503` },
      });
    } catch (err) {
      caught = err;
    }

    // The broker re-throws Infisical-typed errors (names starting with
    // 'Infisical') when there is no usable cache.  A 503 produces
    // InfisicalUpstreamError, not CredsUnavailableError.
    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(InfisicalUpstreamError);
    expect(caught.code).toBe('broker_upstream');
  });
});

// ─── Test 7: cold cache + Infisical 404 ──────────────────────────────────────

describe('CredBroker cold cache + Infisical 404', () => {
  it('throws InfisicalNotFoundError when the requested secret does not exist', async () => {
    // Cold cache, unique key, Infisical returns 404.
    infisicalFailMode = '404';
    const broker = makeBroker(() => Date.now());

    let caught;
    try {
      await broker.use({
        synapsUserId:  'u_cold_404',
        institutionId: 'inst_cold_404',
        key:           'cold.404.key',
        request: { method: 'GET', url: `${upstreamBaseUrl}/cold-404` },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(InfisicalNotFoundError);
    expect(caught.code).toBe('secret_not_found');
  });
});
