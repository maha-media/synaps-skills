/**
 * @file tests/scp-phase-2/02-namespace-isolation.test.mjs
 *
 * Acceptance test: namespace isolation (spec §6.2, acceptance criterion 2).
 *
 * "Two threads from different users do NOT cross-contaminate (namespace test)"
 *
 * Uses a shared mock AxelCliClient (vi.fn()) so we can inspect every call
 * made for each user and verify strict namespace separation.
 *
 * The key assertion:
 *   - userA's recall + store both target a path ending with 'u_userA.r8'
 *   - userB's recall + store both target a path ending with 'u_userB.r8'
 *   - The two paths are distinct
 *   - Exactly 2 distinct brain paths exist across all calls
 *   - No userA call leaks into userB's path and vice-versa
 *
 * Constraints:
 *   - ESM only (.mjs)
 *   - No top-level await
 *   - vitest describe/it/expect/vi
 *   - No real axel binary
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryGateway } from '../../bridge/core/memory-gateway.js';

// ─── mock client factory ──────────────────────────────────────────────────────

/**
 * Build a fresh mock client that records every call.
 * Returns { client, calls } where `calls` is the shared mutable array.
 *
 * @returns {{ client: object, calls: Array<object> }}
 */
function makeMockClient() {
  const calls = [];

  const client = {
    init: vi.fn(async (path) => {
      calls.push({ op: 'init', path });
      return { ok: true, created: true };
    }),
    search: vi.fn(async (path, q, opts) => {
      calls.push({ op: 'search', path, q, opts });
      return [];
    }),
    remember: vi.fn(async (path, text, meta) => {
      calls.push({ op: 'remember', path, text, meta });
      return { ok: true };
    }),
    consolidate: vi.fn(async (path) => {
      calls.push({ op: 'consolidate', path });
      return { ok: true };
    }),
    exists: vi.fn(async () => false),
  };

  return { client, calls };
}

/**
 * Build a MemoryGateway backed by the given mock client.
 *
 * @param {object} client
 * @param {string} [brainDir='/tmp/synaps-ns-test']
 * @returns {MemoryGateway}
 */
