/**
 * @file bridge/core/hook-bus.test.js
 *
 * Tests for HookBus and NoopHookBus.
 *
 * All I/O is injected via vi.fn() — no real network, no real repo.
 * HMAC assertions use real Node crypto to verify correctness.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  HookBus,
  NoopHookBus,
  HookValidationError,
  HookDispatchError,
} from './hook-bus.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Compute the expected HMAC for a given body string + secret. */
function computeHmac(secret, bodyStr) {
  return createHmac('sha256', secret).update(bodyStr).digest('hex');
}

/** Build a fake logger with spy methods. */
function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Collect all logged text from a logger. */
function allLoggedText(logger) {
  const calls = [
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
    ...logger.debug.mock.calls,
  ];
  return calls.map(args => JSON.stringify(args)).join('\n');
}

/** Build a fake fetch response. */
function makeResponse({ status = 200, body = '{"ok":true}', headers = {} } = {}) {
  return {
    status,
    headers: new Map(Object.entries(headers)),
    text: vi.fn().mockResolvedValue(body),
  };
}

/** Build a minimal valid hook. */
function makeHook(overrides = {}) {
  return {
    _id: 'hook-1',
    scope: { type: 'global', id: null },
    event: 'pre_tool',
    matcher: {},
    action: {
      type: 'webhook',
      config: {
        url: 'https://example.com/hook',
        secret: 'super-secret-key',
        timeout_ms: 5000,
      },
    },
    enabled: true,
    ...overrides,
  };
}

/** Build a minimal stub repo. */
function makeRepo(hooks = []) {
  return {
    listByEvent: vi.fn().mockResolvedValue(hooks),
  };
}

/** Build a HookBus with injectable deps and sensible defaults. */
function makeBus({
  hooks = [],
  fetchImpl,
  logger: loggerOpt,
  timeoutMs = 5000,
  setTimeoutImpl,
  clearTimeoutImpl,
  nowImpl,
  repoOverride,
} = {}) {
  const repo = repoOverride ?? makeRepo(hooks);
  const logger = loggerOpt ?? makeLogger();
  const fetchFn = fetchImpl ?? vi.fn().mockResolvedValue(makeResponse());
  const setTimeoutFn = setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = clearTimeoutImpl ?? ((id) => clearTimeout(id));
  const now = nowImpl ?? (() => '2024-01-01T00:00:00.000Z');

  const bus = new HookBus({
    repo,
    fetch: fetchFn,
    timeoutMs,
    logger,
    now,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
  });

  return { bus, repo, logger, fetchFn };
}

// ─── NoopHookBus ─────────────────────────────────────────────────────────────

describe('NoopHookBus', () => {
  it('emit() resolves to { fired: 0, blocked: false, results: [] }', async () => {
    const noop = new NoopHookBus();
    const result = await noop.emit('pre_tool', { tool: 'bash' }, null);
    expect(result).toEqual({ fired: 0, blocked: false, results: [] });
  });

  it('emit() ignores all arguments and always returns empty summary', async () => {
    const noop = new NoopHookBus();
    const r1 = await noop.emit('post_tool', { data: 'x' }, { type: 'user', id: 'u1' });
    const r2 = await noop.emit('on_error', {}, null);
    expect(r1).toEqual({ fired: 0, blocked: false, results: [] });
    expect(r2).toEqual({ fired: 0, blocked: false, results: [] });
  });
});

// ─── Constructor validation ───────────────────────────────────────────────────

describe('HookBus constructor', () => {
  it('throws TypeError when repo is missing', () => {
    expect(() => new HookBus({})).toThrow(TypeError);
  });

  it('constructs successfully with minimal valid args', () => {
    const repo = makeRepo();
    expect(() => new HookBus({ repo })).not.toThrow();
  });
});

// ─── emit() — validation ──────────────────────────────────────────────────────

describe('HookBus.emit() — event validation', () => {
  it('throws HookValidationError for unknown event name', async () => {
    const { bus } = makeBus();
    await expect(bus.emit('unknown_event', {})).rejects.toThrow(HookValidationError);
  });

  it('HookValidationError has code "invalid_request"', async () => {
    const { bus } = makeBus();
    const err = await bus.emit('bad_event', {}).catch(e => e);
    expect(err.code).toBe('invalid_request');
    expect(err.name).toBe('HookValidationError');
  });

  it('accepts all valid lifecycle event names', async () => {
    const valid = ['pre_tool', 'post_tool', 'pre_stream', 'post_stream', 'on_error'];
    for (const event of valid) {
      const { bus } = makeBus({ hooks: [] });
      const result = await bus.emit(event, {});
      expect(result.fired).toBe(0);
    }
  });
});

