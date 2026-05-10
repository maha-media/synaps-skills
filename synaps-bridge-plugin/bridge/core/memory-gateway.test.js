/**
 * @file bridge/core/memory-gateway.test.js
 *
 * Tests for MemoryGateway and NoopMemoryGateway.
 *
 * All tests use a mock AxelCliClient (no real I/O).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { MemoryGateway, NoopMemoryGateway } from './memory-gateway.js';

// ─── Mock client factory ──────────────────────────────────────────────────────

/**
 * Build a vi.fn()-spied mock client that satisfies the AxelCliClient contract.
 * All methods resolve immediately by default; tests can override via mockResolvedValueOnce /
 * mockRejectedValueOnce on the individual spies.
 *
 * @param {object} [overrides]  - Per-method override implementations
 * @returns {{ init, search, remember, consolidate, exists }}
 */
function makeMockClient(overrides = {}) {
  return {
    init:        vi.fn().mockResolvedValue({ ok: true, created: true }),
    search:      vi.fn().mockResolvedValue([]),
    remember:    vi.fn().mockResolvedValue({ ok: true, id: 'mem-1' }),
    consolidate: vi.fn().mockResolvedValue({ ok: true, summary: 'done' }),
    exists:      vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

/** Minimal valid gateway options. */
function makeGateway(opts = {}) {
  return new MemoryGateway({
    client: makeMockClient(),
    brainDir: '/test/brains',
    ...opts,
  });
}

// ─── namespaceFor / brainPathFor ──────────────────────────────────────────────

describe('MemoryGateway#namespaceFor', () => {
  it('returns u_<id> for a valid synapsUserId', () => {
    const gw = makeGateway();
    expect(gw.namespaceFor('alice')).toBe('u_alice');
  });

  it('uses a custom namespacePrefix when provided', () => {
    const gw = makeGateway({ namespacePrefix: 'ns_' });
    expect(gw.namespaceFor('bob')).toBe('ns_bob');
  });

  it('throws TypeError on empty string', () => {
    const gw = makeGateway();
    expect(() => gw.namespaceFor('')).toThrow(TypeError);
    expect(() => gw.namespaceFor('')).toThrow(/non-empty string/i);
  });

  it('throws TypeError on non-string (number)', () => {
    const gw = makeGateway();
    expect(() => gw.namespaceFor(42)).toThrow(TypeError);
  });

  it('throws TypeError on null', () => {
    const gw = makeGateway();
    expect(() => gw.namespaceFor(null)).toThrow(TypeError);
  });

  it('throws TypeError on undefined', () => {
    const gw = makeGateway();
    expect(() => gw.namespaceFor(undefined)).toThrow(TypeError);
  });
});

describe('MemoryGateway#brainPathFor', () => {
  it('returns path.join(brainDir, "<ns>.r8")', () => {
    const gw = makeGateway({ brainDir: '/some/dir' });
    expect(gw.brainPathFor('alice')).toBe('/some/dir/u_alice.r8');
  });

  it('uses os.homedir() when brainDir starts with ~/', () => {
    const home = os.homedir();
    const gw = makeGateway({ brainDir: '~/memory' });
    expect(gw.brainPathFor('alice')).toBe(path.join(home, 'memory', 'u_alice.r8'));
  });

  it('leaves an absolute path unchanged', () => {
    const gw = makeGateway({ brainDir: '/abs/path' });
    expect(gw.brainPathFor('bob')).toBe('/abs/path/u_bob.r8');
  });
});

// ─── Constructor validation ───────────────────────────────────────────────────

describe('MemoryGateway constructor', () => {
  it('throws when client is not provided', () => {
    expect(() => new MemoryGateway({ brainDir: '/dir' })).toThrow(TypeError);
  });

  it('throws when brainDir is an empty string', () => {
    expect(() => new MemoryGateway({ client: makeMockClient(), brainDir: '' })).toThrow(TypeError);
    expect(() => new MemoryGateway({ client: makeMockClient(), brainDir: '' })).toThrow(/brainDir/i);
  });

  it('throws when brainDir is not a string', () => {
    expect(() => new MemoryGateway({ client: makeMockClient(), brainDir: 123 })).toThrow(TypeError);
    expect(() => new MemoryGateway({ client: makeMockClient(), brainDir: null })).toThrow(TypeError);
    expect(() => new MemoryGateway({ client: makeMockClient() })).toThrow(TypeError);
  });

  it('expands a leading ~/ in brainDir via os.homedir()', () => {
    const home = os.homedir();
    const gw = new MemoryGateway({ client: makeMockClient(), brainDir: '~/foo' });
    expect(gw._brainDir).toBe(path.join(home, 'foo'));
  });

  it('keeps an absolute brainDir as-is', () => {
    const gw = new MemoryGateway({ client: makeMockClient(), brainDir: '/abs/dir' });
    expect(gw._brainDir).toBe('/abs/dir');
  });
});

// ─── enabled + lifecycle ──────────────────────────────────────────────────────

describe('MemoryGateway#enabled + lifecycle', () => {
  it('enabled getter returns true', () => {
    expect(makeGateway().enabled).toBe(true);
  });

  it('start() resolves without error', async () => {
    await expect(makeGateway().start()).resolves.toBeUndefined();
  });

  it('stop() resolves without error', async () => {
    await expect(makeGateway().stop()).resolves.toBeUndefined();
  });
});

// ─── recall — happy path ──────────────────────────────────────────────────────

describe('MemoryGateway#recall — happy path', () => {
  it('calls client.init then client.search with correct args', async () => {
    const client = makeMockClient({
      search: vi.fn().mockResolvedValue([
        { id: '1', content: 'hello world', score: 0.9 },
      ]),
    });
    const gw = new MemoryGateway({ client, brainDir: '/brains' });

    const result = await gw.recall('alice', 'hello');

    expect(client.init).toHaveBeenCalledOnce();
    expect(client.init).toHaveBeenCalledWith('/brains/u_alice.r8', { name: 'u_alice' });

    expect(client.search).toHaveBeenCalledOnce();
    expect(client.search).toHaveBeenCalledWith('/brains/u_alice.r8', 'hello', { k: 8 });

    expect(result).toBe('- hello world');
  });

  it('formats results as "- content" joined with \\n', async () => {
    const client = makeMockClient({
      search: vi.fn().mockResolvedValue([
        { id: '1', content: 'first',  score: 0.9 },
        { id: '2', content: 'second', score: 0.7 },
      ]),
    });
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    const result = await gw.recall('alice', 'q');
    expect(result).toBe('- first\n- second');
  });

  it('returns null when search returns an empty array', async () => {
    const gw = makeGateway({ client: makeMockClient({ search: vi.fn().mockResolvedValue([]) }) });
    expect(await gw.recall('alice', 'query')).toBeNull();
  });

  it('uses the configured recallK for the k option', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b', recallK: 5 });
    await gw.recall('user1', 'q');
    expect(client.search).toHaveBeenCalledWith('/b/u_user1.r8', 'q', { k: 5 });
  });
});

// ─── recall — query guard ─────────────────────────────────────────────────────

describe('MemoryGateway#recall — query guard', () => {
  it('returns null for an empty string without calling search', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    expect(await gw.recall('u1', '')).toBeNull();
    expect(client.search).not.toHaveBeenCalled();
  });

  it('returns null for whitespace-only query without calling search', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    expect(await gw.recall('u1', '   ')).toBeNull();
    expect(client.search).not.toHaveBeenCalled();
  });

  it('returns null for a non-string query without calling search', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    expect(await gw.recall('u1', null)).toBeNull();
    expect(client.search).not.toHaveBeenCalled();
  });
});

