/**
 * @file tests/scp-phase-2/03-recall-store-roundtrip.test.mjs
 *
 * Acceptance test: recall returns what was stored (spec §6.2, criterion 1).
 *
 * "Two threads from same SynapsUser share recall ('you told me yesterday X')"
 *
 * Uses a mock AxelCliClient whose search() implementation returns the
 * previously stored texts so we can verify the full lifecycle without a real
 * axel binary.
 *
 * Scenarios:
 *   A. Two store() calls + one recall() → both stored items appear in summary
 *   B. Namespace isolation negative case: bob recalls alice's namespace → null
 *   C. recall with empty brain → null
 *   D. recall with score filter removes low-scoring results
 *   E. recall_max_chars cap is respected
 *   F. Stored metadata is forwarded to the client
 *
 * Constraints:
 *   - ESM only (.mjs)
 *   - No top-level await
 *   - vitest describe/it/expect/vi
 *   - No real axel binary
 */

import { describe, it, expect, vi } from 'vitest';
import { MemoryGateway } from '../../bridge/core/memory-gateway.js';

// ─── mock client factory ──────────────────────────────────────────────────────

/**
 * Build a stateful mock client.
 *
 * - remember() appends to an in-memory `stored` array.
 * - search() returns synthetic results from `stored` filtered by path.
 * - All calls are vi.fn() so test code can assert on invocations.
 *
 * @param {object} [opts]
 * @param {number} [opts.baseScore=0.9]  - Score for the first result; decreases by 0.1 per item.
 * @returns {{ client: object, stored: Array<{path:string, text:string}> }}
 */
function makeStatefulClient({ baseScore = 0.9 } = {}) {
  const stored = [];

  const client = {
    init: vi.fn(async () => ({ ok: true, created: false })),

    search: vi.fn(async (path, query, { k } = {}) => {
      const matches = stored
        .filter(s => s.path === path)
        .map((s, i) => ({
          id:      `m${i}`,
          content: s.text,
          score:   Math.max(0, baseScore - i * 0.1),
        }));
      // Respect k limit
      return typeof k === 'number' ? matches.slice(0, k) : matches;
    }),

    remember: vi.fn(async (path, text) => {
      stored.push({ path, text });
      return { ok: true };
    }),

    consolidate: vi.fn(async () => ({ ok: true })),
    exists:      vi.fn(async () => false),
  };

  return { client, stored };
}

/**
 * Build a MemoryGateway backed by the given mock client.
 *
 * @param {object}  client
 * @param {object}  [opts]
 * @param {string}  [opts.brainDir='/tmp/synaps-roundtrip-test']
 * @param {number}  [opts.recallK=8]
 * @param {number}  [opts.recallMinScore=0]
 * @param {number}  [opts.recallMaxChars=2000]
 * @returns {MemoryGateway}
 */
function makeGateway(client, {
  brainDir       = '/tmp/synaps-roundtrip-test',
  recallK        = 8,
  recallMinScore = 0,
  recallMaxChars = 2000,
} = {}) {
  return new MemoryGateway({
    client,
    brainDir,
    recallK,
    recallMinScore,
    recallMaxChars,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
}

// ─── Scenario A: two stores then recall ──────────────────────────────────────

describe('MemoryGateway — recall+store roundtrip — Scenario A: two threads share recall', () => {
  it('recall returns a non-null summary after storing content', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    await gw.store('alice', 'I love sushi');
    const summary = await gw.recall('alice', 'food preferences');

    expect(summary).not.toBeNull();
  });

  it('recall summary contains the stored text', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    await gw.store('alice', 'I love sushi');
    const summary = await gw.recall('alice', 'food preferences');

    expect(summary).toContain('sushi');
  });

  it('recall summary contains both stored items (two-thread simulation)', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    // Simulate two threads for the same user
    await gw.store('alice', 'I love sushi');
    await gw.store('alice', 'I have a meeting Tuesday');

    const summary = await gw.recall('alice', 'food preferences');

    expect(summary).toContain('sushi');
    expect(summary).toContain('meeting');
  });

  it('recall summary length is at most recall_max_chars', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client, { recallMaxChars: 2000 });

    await gw.store('alice', 'I love sushi');
    await gw.store('alice', 'I have a meeting Tuesday');

    const summary = await gw.recall('alice', 'food preferences');

    expect(summary.length).toBeLessThanOrEqual(2000);
  });

  it('summary is a string containing bullet-prefixed lines', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    await gw.store('alice', 'I love sushi');
    const summary = await gw.recall('alice', 'food');

    // MemoryGateway formats results as "- <content>" joined by "\n"
    expect(typeof summary).toBe('string');
    expect(summary).toMatch(/^- /);
  });

  it('recall client.search is called with the correct brain path and query', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);
    const expectedPath = gw.brainPathFor('alice');

    await gw.store('alice', 'I love sushi');
    await gw.recall('alice', 'food preferences');

    const searchCalls = client.search.mock.calls;
    expect(searchCalls.length).toBeGreaterThanOrEqual(1);

    const lastSearch = searchCalls[searchCalls.length - 1];
    expect(lastSearch[0]).toBe(expectedPath);
    expect(lastSearch[1]).toBe('food preferences');
  });

  it('recall passes recallK to client.search', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client, { recallK: 5 });

    await gw.store('alice', 'I love sushi');
    await gw.recall('alice', 'food');

    const searchCalls = client.search.mock.calls;
    const lastSearch = searchCalls[searchCalls.length - 1];
    expect(lastSearch[2]).toEqual({ k: 5 });
  });

  it('store client.remember is called with the correct path and text', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);
    const expectedPath = gw.brainPathFor('alice');

    await gw.store('alice', 'I love sushi');

    const rememberCalls = client.remember.mock.calls;
    expect(rememberCalls.length).toBeGreaterThanOrEqual(1);
    expect(rememberCalls[0][0]).toBe(expectedPath);
    expect(rememberCalls[0][1]).toBe('I love sushi');
  });
});

