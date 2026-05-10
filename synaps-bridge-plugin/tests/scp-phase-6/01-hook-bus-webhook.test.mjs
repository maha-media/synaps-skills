/**
 * @file tests/scp-phase-6/01-hook-bus-webhook.test.mjs
 *
 * HookBus webhook acceptance tests.
 *
 * Strategy
 * ────────
 * • HookBus validates that webhook URLs use HTTPS.  In test, we bypass this by
 *   injecting a custom `fetch` that records the outbound request and returns a
 *   controlled response — so we test the full dispatch path (HMAC signing,
 *   body shape, headers, block propagation, timeout) without needing a real
 *   TLS server.
 * • For HMAC tests we compute the expected signature independently using the
 *   same `crypto.createHmac` algorithm and compare with the header.
 * • Timeout is tested by injecting a fetch that delays past the bus timeout.
 * • block:true propagation is tested by having the mock fetch return { block: true }.
 *
 * ≥ 6 tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

import { HookBus, NoopHookBus } from '../../bridge/core/hook-bus.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const silent = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

/** Compute expected HMAC sha256 hex for a body string and secret. */
function computeHmac(secret, bodyStr) {
  return createHmac('sha256', secret).update(bodyStr).digest('hex');
}

/** Build a Response-like object that fetch resolves to. */
function makeFakeResponse({ status = 200, body = '{}' } = {}) {
  return {
    status,
    text: async () => body,
    headers: { get: () => null },
  };
}

/** Build a HookBus with an injectable fetch and a static hook list. */
function makeBus({ hooks = [], fetch: fetchImpl, timeoutMs = 2000, logger } = {}) {
  const repo = { listByEvent: vi.fn(async () => hooks) };
  return new HookBus({
    repo,
    fetch: fetchImpl ?? (async () => makeFakeResponse()),
    timeoutMs,
    logger: logger ?? silent,
  });
}

/** Build a single webhook hook with an https:// URL (required by HookBus validator). */
function makeHook({ id = 'hook-1', event = 'pre_tool', secret = 'test-secret', scope = { type: 'global' } } = {}) {
  return {
    _id: id,
    scope,
    event,
    matcher: {},
    action: {
      type: 'webhook',
      config: {
        url: 'https://example.com/hook',
        secret,
      },
    },
    enabled: true,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// ── 1. Happy path single hook fires ───────────────────────────────────────────

describe('HookBus — happy path single webhook fires', () => {
  it('emits pre_tool event — returns fired:1, ok:true result', async () => {
    const captured = [];
    const fetch = vi.fn(async (url, opts) => {
      captured.push({ url, opts, body: JSON.parse(opts.body) });
      return makeFakeResponse();
    });

    const hook = makeHook();
    const bus  = makeBus({ hooks: [hook], fetch });

    const result = await bus.emit('pre_tool', { tool: 'bash', args: ['ls'] });

    expect(result.fired).toBe(1);
    expect(result.blocked).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].ok).toBe(true);

    // Verify body shape.
    const req = captured[0];
    expect(req.body).toMatchObject({
      event:   'pre_tool',
      payload: { tool: 'bash', args: ['ls'] },
    });
    expect(typeof req.body.ts).toBe('string');
  });
});

// ── 2. HMAC signature header is correct ───────────────────────────────────────

describe('HookBus — HMAC signature', () => {
  it('X-Synaps-Signature header is sha256=<hex> of the body', async () => {
    const secret  = 'signing-secret-123';
    const capturedHeaders = {};
    let capturedBody = '';

    const fetch = vi.fn(async (url, opts) => {
      Object.assign(capturedHeaders, opts.headers);
      capturedBody = opts.body;
      return makeFakeResponse();
    });

    const hook = makeHook({ secret });
    const bus  = makeBus({ hooks: [hook], fetch });

    await bus.emit('post_tool', { tool: 'bash', result: 'ok' });

    const sigHeader = capturedHeaders['X-Synaps-Signature'];
    expect(sigHeader).toMatch(/^sha256=/);

    const expectedSig = `sha256=${computeHmac(secret, capturedBody)}`;
    expect(sigHeader).toBe(expectedSig);
  });
});

// ── 3. Content-Type header ─────────────────────────────────────────────────────

describe('HookBus — Content-Type header', () => {
  it('sends Content-Type: application/json', async () => {
    let receivedContentType = '';
    const fetch = vi.fn(async (url, opts) => {
      receivedContentType = opts.headers['Content-Type'];
      return makeFakeResponse();
    });

    const bus = makeBus({ hooks: [makeHook()], fetch });
    await bus.emit('pre_tool', {});

    expect(receivedContentType).toMatch(/application\/json/);
  });
});