// ─── recall — score filter ────────────────────────────────────────────────────

describe('MemoryGateway#recall — score filter', () => {
  it('filters out results below recallMinScore', async () => {
    const client = makeMockClient({
      search: vi.fn().mockResolvedValue([
        { id: '1', content: 'pass',   score: 0.6 },
        { id: '2', content: 'fail',   score: 0.3 },
        { id: '3', content: 'also ok', score: 0.7 },
      ]),
    });
    const gw = new MemoryGateway({ client, brainDir: '/b', recallMinScore: 0.5 });
    const result = await gw.recall('u', 'q');
    // sorted by score desc: 'also ok' (0.7), 'pass' (0.6) — 'fail' excluded
    expect(result).toBe('- also ok\n- pass');
  });

  it('returns null when all results are below recallMinScore', async () => {
    const client = makeMockClient({
      search: vi.fn().mockResolvedValue([
        { id: '1', content: 'low', score: 0.1 },
      ]),
    });
    const gw = new MemoryGateway({ client, brainDir: '/b', recallMinScore: 0.5 });
    expect(await gw.recall('u', 'q')).toBeNull();
  });
});

// ─── recall — char cap ────────────────────────────────────────────────────────

describe('MemoryGateway#recall — char cap', () => {
  it('truncates the list when next item would push over recallMaxChars', async () => {
    // Each result has a 20-char content string; "- " prefix = 22 chars per line.
    // With maxChars=50: first line=22 chars, second line would need 22+1=23 more = 45 total (ok),
    // third line would need 22+1=23 more = 68 total (exceeds 50).
    const client = makeMockClient({
      search: vi.fn().mockResolvedValue([
        { id: '1', content: 'aaaaaaaaaaaaaaaaaaa1', score: 0.9 }, // 22 chars as line
        { id: '2', content: 'bbbbbbbbbbbbbbbbbbb2', score: 0.8 }, // 22+1=23 more → 45 total
        { id: '3', content: 'ccccccccccccccccccc3', score: 0.7 }, // 23 more → 68 > 50, stop
      ]),
    });
    const gw = new MemoryGateway({ client, brainDir: '/b', recallMaxChars: 50 });
    const result = await gw.recall('u', 'q');
    expect(result).toBe('- aaaaaaaaaaaaaaaaaaa1\n- bbbbbbbbbbbbbbbbbbb2');
  });

  it('returns null when even the first item exceeds recallMaxChars', async () => {
    const client = makeMockClient({
      search: vi.fn().mockResolvedValue([
        { id: '1', content: 'this content is longer than ten chars', score: 0.9 },
      ]),
    });
    const gw = new MemoryGateway({ client, brainDir: '/b', recallMaxChars: 10 });
    expect(await gw.recall('u', 'q')).toBeNull();
  });
});