// ─── Scenario B: namespace isolation (negative case) ─────────────────────────

describe('MemoryGateway — recall+store roundtrip — Scenario B: namespace isolation negative', () => {
  it("recall for bob returns null when only alice's path has stored content", async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    // Store under alice's namespace only.
    await gw.store('alice', 'I love sushi');

    // Bob's search → his path has 0 entries → search returns [] → recall returns null.
    const bobSummary = await gw.recall('bob', 'food preferences');
    expect(bobSummary).toBeNull();
  });

  it('alice stored items do NOT appear in bob recall', async () => {
    const { client, stored } = makeStatefulClient();
    const gw = makeGateway(client);
    const alicePath = gw.brainPathFor('alice');
    const bobPath   = gw.brainPathFor('bob');

    await gw.store('alice', 'I love sushi');

    // Verify that stored contains only alice's path
    expect(stored.every(s => s.path === alicePath)).toBe(true);
    expect(stored.some(s => s.path === bobPath)).toBe(false);

    // Bob's recall is null
    const bobSummary = await gw.recall('bob', 'food');
    expect(bobSummary).toBeNull();
  });

  it('alice recall does not affect bob stored items', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    await gw.store('bob', 'bob-only memory');

    // Alice recall shouldn't find bob's content (different path).
    const aliceSummary = await gw.recall('alice', 'memory');
    expect(aliceSummary).toBeNull();

    // Bob recall should find bob's content.
    const bobSummary = await gw.recall('bob', 'memory');
    expect(bobSummary).not.toBeNull();
    expect(bobSummary).toContain('bob-only');
  });
});

// ─── Scenario C: empty brain → null ──────────────────────────────────────────

describe('MemoryGateway — recall+store roundtrip — Scenario C: empty brain returns null', () => {
  it('recall from a brain with no stored items returns null', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    const result = await gw.recall('alice', 'anything');
    expect(result).toBeNull();
  });

  it('recall with empty query string returns null without calling client.search', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    const result = await gw.recall('alice', '');
    expect(result).toBeNull();
    // Empty query guard fires before any client call.
    expect(client.search).not.toHaveBeenCalled();
  });

  it('recall with whitespace-only query returns null without calling client.search', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    const result = await gw.recall('alice', '   ');
    expect(result).toBeNull();
    expect(client.search).not.toHaveBeenCalled();
  });
});

// ─── Scenario D: score filtering ─────────────────────────────────────────────

describe('MemoryGateway — recall+store roundtrip — Scenario D: score filter', () => {
  it('results below recall_min_score are excluded from the summary', async () => {
    // Use a high baseScore so the first result passes, subsequent ones may not.
    // recallMinScore = 0.85 → only results with score ≥ 0.85 included.
    const { client } = makeStatefulClient({ baseScore: 0.9 });
    const gw = makeGateway(client, { recallMinScore: 0.85 });

    // Store two items; first gets score 0.9, second gets 0.8 (below 0.85).
    await gw.store('alice', 'first memory (high score)');
    await gw.store('alice', 'second memory (low score, filtered)');

    const summary = await gw.recall('alice', 'query');

    // summary should contain the first item but NOT the second.
    expect(summary).toContain('first memory');
    expect(summary).not.toContain('second memory');
  });

  it('all results below recall_min_score → returns null', async () => {
    // baseScore starts at 0.1; recallMinScore 0.5 → nothing passes.
    const { client } = makeStatefulClient({ baseScore: 0.1 });
    const gw = makeGateway(client, { recallMinScore: 0.5 });

    await gw.store('alice', 'low score content');

    const summary = await gw.recall('alice', 'query');
    expect(summary).toBeNull();
  });

  it('recall_min_score = 0 includes all results', async () => {
    const { client } = makeStatefulClient({ baseScore: 0.05 });
    const gw = makeGateway(client, { recallMinScore: 0 });

    await gw.store('alice', 'very low score content');

    const summary = await gw.recall('alice', 'query');
    expect(summary).not.toBeNull();
    expect(summary).toContain('very low score');
  });
});