function makeGateway(client, brainDir = '/tmp/synaps-ns-test') {
  return new MemoryGateway({
    client,
    brainDir,
    recallK: 4,
    recallMinScore: 0,
    recallMaxChars: 2000,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
}

// ─── 1. namespace string correctness ─────────────────────────────────────────

describe('MemoryGateway — namespace isolation — namespaceFor()', () => {
  it('namespaceFor("userA") returns "u_userA"', () => {
    const { client } = makeMockClient();
    const gw = makeGateway(client);
    expect(gw.namespaceFor('userA')).toBe('u_userA');
  });

  it('namespaceFor("userB") returns "u_userB"', () => {
    const { client } = makeMockClient();
    const gw = makeGateway(client);
    expect(gw.namespaceFor('userB')).toBe('u_userB');
  });

  it('namespaces for different users are different', () => {
    const { client } = makeMockClient();
    const gw = makeGateway(client);
    expect(gw.namespaceFor('userA')).not.toBe(gw.namespaceFor('userB'));
  });

  it('namespaceFor produces the same output for the same id (stable)', () => {
    const { client } = makeMockClient();
    const gw = makeGateway(client);
    expect(gw.namespaceFor('alice')).toBe(gw.namespaceFor('alice'));
  });
});

// ─── 2. brainPath correctness ─────────────────────────────────────────────────

describe('MemoryGateway — namespace isolation — brainPathFor()', () => {
  it('userA brainPath ends with "u_userA.r8"', () => {
    const { client } = makeMockClient();
    const gw = makeGateway(client);
    expect(gw.brainPathFor('userA')).toMatch(/u_userA\.r8$/);
  });

  it('userB brainPath ends with "u_userB.r8"', () => {
    const { client } = makeMockClient();
    const gw = makeGateway(client);
    expect(gw.brainPathFor('userB')).toMatch(/u_userB\.r8$/);
  });

  it('brainPaths for different users are different', () => {
    const { client } = makeMockClient();
    const gw = makeGateway(client);
    expect(gw.brainPathFor('userA')).not.toBe(gw.brainPathFor('userB'));
  });

  it('brainPathFor is deterministic for the same user', () => {
    const { client } = makeMockClient();
    const gw = makeGateway(client);
    expect(gw.brainPathFor('alice')).toBe(gw.brainPathFor('alice'));
  });
});

// ─── 3. store calls use correct namespace ─────────────────────────────────────

describe('MemoryGateway — namespace isolation — store() path routing', () => {
  it('store("userA", …) targets the userA brain path', async () => {
    const { client, calls } = makeMockClient();
    const gw = makeGateway(client);
    const expectedPath = gw.brainPathFor('userA');

    await gw.store('userA', 'userA stores this');

    const rememberCalls = calls.filter(c => c.op === 'remember');
    expect(rememberCalls).toHaveLength(1);
    expect(rememberCalls[0].path).toBe(expectedPath);
  });

  it('store("userB", …) targets the userB brain path', async () => {
    const { client, calls } = makeMockClient();
    const gw = makeGateway(client);
    const expectedPath = gw.brainPathFor('userB');

    await gw.store('userB', 'userB stores this');

    const rememberCalls = calls.filter(c => c.op === 'remember');
    expect(rememberCalls).toHaveLength(1);
    expect(rememberCalls[0].path).toBe(expectedPath);
  });

  it('stores for two different users use two different paths', async () => {
    const { client, calls } = makeMockClient();
    const gw = makeGateway(client);

    await gw.store('userA', 'i love sushi');
    await gw.store('userB', 'i hate cilantro');

    const rememberCalls = calls.filter(c => c.op === 'remember');
    expect(rememberCalls).toHaveLength(2);

    const paths = new Set(rememberCalls.map(c => c.path));
    expect(paths.size).toBe(2);
  });
});

// ─── 4. recall calls use correct namespace ────────────────────────────────────

describe('MemoryGateway — namespace isolation — recall() path routing', () => {
  it('recall("userA", …) searches the userA brain path', async () => {
    const { client, calls } = makeMockClient();
    const gw = makeGateway(client);
    const expectedPath = gw.brainPathFor('userA');

    await gw.recall('userA', 'food');

    const searchCalls = calls.filter(c => c.op === 'search');
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].path).toBe(expectedPath);
  });

  it('recall("userB", …) searches the userB brain path', async () => {
    const { client, calls } = makeMockClient();
    const gw = makeGateway(client);
    const expectedPath = gw.brainPathFor('userB');

    await gw.recall('userB', 'food');

    const searchCalls = calls.filter(c => c.op === 'search');
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].path).toBe(expectedPath);
  });

  it('recalls for two users use two different search paths', async () => {
    const { client, calls } = makeMockClient();
    const gw = makeGateway(client);

    await gw.recall('userA', 'food');
    await gw.recall('userB', 'food');

    const searchCalls = calls.filter(c => c.op === 'search');
    expect(searchCalls).toHaveLength(2);

    const paths = new Set(searchCalls.map(c => c.path));
    expect(paths.size).toBe(2);
  });
});

// ─── 5. Combined store+recall flow — the primary acceptance test ──────────────