// ─── emit() — happy path ──────────────────────────────────────────────────────

describe('HookBus.emit() — happy path single hook', () => {
  it('fires a single hook and returns fired=1', async () => {
    const hook = makeHook();
    const { bus } = makeBus({ hooks: [hook] });
    const result = await bus.emit('pre_tool', { tool: 'bash' }, null);
    expect(result.fired).toBe(1);
    expect(result.blocked).toBe(false);
    expect(result.results).toHaveLength(1);
  });

  it('result entry has ok:true and correct hookId on 2xx response', async () => {
    const hook = makeHook({ _id: 'abc123' });
    const { bus } = makeBus({ hooks: [hook] });
    const result = await bus.emit('pre_tool', {});
    expect(result.results[0].hookId).toBe('abc123');
    expect(result.results[0].ok).toBe(true);
    expect(result.results[0].status).toBe(200);
  });

  it('fetch is called with correct URL and POST method', async () => {
    const hook = makeHook({ _id: 'h1' });
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({ hooks: [hook], fetchImpl: fetchFn });
    await bus.emit('pre_tool', {});
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');
  });

  it('Content-Type header is application/json', async () => {
    const hook = makeHook();
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({ hooks: [hook], fetchImpl: fetchFn });
    await bus.emit('pre_tool', {});
    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('body contains event, payload, scope, ts fields', async () => {
    const hook = makeHook();
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({
      hooks: [hook],
      fetchImpl: fetchFn,
      nowImpl: () => '2024-06-01T12:00:00.000Z',
    });
    const scope = { type: 'user', id: 'u1' };
    await bus.emit('pre_tool', { tool: 'bash', args: ['ls'] }, scope);
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.event).toBe('pre_tool');
    expect(body.payload).toEqual({ tool: 'bash', args: ['ls'] });
    expect(body.scope).toEqual(scope);
    expect(body.ts).toBe('2024-06-01T12:00:00.000Z');
  });
});

// ─── emit() — HMAC signature ──────────────────────────────────────────────────

describe('HookBus.emit() — HMAC signature', () => {
  it('X-Synaps-Signature header is present and starts with "sha256="', async () => {
    const hook = makeHook();
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({ hooks: [hook], fetchImpl: fetchFn });
    await bus.emit('pre_tool', {});
    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers['X-Synaps-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('HMAC matches computed sha256 of the JSON body with the secret', async () => {
    const secret = 'my-secret-key-123';
    const hook = makeHook({ action: { type: 'webhook', config: { url: 'https://hook.io/recv', secret } } });
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const ts = '2024-06-15T10:00:00.000Z';
    const { bus } = makeBus({
      hooks: [hook],
      fetchImpl: fetchFn,
      nowImpl: () => ts,
    });

    const payload = { tool: 'read_file', args: ['/tmp/x'] };
    const scope = null;
    await bus.emit('pre_tool', payload, scope);

    const [, init] = fetchFn.mock.calls[0];
    const sentBody = init.body;
    const expectedHex = computeHmac(secret, sentBody);
    expect(init.headers['X-Synaps-Signature']).toBe(`sha256=${expectedHex}`);
  });

  it('different secrets produce different signatures', async () => {
    const hook1 = makeHook({ _id: 'h1', action: { type: 'webhook', config: { url: 'https://a.io/h', secret: 'secret-A' } } });
    const hook2 = makeHook({ _id: 'h2', action: { type: 'webhook', config: { url: 'https://b.io/h', secret: 'secret-B' } } });

    const sigs = [];
    const fetchFn = vi.fn().mockImplementation(async (_url, init) => {
      sigs.push(init.headers['X-Synaps-Signature']);
      return makeResponse();
    });

    const { bus } = makeBus({ hooks: [hook1, hook2], fetchImpl: fetchFn });
    await bus.emit('pre_tool', {});
    expect(sigs).toHaveLength(2);
    expect(sigs[0]).not.toBe(sigs[1]);
  });
});

// ─── emit() — many hooks parallel ─────────────────────────────────────────────

describe('HookBus.emit() — many hooks parallel', () => {
  it('fires multiple hooks and returns results for each', async () => {
    const hooks = [
      makeHook({ _id: 'h1' }),
      makeHook({ _id: 'h2' }),
      makeHook({ _id: 'h3' }),
    ];
    const { bus } = makeBus({ hooks });
    const result = await bus.emit('pre_tool', {});
    expect(result.fired).toBe(3);
    expect(result.results).toHaveLength(3);
    expect(result.results.map(r => r.hookId).sort()).toEqual(['h1', 'h2', 'h3']);
  });

  it('all hooks are called concurrently (fetch called N times)', async () => {
    const hooks = [makeHook({ _id: 'a' }), makeHook({ _id: 'b' })];
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({ hooks, fetchImpl: fetchFn });
    await bus.emit('post_tool', {});
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('one hook failure does not prevent others from firing (Promise.allSettled)', async () => {
    const hooks = [makeHook({ _id: 'good' }), makeHook({ _id: 'bad' })];
    let callCount = 0;
    const fetchFn = vi.fn().mockImplementation(async (url) => {
      callCount++;
      if (callCount === 1) throw new Error('network error');
      return makeResponse();
    });
    const { bus } = makeBus({ hooks, fetchImpl: fetchFn });
    const result = await bus.emit('pre_tool', {});
    expect(result.fired).toBe(2);
    expect(result.results).toHaveLength(2);
    // One ok, one error
    const okCount = result.results.filter(r => r.ok === true).length;
    const errCount = result.results.filter(r => r.ok === false).length;
    expect(okCount).toBe(1);
    expect(errCount).toBe(1);
  });
});

// ─── emit() — non-2xx response ────────────────────────────────────────────────

describe('HookBus.emit() — non-2xx responses', () => {
  it('500 response sets ok:false and status:500', async () => {
    const hook = makeHook({ _id: 'h-500' });
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 500, body: '{"error":"internal"}' }));
    const { bus } = makeBus({ hooks: [hook], fetchImpl: fetchFn });
    const result = await bus.emit('pre_tool', {});
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].status).toBe(500);
  });

  it('404 response sets ok:false and status:404', async () => {
    const hook = makeHook({ _id: 'h-404' });
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 404, body: 'Not Found' }));
    const { bus } = makeBus({ hooks: [hook], fetchImpl: fetchFn });
    const result = await bus.emit('post_tool', {});
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].status).toBe(404);
  });

  it('201 response is treated as ok:true', async () => {
    const hook = makeHook({ _id: 'h-201' });
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 201, body: '{}' }));
    const { bus } = makeBus({ hooks: [hook], fetchImpl: fetchFn });
    const result = await bus.emit('pre_tool', {});
    expect(result.results[0].ok).toBe(true);
    expect(result.results[0].status).toBe(201);
  });
});