// ── 4. Timeout aborts dispatch ─────────────────────────────────────────────────

describe('HookBus — timeout aborts dispatch', () => {
  it('returns { ok: false, error: "timeout" } when fetch never resolves in time', async () => {
    // A fetch that hangs indefinitely.
    const hangingFetch = vi.fn(() => new Promise(() => {}));

    const hook = makeHook({ id: 'hook-timeout' });
    const bus  = makeBus({ hooks: [hook], fetch: hangingFetch, timeoutMs: 50 });

    const result = await bus.emit('pre_tool', {});

    expect(result.fired).toBe(1);
    const hookResult = result.results[0];
    expect(hookResult.ok).toBe(false);
    expect(hookResult.error).toBe('timeout');
  });
});

// ── 5. block:true propagation ─────────────────────────────────────────────────

describe('HookBus — block:true propagation', () => {
  it('aggregate blocked:true when server returns { block: true }', async () => {
    const fetch = vi.fn(async () => makeFakeResponse({ body: JSON.stringify({ block: true }) }));

    const hook = makeHook({ id: 'hook-block' });
    const bus  = makeBus({ hooks: [hook], fetch });

    const result = await bus.emit('pre_tool', {});

    expect(result.blocked).toBe(true);
    const hookResult = result.results.find(r => r.hookId === 'hook-block');
    expect(hookResult).toBeDefined();
    expect(hookResult.blocked).toBe(true);
  });
});

// ── 6. Non-2xx response ────────────────────────────────────────────────────────

describe('HookBus — non-2xx response', () => {
  it('returns { ok: false, error: "HTTP 500" } on server error', async () => {
    const fetch = vi.fn(async () => makeFakeResponse({ status: 500 }));

    const hook = makeHook({ id: 'hook-500', event: 'on_error' });
    const bus  = makeBus({ hooks: [hook], fetch });

    const result = await bus.emit('on_error', {});

    const hookResult = result.results.find(r => r.hookId === 'hook-500');
    expect(hookResult.ok).toBe(false);
    expect(hookResult.error).toMatch(/500/);
  });
});

// ── 7. NoopHookBus always returns empty summary ────────────────────────────────

describe('NoopHookBus — always returns empty summary', () => {
  it('emit() returns { fired:0, blocked:false, results:[] }', async () => {
    const noop   = new NoopHookBus();
    const result = await noop.emit('pre_tool', { tool: 'bash' });
    expect(result).toEqual({ fired: 0, blocked: false, results: [] });
  });
});

// ── 8. Multiple hooks dispatched in parallel ───────────────────────────────────

describe('HookBus — parallel dispatch of multiple hooks', () => {
  it('fires all matching hooks and returns results for each', async () => {
    const calls = [];
    const fetch = vi.fn(async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return makeFakeResponse();
    });

    const hooks = [
      makeHook({ id: 'hook-A', secret: 's1' }),
      makeHook({ id: 'hook-B', secret: 's2' }),
    ];

    const bus = makeBus({ hooks, fetch });
    const result = await bus.emit('pre_tool', { tool: 'bash' });

    expect(result.fired).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results.every(r => r.ok === true)).toBe(true);

    // Both hooks called.
    expect(calls).toHaveLength(2);
    expect(calls.every(b => b.event === 'pre_tool')).toBe(true);
  });
});

// ── 9. Secret never appears in logger calls ────────────────────────────────────

describe('HookBus — secrets never appear in logs', () => {
  it('action.config.secret is never logged', async () => {
    const SECRET = 'TOP-SECRET-WEBHOOK-KEY';
    const loggedMessages = [];
    const spyLogger = {
      info:  (...args) => loggedMessages.push(JSON.stringify(args)),
      warn:  (...args) => loggedMessages.push(JSON.stringify(args)),
      debug: (...args) => loggedMessages.push(JSON.stringify(args)),
      error: (...args) => loggedMessages.push(JSON.stringify(args)),
    };

    const fetch = vi.fn(async () => makeFakeResponse());
    const hook  = makeHook({ secret: SECRET });
    const bus   = makeBus({ hooks: [hook], fetch, logger: spyLogger });

    await bus.emit('pre_tool', {});

    const allLogs = loggedMessages.join('\n');
    expect(allLogs).not.toContain(SECRET);
  });
});