// ─── recall — sort by score desc ─────────────────────────────────────────────

describe('MemoryGateway#recall — sort order', () => {
  it('sorts results by score descending regardless of search return order', async () => {
    const client = makeMockClient({
      search: vi.fn().mockResolvedValue([
        { id: '1', content: 'low',    score: 0.2 },
        { id: '2', content: 'high',   score: 0.9 },
        { id: '3', content: 'medium', score: 0.5 },
      ]),
    });
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    const result = await gw.recall('u', 'q');
    expect(result).toBe('- high\n- medium\n- low');
  });
});

// ─── recall — lazy init ───────────────────────────────────────────────────────

describe('MemoryGateway#recall — lazy init', () => {
  it('calls client.init exactly once on the first call for a user', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });

    await gw.recall('alice', 'q');
    expect(client.init).toHaveBeenCalledOnce();
  });

  it('does NOT call client.init again on the second call for the same user', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });

    await gw.recall('alice', 'q');
    await gw.recall('alice', 'q2');
    expect(client.init).toHaveBeenCalledOnce();
  });

  it('calls client.init once per distinct user', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });

    await gw.recall('alice', 'q');
    await gw.recall('bob',   'q');
    expect(client.init).toHaveBeenCalledTimes(2);
    expect(client.init).toHaveBeenNthCalledWith(1, '/b/u_alice.r8', { name: 'u_alice' });
    expect(client.init).toHaveBeenNthCalledWith(2, '/b/u_bob.r8',   { name: 'u_bob'   });
  });

  it('retries init on next call if init threw previously', async () => {
    const initFn = vi.fn()
      .mockRejectedValueOnce(new Error('init fail'))
      .mockResolvedValue({ ok: true, created: false });

    const client = makeMockClient({ init: initFn });
    const gw = new MemoryGateway({ client, brainDir: '/b' });

    // First call: init fails → recall still returns (null from empty search), init not marked done.
    const result1 = await gw.recall('alice', 'q');
    expect(result1).toBeNull();
    expect(initFn).toHaveBeenCalledTimes(1);

    // Second call: init is retried.
    await gw.recall('alice', 'q');
    expect(initFn).toHaveBeenCalledTimes(2);
  });
});

// ─── recall — error swallowing ────────────────────────────────────────────────