// ─── emit() — block:true propagation ─────────────────────────────────────────

describe('HookBus.emit() — block:true propagation', () => {
  it('blocked:true in summary when hook response body has block:true', async () => {
    const hook = makeHook({ _id: 'blocker' });
    const fetchFn = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: '{"block":true}' }),
    );
    const { bus } = makeBus({ hooks: [hook], fetchImpl: fetchFn });
    const result = await bus.emit('pre_tool', { tool: 'bash' });
    expect(result.blocked).toBe(true);
    expect(result.results[0].blocked).toBe(true);
  });

  it('blocked:false in summary when no hook sets block:true', async () => {
    const hook = makeHook();
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, body: '{"ok":true}' }));
    const { bus } = makeBus({ hooks: [hook], fetchImpl: fetchFn });
    const result = await bus.emit('pre_tool', {});
    expect(result.blocked).toBe(false);
  });

  it('one blocking hook among many causes summary blocked:true', async () => {
    const hooks = [
      makeHook({ _id: 'h1' }),
      makeHook({ _id: 'h2' }),
    ];
    let callIdx = 0;
    const fetchFn = vi.fn().mockImplementation(async () => {
      callIdx++;
      return makeResponse({ status: 200, body: callIdx === 1 ? '{"block":true}' : '{"ok":true}' });
    });
    const { bus } = makeBus({ hooks, fetchImpl: fetchFn });
    const result = await bus.emit('pre_tool', {});
    expect(result.blocked).toBe(true);
  });

  it('block:false in response body does NOT set blocked:true', async () => {
    const hook = makeHook();
    const fetchFn = vi.fn().mockResolvedValue(makeResponse({ status: 200, body: '{"block":false}' }));
    const { bus } = makeBus({ hooks: [hook], fetchImpl: fetchFn });
    const result = await bus.emit('pre_tool', {});
    expect(result.blocked).toBe(false);
  });
});

