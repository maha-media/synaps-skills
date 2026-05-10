/**
 * @file tests/scp-phase-8/00-rate-limit-token-bucket.test.mjs
 *
 * Acceptance test — Track 1: Rate Limiting
 *
 * Tests:
 *  1. Token-bucket drains: after `capacity` requests, next one is blocked (429).
 *  2. 429 response carries Retry-After header (seconds, ceiling).
 *  3. Response body has error.data.scope = 'token'.
 *  4. After simulated refill (mock clock), bucket allows requests again.
 *  5. Per-IP limiting is independent of per-token.
 *  6. McpRateLimiter.check() with null tokenHash skips token dimension.
 *  7. McpRateLimiter.check() with null ip skips ip dimension.
 *
 * Uses McpRateLimiter directly (unit-level) PLUS an in-process HTTP harness
 * (ScpHttpServer + McpServer) to verify the Retry-After HTTP header is set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { McpRateLimiter } from '../../bridge/core/mcp/mcp-rate-limiter.js';
import { McpServer, MCP_ERROR_CODES } from '../../bridge/core/mcp/mcp-server.js';
import { ScpHttpServer } from '../../bridge/core/scp-http-server.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

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

function post(port, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/mcp/v1', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...extraHeaders } },
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
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

const RPC_BODY = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } };

// ─── Unit-level bucket tests ──────────────────────────────────────────────────

describe('McpRateLimiter — token bucket drain', () => {
  it('allows exactly `capacity` requests, then blocks on the next', () => {
    const CAPACITY = 5;
    let t = 0;
    const rl = new McpRateLimiter({
      perToken: { capacity: CAPACITY, refillPerSec: 1 },
      perIp:    { capacity: 1000, refillPerSec: 100 },
      now: () => t,
    });

    // First CAPACITY requests should be allowed.
    for (let i = 0; i < CAPACITY; i++) {
      const result = rl.check({ tokenHash: 'tok1', ip: '1.2.3.4' });
      expect(result.allowed).toBe(true);
    }

    // Next request must be blocked.
    const blocked = rl.check({ tokenHash: 'tok1', ip: '1.2.3.4' });
    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe('token');
    expect(typeof blocked.retryAfterMs).toBe('number');
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('refill restores allowance after waiting (injectable clock)', () => {
    let t = 0;
    const rl = new McpRateLimiter({
      perToken: { capacity: 3, refillPerSec: 3 },   // 3 tokens/sec → 1 per 333ms
      perIp:    { capacity: 1000, refillPerSec: 100 },
      now: () => t,
    });

    // Drain all 3 tokens.
    for (let i = 0; i < 3; i++) rl.check({ tokenHash: 'tok2', ip: '1.0.0.1' });

    // Blocked right now.
    expect(rl.check({ tokenHash: 'tok2', ip: '1.0.0.1' }).allowed).toBe(false);

    // Advance clock by 1 second → 3 tokens refilled.
    t = 1_000;
    expect(rl.check({ tokenHash: 'tok2', ip: '1.0.0.1' }).allowed).toBe(true);
  });

  it('per-IP blocking is independent of per-token', () => {
    let t = 0;
    const rl = new McpRateLimiter({
      perToken: { capacity: 100, refillPerSec: 10 },
      perIp:    { capacity: 2, refillPerSec: 1 },
      now: () => t,
    });

    // Two requests from same IP (different tokens) drain the IP bucket.
    rl.check({ tokenHash: 'tokA', ip: '9.9.9.9' });
    rl.check({ tokenHash: 'tokB', ip: '9.9.9.9' });

    const blocked = rl.check({ tokenHash: 'tokC', ip: '9.9.9.9' });
    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe('ip');

    // Different IP is NOT blocked.
    const allowed = rl.check({ tokenHash: 'tokC', ip: '8.8.8.8' });
    expect(allowed.allowed).toBe(true);
  });

  it('null tokenHash skips token dimension; null ip skips ip dimension', () => {
    let t = 0;
    const rl = new McpRateLimiter({
      perToken: { capacity: 1, refillPerSec: 1 },
      perIp:    { capacity: 1, refillPerSec: 1 },
      now: () => t,
    });

    // With no tokenHash and no ip, both dimensions are skipped → always allowed.
    for (let i = 0; i < 10; i++) {
      const r = rl.check({ tokenHash: null, ip: null });
      expect(r.allowed).toBe(true);
    }
  });
});

// ─── HTTP harness — Retry-After header ───────────────────────────────────────

describe('ScpHttpServer + McpRateLimiter — 429 Retry-After header', () => {
  let srv, port;

  beforeAll(async () => {
    // Build a rate limiter with capacity=1 so the second request is blocked.
    const rateLimiter = new McpRateLimiter({
      perToken: { capacity: 1, refillPerSec: 1 },
      perIp:    { capacity: 1000, refillPerSec: 100 },
    });

    const tokenResolver = {
      resolve: async () => ({ synaps_user_id: 'u1', institution_id: 'i1', token_id: 't1' }),
    };
    const toolRegistry  = { listTools: async () => [], callTool: async () => ({ content: [], isError: false }) };
    const approvalGate  = { filterTools: async (t) => t, isToolAllowed: async () => true };

    const mcpServer = new McpServer({ tokenResolver, toolRegistry, approvalGate, rateLimiter, logger: silent });

    srv = new ScpHttpServer({
      config: makeConfig(), vncProxy: makeVncProxy(), mcpServer, logger: silent,
    });
    const r = await srv.start();
    port = r.port;
  });

  afterAll(async () => { await srv.stop(); });

  it('first request (within capacity) → 200', async () => {
    const { statusCode } = await post(port, RPC_BODY, { 'mcp-token': 'tok1' });
    expect(statusCode).toBe(200);
  });

  it('second request (over capacity) → 429 + Retry-After header', async () => {
    const { statusCode, headers, body } = await post(port, RPC_BODY, { 'mcp-token': 'tok1' });
    expect(statusCode).toBe(429);
    expect(body.error.code).toBe(MCP_ERROR_CODES.RATE_LIMITED);
    expect(body.error.data.scope).toBe('token');
    // Retry-After must be a valid positive integer string.
    const retryAfter = parseInt(headers['retry-after'], 10);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });
});