describe('MemoryGateway — namespace isolation — combined store+recall flow', () => {
  let client, calls, gw;

  beforeEach(() => {
    ({ client, calls } = makeMockClient());
    gw = makeGateway(client);
  });

  it('produces exactly 2 distinct brain paths across all ops for 2 users', async () => {
    await gw.store('userA', 'i love sushi');
    await gw.store('userB', 'i hate cilantro');
    await gw.recall('userA', 'food');
    await gw.recall('userB', 'food');

    // Collect all paths that appeared in remember + search calls.
    const opsWithPath = calls.filter(c => c.op === 'remember' || c.op === 'search');
    const paths = new Set(opsWithPath.map(c => c.path));
    expect(paths.size).toBe(2);
  });

  it('userA path ends in u_userA.r8', async () => {
    const userAPath = gw.brainPathFor('userA');
    expect(userAPath).toMatch(/u_userA\.r8$/);
  });

  it('userB path ends in u_userB.r8', async () => {
    const userBPath = gw.brainPathFor('userB');
    expect(userBPath).toMatch(/u_userB\.r8$/);
  });

  it('userA store targets only the userA path — never userB path', async () => {
    const userBPath = gw.brainPathFor('userB');

    await gw.store('userA', 'i love sushi');

    const rememberCalls = calls.filter(c => c.op === 'remember');
    for (const c of rememberCalls) {
      expect(c.path).not.toBe(userBPath);
    }
  });

  it('userB store targets only the userB path — never userA path', async () => {
    const userAPath = gw.brainPathFor('userA');

    await gw.store('userB', 'i hate cilantro');

    const rememberCalls = calls.filter(c => c.op === 'remember');
    for (const c of rememberCalls) {
      expect(c.path).not.toBe(userAPath);
    }
  });

  it('userA recall targets only the userA path — never userB path', async () => {
    const userBPath = gw.brainPathFor('userB');

    await gw.recall('userA', 'food');

    const searchCalls = calls.filter(c => c.op === 'search');
    for (const c of searchCalls) {
      expect(c.path).not.toBe(userBPath);
    }
  });

  it('userB recall targets only the userB path — never userA path', async () => {
    const userAPath = gw.brainPathFor('userA');

    await gw.recall('userB', 'food');

    const searchCalls = calls.filter(c => c.op === 'search');
    for (const c of searchCalls) {
      expect(c.path).not.toBe(userAPath);
    }
  });

  it('full 4-op scenario — each user op goes to the correct brain', async () => {
    const userAPath = gw.brainPathFor('userA');
    const userBPath = gw.brainPathFor('userB');

    await gw.store('userA', 'i love sushi');
    await gw.store('userB', 'i hate cilantro');
    await gw.recall('userA', 'food');
    await gw.recall('userB', 'food');

    // userA remember call
    const userARemember = calls.filter(c => c.op === 'remember' && c.path === userAPath);
    expect(userARemember).toHaveLength(1);
    expect(userARemember[0].text).toBe('i love sushi');

    // userB remember call
    const userBRemember = calls.filter(c => c.op === 'remember' && c.path === userBPath);
    expect(userBRemember).toHaveLength(1);
    expect(userBRemember[0].text).toBe('i hate cilantro');

    // userA search call
    const userASearch = calls.filter(c => c.op === 'search' && c.path === userAPath);
    expect(userASearch).toHaveLength(1);
    expect(userASearch[0].q).toBe('food');

    // userB search call
    const userBSearch = calls.filter(c => c.op === 'search' && c.path === userBPath);
    expect(userBSearch).toHaveLength(1);
    expect(userBSearch[0].q).toBe('food');
  });
});

// ─── 6. Three-user scenario ──────────────────────────────────────────────────

describe('MemoryGateway — namespace isolation — three-user scenario', () => {
  it('three users each get a unique brain path', () => {
    const { client } = makeMockClient();
    const gw = makeGateway(client);

    const pathA = gw.brainPathFor('alice');
    const pathB = gw.brainPathFor('bob');
    const pathC = gw.brainPathFor('charlie');

    expect(new Set([pathA, pathB, pathC]).size).toBe(3);
  });

  it('stores for three users never cross-contaminate', async () => {
    const { client, calls } = makeMockClient();
    const gw = makeGateway(client);

    await gw.store('alice',   'alice content');
    await gw.store('bob',     'bob content');
    await gw.store('charlie', 'charlie content');

    const rememberCalls = calls.filter(c => c.op === 'remember');
    expect(rememberCalls).toHaveLength(3);

    const paths = new Set(rememberCalls.map(c => c.path));
    expect(paths.size).toBe(3);

    // Verify each path ends with the user's namespace
    for (const c of rememberCalls) {
      const matchingUser = ['alice', 'bob', 'charlie'].find(u => c.text.startsWith(u));
      const expectedNs = `u_${matchingUser}.r8`;
      expect(c.path).toMatch(new RegExp(`${expectedNs}$`));
    }
  });
});

// ─── 7. Init is per-namespace, called at most once per user ───────────────────

describe('MemoryGateway — namespace isolation — lazy init', () => {
  it('each user gets their own init call', async () => {
    const { client, calls } = makeMockClient();
    const gw = makeGateway(client);

    await gw.store('userA', 'first store for A');
    await gw.store('userB', 'first store for B');

    const initCalls = calls.filter(c => c.op === 'init');
    expect(initCalls).toHaveLength(2);

    const initPaths = new Set(initCalls.map(c => c.path));
    expect(initPaths.size).toBe(2);
  });

  it('second store for same user does NOT call init again', async () => {
    const { client, calls } = makeMockClient();
    const gw = makeGateway(client);

    await gw.store('userA', 'first store');
    await gw.store('userA', 'second store');

    const initCalls = calls.filter(c => c.op === 'init');
    // Only one init call for userA (lazy init caches after first success).
    expect(initCalls).toHaveLength(1);
  });

  it('userA init path is exclusively the userA brain path', async () => {
    const { client, calls } = makeMockClient();
    const gw = makeGateway(client);
    const userAPath = gw.brainPathFor('userA');

    await gw.store('userA', 'something');

    const initCalls = calls.filter(c => c.op === 'init');
    expect(initCalls[0].path).toBe(userAPath);
  });
});