// ─── emit() — timeout ─────────────────────────────────────────────────────────

describe('HookBus.emit() — timeout', () => {
  it('returns ok:false, error:"timeout" when fetch hangs past timeoutMs', async () => {
    const hook = makeHook({ _id: 'slow-hook' });

    // fetch never resolves — stays pending
    const fetchFn = vi.fn().mockImplementation(() => new Promise(() => {}));

    // Manually-controlled setTimeout: capture the callback and fire it immediately
    let timerCb;
    const setTimeoutFn = vi.fn().mockImplementation((fn, _ms) => {
      timerCb = fn;
      return 99;
    });
    const clearTimeoutFn = vi.fn();

    const bus = new HookBus({
      repo: makeRepo([hook]),
      fetch: fetchFn,
      timeoutMs: 100,
      logger: makeLogger(),
      now: () => '2024-01-01T00:00:00.000Z',
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    });

    const emitPromise = bus.emit('pre_tool', {});

    // Let fetch start, then fire the timer callback to trigger timeout
    await Promise.resolve();
    await Promise.resolve();
    timerCb(); // fires the abort

    const result = await emitPromise;

    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toBe('timeout');
  });

  it('AbortController signal is passed to fetch and aborted on timeout', async () => {
    const hook = makeHook({ _id: 'abort-hook' });
    let capturedSignal;

    const fetchFn = vi.fn().mockImplementation((_url, init) => {
      capturedSignal = init.signal;
      return new Promise(() => {}); // never resolves
    });

    let timerCb;
    const setTimeoutFn = vi.fn().mockImplementation((fn, _ms) => {
      timerCb = fn;
      return 99;
    });
    const clearTimeoutFn = vi.fn();

    const bus = new HookBus({
      repo: makeRepo([hook]),
      fetch: fetchFn,
      timeoutMs: 50,
      logger: makeLogger(),
      now: () => '2024-01-01T00:00:00.000Z',
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    });

    const emitPromise = bus.emit('pre_tool', {});

    await Promise.resolve();
    await Promise.resolve();
    timerCb(); // fire timeout

    await emitPromise;

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal.aborted).toBe(true);
  });
});

// ─── emit() — matcher selectors ───────────────────────────────────────────────