// ─── Scenario E: recall_max_chars cap ────────────────────────────────────────

describe('MemoryGateway — recall+store roundtrip — Scenario E: char cap', () => {
  it('summary is capped at recall_max_chars', async () => {
    // Store many items; with a tiny cap, only some will appear.
    const { client } = makeStatefulClient();
    const gw = makeGateway(client, { recallMaxChars: 100 });

    for (let i = 0; i < 20; i++) {
      await gw.store('alice', `Memory item number ${i} with some padding text here`);
    }

    const summary = await gw.recall('alice', 'memory');
    // Must never exceed cap.
    expect(summary.length).toBeLessThanOrEqual(100);
  });

  it('summary contains at least one item even with a tight cap', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client, { recallMaxChars: 200 });

    await gw.store('alice', 'short item');

    const summary = await gw.recall('alice', 'item');
    expect(summary).toContain('short item');
  });

  it('summary is null when the only result is longer than recall_max_chars', async () => {
    const { client } = makeStatefulClient();
    // Very tight cap (100 chars), but content plus "- " prefix is longer.
    const gw = makeGateway(client, { recallMaxChars: 10 });

    await gw.store('alice', 'This is a very long memory item that clearly exceeds 10 chars');

    const summary = await gw.recall('alice', 'long');
    // The single line "- This is a very long…" is > 10 chars → cap cuts it before it can be added.
    expect(summary).toBeNull();
  });
});

// ─── Scenario F: metadata forwarding ─────────────────────────────────────────

describe('MemoryGateway — recall+store roundtrip — Scenario F: metadata forwarding', () => {
  it('store forwards category metadata to client.remember', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    await gw.store('alice', 'Some memory', { category: 'preference' });

    const rememberCalls = client.remember.mock.calls;
    expect(rememberCalls[0][2]).toMatchObject({ category: 'preference' });
  });

  it('store forwards topic metadata to client.remember', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    await gw.store('alice', 'Some memory', { topic: 'food' });

    const rememberCalls = client.remember.mock.calls;
    expect(rememberCalls[0][2]).toMatchObject({ topic: 'food' });
  });

  it('store forwards title metadata to client.remember', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    await gw.store('alice', 'Some memory', { title: 'Sushi preference' });

    const rememberCalls = client.remember.mock.calls;
    expect(rememberCalls[0][2]).toMatchObject({ title: 'Sushi preference' });
  });

  it('store without metadata passes empty opts to client.remember', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    await gw.store('alice', 'Some memory');

    const rememberCalls = client.remember.mock.calls;
    // Third arg should be an object with no forbidden unknown keys.
    const meta = rememberCalls[0][2];
    expect(typeof meta).toBe('object');
    // Should NOT have category/topic/title if none were passed.
    expect(meta.category).toBeUndefined();
    expect(meta.topic).toBeUndefined();
    expect(meta.title).toBeUndefined();
  });
});

// ─── Scenario G: store error handling ────────────────────────────────────────

describe('MemoryGateway — recall+store roundtrip — Scenario G: store error handling', () => {
  it('store returns { ok: false, error } when client.remember throws', async () => {
    const { client } = makeStatefulClient();
    client.remember.mockRejectedValueOnce(new Error('disk full'));

    const gw = makeGateway(client);
    const result = await gw.store('alice', 'some text');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('disk full');
  });

  it('store with empty text returns { ok: false, error: "empty text" }', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    const result = await gw.store('alice', '');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('empty text');
  });

  it('store with whitespace-only text returns { ok: false }', async () => {
    const { client } = makeStatefulClient();
    const gw = makeGateway(client);

    const result = await gw.store('alice', '   ');
    expect(result.ok).toBe(false);
  });
});

// ─── Scenario H: recall error handling ───────────────────────────────────────

describe('MemoryGateway — recall+store roundtrip — Scenario H: recall error handling', () => {
  it('recall returns null (never throws) when client.search throws', async () => {
    const { client } = makeStatefulClient();
    client.search.mockRejectedValueOnce(new Error('network error'));

    const gw = makeGateway(client);
    await gw.store('alice', 'some content');

    // Force re-init by clearing the internal set — but search will throw.
    const result = await gw.recall('alice', 'query');
    expect(result).toBeNull();
  });

  it('recall returns null (never throws) when client.init throws', async () => {
    const { client } = makeStatefulClient();
    // Make init throw for the first call (before any real path is cached).
    client.init.mockRejectedValueOnce(new Error('init failed'));

    const gw = makeGateway(client);

    // recall() will try to init → throws → caught internally → returns null.
    const result = await gw.recall('brand-new-user', 'query');
    expect(result).toBeNull();
  });
});