describe('MemoryGateway#recall — error swallowing', () => {
  it('returns null when client.search throws', async () => {
    const client = makeMockClient({
      search: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    expect(await gw.recall('u', 'q')).toBeNull();
  });

  it('logs a warn when client.search throws', async () => {
    const warnings = [];
    const client = makeMockClient({
      search: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const gw = new MemoryGateway({
      client,
      brainDir: '/b',
      logger: { warn: (m) => warnings.push(m) },
    });
    await gw.recall('u', 'q');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/boom/);
  });

  it('never propagates errors to the caller', async () => {
    const client = makeMockClient({
      search: vi.fn().mockRejectedValue(new Error('unexpected')),
    });
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    await expect(gw.recall('u', 'q')).resolves.toBeNull();
  });
});

// ─── store — happy path ───────────────────────────────────────────────────────

describe('MemoryGateway#store — happy path', () => {
  it('calls client.init lazy then client.remember', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });

    const result = await gw.store('alice', 'some text');

    expect(client.init).toHaveBeenCalledOnce();
    expect(client.remember).toHaveBeenCalledOnce();
    expect(client.remember).toHaveBeenCalledWith('/b/u_alice.r8', 'some text', {});
    expect(result).toEqual({ ok: true });
  });

  it('forwards category, topic, title from metadata', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });

    await gw.store('alice', 'text', { category: 'work', topic: 'project', title: 'note' });

    expect(client.remember).toHaveBeenCalledWith('/b/u_alice.r8', 'text', {
      category: 'work',
      topic:    'project',
      title:    'note',
    });
  });

  it('does not forward unknown metadata fields', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });

    await gw.store('alice', 'text', { category: 'cat', tags: ['a', 'b'], extra: true });

    const callArgs = client.remember.mock.calls[0][2];
    expect(callArgs).toEqual({ category: 'cat' });
    expect(callArgs.tags).toBeUndefined();
    expect(callArgs.extra).toBeUndefined();
  });

  it('only forwards metadata fields that are present (partial set)', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });

    await gw.store('alice', 'text', { topic: 'only-topic' });
    expect(client.remember.mock.calls[0][2]).toEqual({ topic: 'only-topic' });
  });
});

// ─── store — text guard ───────────────────────────────────────────────────────

describe('MemoryGateway#store — text guard', () => {
  it('returns { ok: false, error: "empty text" } for an empty string', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    const result = await gw.store('u', '');
    expect(result).toEqual({ ok: false, error: 'empty text' });
    expect(client.remember).not.toHaveBeenCalled();
  });

  it('returns { ok: false, error: "empty text" } for whitespace-only text', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    const result = await gw.store('u', '   ');
    expect(result).toEqual({ ok: false, error: 'empty text' });
    expect(client.remember).not.toHaveBeenCalled();
  });

  it('returns { ok: false, error: "empty text" } for non-string text', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    expect(await gw.store('u', null)).toEqual({ ok: false, error: 'empty text' });
    expect(await gw.store('u', 42  )).toEqual({ ok: false, error: 'empty text' });
    expect(client.remember).not.toHaveBeenCalled();
  });
});

// ─── store — error swallowing ─────────────────────────────────────────────────

describe('MemoryGateway#store — error swallowing', () => {
  it('returns { ok: false, error: msg } when client.remember throws', async () => {
    const client = makeMockClient({
      remember: vi.fn().mockRejectedValue(new Error('db write failed')),
    });
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    const result = await gw.store('u', 'some text');
    expect(result).toEqual({ ok: false, error: 'db write failed' });
  });

  it('logs a warn when client.remember throws', async () => {
    const warnings = [];
    const client = makeMockClient({
      remember: vi.fn().mockRejectedValue(new Error('disk full')),
    });
    const gw = new MemoryGateway({
      client,
      brainDir: '/b',
      logger: { warn: (m) => warnings.push(m) },
    });
    await gw.store('u', 'text');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/disk full/);
  });

  it('never propagates store errors to the caller', async () => {
    const client = makeMockClient({
      remember: vi.fn().mockRejectedValue(new Error('crash')),
    });
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    await expect(gw.store('u', 'text')).resolves.toMatchObject({ ok: false });
  });
});

// ─── store — lazy init shared with recall ────────────────────────────────────