describe('HookBus.emit() — matcher selectors', () => {
  it('hook with tool matcher fires only when payload.tool matches', async () => {
    const matchingHook = makeHook({ _id: 'match', matcher: { tool: 'bash' } });
    const nonMatchingHook = makeHook({ _id: 'no-match', matcher: { tool: 'read_file' } });
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({
      hooks: [matchingHook, nonMatchingHook],
      fetchImpl: fetchFn,
    });

    const result = await bus.emit('pre_tool', { tool: 'bash' });
    expect(result.fired).toBe(1);
    expect(result.results[0].hookId).toBe('match');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('hook with channel matcher fires only when payload.channel matches', async () => {
    const matchingHook = makeHook({ _id: 'chan-match', matcher: { channel: '#dev' } });
    const nonMatchingHook = makeHook({ _id: 'chan-no', matcher: { channel: '#ops' } });
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({
      hooks: [matchingHook, nonMatchingHook],
      fetchImpl: fetchFn,
    });

    const result = await bus.emit('pre_tool', { channel: '#dev' });
    expect(result.fired).toBe(1);
    expect(result.results[0].hookId).toBe('chan-match');
  });

  it('hook with both tool and channel matcher requires BOTH to match', async () => {
    const strictHook = makeHook({ _id: 'strict', matcher: { tool: 'bash', channel: '#dev' } });
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({ hooks: [strictHook], fetchImpl: fetchFn });

    // tool matches but not channel
    const r1 = await bus.emit('pre_tool', { tool: 'bash', channel: '#ops' });
    expect(r1.fired).toBe(0);

    // both match
    const r2 = await bus.emit('pre_tool', { tool: 'bash', channel: '#dev' });
    expect(r2.fired).toBe(1);
  });

  it('hook with empty matcher fires for all payloads', async () => {
    const hook = makeHook({ matcher: {} });
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({ hooks: [hook], fetchImpl: fetchFn });
    const result = await bus.emit('pre_tool', { tool: 'anything' });
    expect(result.fired).toBe(1);
  });

  it('no hooks returns fired:0 immediately without calling fetch', async () => {
    const fetchFn = vi.fn();
    const { bus } = makeBus({ hooks: [], fetchImpl: fetchFn });
    const result = await bus.emit('pre_tool', {});
    expect(result).toEqual({ fired: 0, blocked: false, results: [] });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ─── emit() — scope ordering ──────────────────────────────────────────────────

describe('HookBus.emit() — scope ordering', () => {
  it('results are ordered user > institution > global', async () => {
    // repo returns hooks already — bus should sort them
    const globalHook       = makeHook({ _id: 'g1', scope: { type: 'global', id: null } });
    const institutionHook  = makeHook({ _id: 'i1', scope: { type: 'institution', id: 'inst-1' } });
    const userHook         = makeHook({ _id: 'u1', scope: { type: 'user', id: 'user-1' } });

    // Repo returns in random order (global first)
    const repo = makeRepo([globalHook, institutionHook, userHook]);
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({ repoOverride: repo, fetchImpl: fetchFn });

    const result = await bus.emit('pre_tool', {});
    expect(result.results.map(r => r.hookId)).toEqual(['u1', 'i1', 'g1']);
  });

  it('multiple user-scope hooks maintain relative order among themselves', async () => {
    const hooks = [
      makeHook({ _id: 'u2', scope: { type: 'user', id: 'user-2' } }),
      makeHook({ _id: 'g1', scope: { type: 'global', id: null } }),
      makeHook({ _id: 'u1', scope: { type: 'user', id: 'user-1' } }),
    ];
    const repo = makeRepo(hooks);
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({ repoOverride: repo, fetchImpl: fetchFn });

    const result = await bus.emit('pre_tool', {});
    const ids = result.results.map(r => r.hookId);
    // Both user hooks appear before global
    expect(ids.indexOf('u2')).toBeLessThan(ids.indexOf('g1'));
    expect(ids.indexOf('u1')).toBeLessThan(ids.indexOf('g1'));
  });
});

// ─── emit() — secret never logged ────────────────────────────────────────────

describe('HookBus.emit() — secret never logged', () => {
  it('secret value never appears in any logger calls', async () => {
    const secret = 'TOP_SECRET_HMAC_KEY_DO_NOT_LOG';
    const hook = makeHook({
      action: { type: 'webhook', config: { url: 'https://safe.io/recv', secret } },
    });
    const logger = makeLogger();
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({ hooks: [hook], fetchImpl: fetchFn, logger });

    await bus.emit('pre_tool', { tool: 'bash' });

    const logged = allLoggedText(logger);
    expect(logged).not.toContain(secret);
  });

  it('secret never logged even when validation fails', async () => {
    const secret = 'SECRET_SHOULD_NOT_APPEAR_IN_LOGS';
    const hook = makeHook({
      _id: 'bad-hook',
      action: { type: 'webhook', config: { url: 'http://insecure.io/recv', secret } }, // http not https
    });
    const logger = makeLogger();
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({ hooks: [hook], fetchImpl: fetchFn, logger });

    await bus.emit('pre_tool', {});

    const logged = allLoggedText(logger);
    expect(logged).not.toContain(secret);
  });

  it('secret never logged on timeout', async () => {
    const secret = 'TIMEOUT_SECRET_DO_NOT_LOG';
    const hook = makeHook({
      action: { type: 'webhook', config: { url: 'https://slow.io/hook', secret, timeout_ms: 100 } },
    });
    const logger = makeLogger();
    const fetchFn = vi.fn().mockImplementation(() => new Promise(() => {}));

    let timerCb;
    const setTimeoutFn = vi.fn().mockImplementation((fn, _ms) => {
      timerCb = fn;
      return 99;
    });
    const clearTimeoutFn = vi.fn();

    const bus = new HookBus({
      repo: makeRepo([hook]),
      fetch: fetchFn,
      timeoutMs: 100,
      logger,
      now: () => '2024-01-01T00:00:00.000Z',
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
    });

    const emitPromise = bus.emit('pre_tool', {});
    await Promise.resolve();
    await Promise.resolve();
    timerCb(); // fire timeout
    await emitPromise;

    const logged = allLoggedText(logger);
    expect(logged).not.toContain(secret);
  });
});

// ─── emit() — hook action validation ─────────────────────────────────────────

describe('HookBus.emit() — per-hook action validation', () => {
  it('missing url: returns ok:false with error message in result (not thrown)', async () => {
    const hook = makeHook({
      _id: 'no-url',
      action: { type: 'webhook', config: { url: '', secret: 'sec' } },
    });
    const { bus } = makeBus({ hooks: [hook] });
    const result = await bus.emit('pre_tool', {});
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toMatch(/url/i);
  });

  it('non-https url: returns ok:false with error about https', async () => {
    const hook = makeHook({
      _id: 'http-hook',
      action: { type: 'webhook', config: { url: 'http://insecure.io/hook', secret: 'sec' } },
    });
    const { bus } = makeBus({ hooks: [hook] });
    const result = await bus.emit('pre_tool', {});
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toMatch(/https/i);
  });

  it('missing secret: returns ok:false with error about secret', async () => {
    const hook = makeHook({
      _id: 'no-secret',
      action: { type: 'webhook', config: { url: 'https://ok.io/hook', secret: '' } },
    });
    const { bus } = makeBus({ hooks: [hook] });
    const result = await bus.emit('pre_tool', {});
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toMatch(/secret/i);
  });

  it('HookValidationError for bad config still fires other valid hooks', async () => {
    const badHook = makeHook({ _id: 'bad', action: { type: 'webhook', config: { url: '', secret: 'x' } } });
    const goodHook = makeHook({ _id: 'good' });
    const fetchFn = vi.fn().mockResolvedValue(makeResponse());
    const { bus } = makeBus({ hooks: [badHook, goodHook], fetchImpl: fetchFn });
    const result = await bus.emit('pre_tool', {});
    expect(result.fired).toBe(2);
    const goodResult = result.results.find(r => r.hookId === 'good');
    const badResult = result.results.find(r => r.hookId === 'bad');
    expect(goodResult.ok).toBe(true);
    expect(badResult.ok).toBe(false);
  });
});

// ─── emit() — repo error ──────────────────────────────────────────────────────

describe('HookBus.emit() — repo errors', () => {
  it('throws HookDispatchError when repo.listByEvent fails', async () => {
    const repo = { listByEvent: vi.fn().mockRejectedValue(new Error('DB connection failed')) };
    const { bus } = makeBus({ repoOverride: repo });
    await expect(bus.emit('pre_tool', {})).rejects.toThrow(HookDispatchError);
  });

  it('HookDispatchError has code "hook_dispatch_error"', async () => {
    const repo = { listByEvent: vi.fn().mockRejectedValue(new Error('DB down')) };
    const { bus } = makeBus({ repoOverride: repo });
    const err = await bus.emit('pre_tool', {}).catch(e => e);
    expect(err.code).toBe('hook_dispatch_error');
  });
});

// ─── emit() — empty result when hooks is null/undefined ───────────────────────

describe('HookBus.emit() — edge cases', () => {
  it('returns fired:0 when repo returns empty array', async () => {
    const { bus } = makeBus({ hooks: [] });
    const result = await bus.emit('pre_tool', {});
    expect(result).toEqual({ fired: 0, blocked: false, results: [] });
  });

  it('returns fired:0 when repo returns null', async () => {
    const repo = { listByEvent: vi.fn().mockResolvedValue(null) };
    const { bus } = makeBus({ repoOverride: repo });
    const result = await bus.emit('post_tool', {});
    expect(result).toEqual({ fired: 0, blocked: false, results: [] });
  });

  it('passes scope argument to repo.listByEvent', async () => {
    const repo = makeRepo([]);
    const { bus } = makeBus({ repoOverride: repo });
    const scope = { type: 'user', id: 'user-abc' };
    await bus.emit('pre_tool', { tool: 'bash' }, scope);
    expect(repo.listByEvent).toHaveBeenCalledWith({ event: 'pre_tool', scope });
  });
});