describe('MemoryGateway#store — lazy init', () => {
  it('calls init on first store, not again on second', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });

    await gw.store('u', 'text one');
    await gw.store('u', 'text two');
    expect(client.init).toHaveBeenCalledOnce();
  });

  it('shares init state with recall (no double-init across method calls)', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });

    await gw.recall('u', 'query');   // inits the brain
    await gw.store('u', 'text');     // should NOT init again
    expect(client.init).toHaveBeenCalledOnce();
  });
});

// ─── consolidate ─────────────────────────────────────────────────────────────

describe('MemoryGateway#consolidate', () => {
  it('calls client.init lazy then client.consolidate with brainPath + opts', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });

    const result = await gw.consolidate('alice', { since: '2024-01-01', dryRun: false });

    expect(client.init).toHaveBeenCalledOnce();
    expect(client.consolidate).toHaveBeenCalledOnce();
    expect(client.consolidate).toHaveBeenCalledWith('/b/u_alice.r8', { since: '2024-01-01', dryRun: false });
    expect(result).toEqual({ ok: true, summary: 'done' });
  });

  it('propagates errors from client.consolidate (does not swallow)', async () => {
    const client = makeMockClient({
      consolidate: vi.fn().mockRejectedValue(new Error('consolidate failed')),
    });
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    await expect(gw.consolidate('u', {})).rejects.toThrow('consolidate failed');
  });

  it('defaults opts to empty object when called without second arg', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });
    await gw.consolidate('alice');
    expect(client.consolidate).toHaveBeenCalledWith('/b/u_alice.r8', {});
  });
});

// ─── NoopMemoryGateway ────────────────────────────────────────────────────────

describe('NoopMemoryGateway', () => {
  let noop;

  beforeEach(() => {
    noop = new NoopMemoryGateway();
  });

  it('can be constructed without any arguments', () => {
    expect(() => new NoopMemoryGateway()).not.toThrow();
  });

  it('enabled getter returns false', () => {
    expect(noop.enabled).toBe(false);
  });

  it('recall() returns null without any client interaction', async () => {
    expect(await noop.recall('u', 'query')).toBeNull();
  });

  it('recall() returns null regardless of arguments', async () => {
    expect(await noop.recall()).toBeNull();
    expect(await noop.recall(null, null)).toBeNull();
  });

  it('store() returns { ok: true, noop: true }', async () => {
    expect(await noop.store('u', 'text')).toEqual({ ok: true, noop: true });
  });

  it('store() returns noop result even with no arguments', async () => {
    expect(await noop.store()).toEqual({ ok: true, noop: true });
  });

  it('consolidate() returns { ok: true, noop: true }', async () => {
    expect(await noop.consolidate('u')).toEqual({ ok: true, noop: true });
  });

  it('start() resolves without error', async () => {
    await expect(noop.start()).resolves.toBeUndefined();
  });

  it('stop() resolves without error', async () => {
    await expect(noop.stop()).resolves.toBeUndefined();
  });

  it('namespaceFor() returns u_<id>', () => {
    expect(noop.namespaceFor('alice')).toBe('u_alice');
  });

  it('brainPathFor() returns null', () => {
    expect(noop.brainPathFor('alice')).toBeNull();
  });

  it('brainPathFor() returns null regardless of argument', () => {
    expect(noop.brainPathFor()).toBeNull();
    expect(noop.brainPathFor(null)).toBeNull();
  });
});

// ─── Integration: two users do NOT cross-contaminate ─────────────────────────

describe('MemoryGateway — namespace isolation', () => {
  it('two different users get different brain paths', () => {
    const gw = makeGateway({ brainDir: '/brains' });
    expect(gw.brainPathFor('alice')).not.toBe(gw.brainPathFor('bob'));
    expect(gw.brainPathFor('alice')).toBe('/brains/u_alice.r8');
    expect(gw.brainPathFor('bob')).toBe('/brains/u_bob.r8');
  });

  it('init is called separately for each user', async () => {
    const client = makeMockClient();
    const gw = new MemoryGateway({ client, brainDir: '/b' });

    await gw.recall('alice', 'q');
    await gw.recall('bob',   'q');

    expect(client.init).toHaveBeenCalledTimes(2);
    const paths = client.init.mock.calls.map(c => c[0]);
    expect(paths).toContain('/b/u_alice.r8');
    expect(paths).toContain('/b/u_bob.r8');
  });
});
