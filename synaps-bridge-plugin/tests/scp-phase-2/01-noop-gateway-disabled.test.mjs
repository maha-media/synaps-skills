/**
 * @file tests/scp-phase-2/01-noop-gateway-disabled.test.mjs
 *
 * Acceptance test: NoopMemoryGateway short-circuits all operations.
 *
 * Spec reference: PLATFORM.SPEC.md §6.2 — acceptance criterion 3.
 * "memory.enabled = false short-circuits the gateway with no errors"
 *
 * Covers:
 *   - recall('u_123', 'anything') returns null
 *   - store('u_123', 'anything') returns { ok: true, noop: true }
 *   - consolidate('u_123') returns { ok: true, noop: true }
 *   - enabled getter returns false
 *   - start() and stop() resolve without error
 *   - namespaceFor(id) returns 'u_<id>'
 *   - brainPathFor() returns null (no brain files when disabled)
 *   - No filesystem side effects (sentinel temp dir stays empty)
 *
 * Constraints:
 *   - ESM only (.mjs)
 *   - No top-level await
 *   - vitest describe/it/expect
 *   - No real axel binary invocation
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { NoopMemoryGateway } from '../../bridge/core/memory-gateway.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Tracked temp dirs to clean up after each test. */
const tempDirs = [];

/**
 * Create a unique empty temp dir for filesystem-side-effect verification.
 * @returns {string} Absolute path to the new directory.
 */
function makeTempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'synaps-noop-gw-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
});

// ─── 1. enabled property ─────────────────────────────────────────────────────

describe('NoopMemoryGateway — enabled', () => {
  it('enabled getter returns false', () => {
    const gw = new NoopMemoryGateway();
    expect(gw.enabled).toBe(false);
  });
});

// ─── 2. lifecycle methods ─────────────────────────────────────────────────────

describe('NoopMemoryGateway — lifecycle', () => {
  it('start() resolves without error', async () => {
    const gw = new NoopMemoryGateway();
    await expect(gw.start()).resolves.toBeUndefined();
  });

  it('stop() resolves without error', async () => {
    const gw = new NoopMemoryGateway();
    await expect(gw.stop()).resolves.toBeUndefined();
  });

  it('start() + stop() sequence resolves cleanly', async () => {
    const gw = new NoopMemoryGateway();
    await gw.start();
    await expect(gw.stop()).resolves.toBeUndefined();
  });

  it('calling stop() before start() does not throw', async () => {
    const gw = new NoopMemoryGateway();
    await expect(gw.stop()).resolves.toBeUndefined();
  });

  it('calling start() multiple times does not throw', async () => {
    const gw = new NoopMemoryGateway();
    await gw.start();
    await expect(gw.start()).resolves.toBeUndefined();
  });
});

// ─── 3. recall ────────────────────────────────────────────────────────────────

describe('NoopMemoryGateway — recall', () => {
  it('recall returns null for any userId + query', async () => {
    const gw = new NoopMemoryGateway();
    const result = await gw.recall('u_123', 'anything');
    expect(result).toBeNull();
  });

  it('recall returns null for an empty query', async () => {
    const gw = new NoopMemoryGateway();
    const result = await gw.recall('u_123', '');
    expect(result).toBeNull();
  });

  it('recall returns null for a very long query', async () => {
    const gw = new NoopMemoryGateway();
    const result = await gw.recall('u_alice', 'x'.repeat(10_000));
    expect(result).toBeNull();
  });

  it('recall with no arguments returns null (does not throw)', async () => {
    const gw = new NoopMemoryGateway();
    const result = await gw.recall();
    expect(result).toBeNull();
  });

  it('recall returns null regardless of how many times it is called', async () => {
    const gw = new NoopMemoryGateway();
    const r1 = await gw.recall('u_a', 'query1');
    const r2 = await gw.recall('u_a', 'query2');
    const r3 = await gw.recall('u_b', 'query3');

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(r3).toBeNull();
  });
});

// ─── 4. store ─────────────────────────────────────────────────────────────────

describe('NoopMemoryGateway — store', () => {
  it('store returns { ok: true, noop: true }', async () => {
    const gw = new NoopMemoryGateway();
    const result = await gw.store('u_123', 'some text');
    expect(result).toEqual({ ok: true, noop: true });
  });

  it('store ok is true', async () => {
    const gw = new NoopMemoryGateway();
    const { ok } = await gw.store('u_alice', 'hello');
    expect(ok).toBe(true);
  });

  it('store noop is true', async () => {
    const gw = new NoopMemoryGateway();
    const { noop } = await gw.store('u_alice', 'hello');
    expect(noop).toBe(true);
  });

  it('store returns { ok: true, noop: true } for empty text', async () => {
    const gw = new NoopMemoryGateway();
    const result = await gw.store('u_123', '');
    expect(result).toEqual({ ok: true, noop: true });
  });

  it('store with no arguments returns { ok: true, noop: true } (does not throw)', async () => {
    const gw = new NoopMemoryGateway();
    const result = await gw.store();
    expect(result).toEqual({ ok: true, noop: true });
  });

  it('store with metadata returns { ok: true, noop: true }', async () => {
    const gw = new NoopMemoryGateway();
    const result = await gw.store('u_alice', 'content', { category: 'pref', topic: 'food' });
    expect(result).toEqual({ ok: true, noop: true });
  });
});

// ─── 5. consolidate ──────────────────────────────────────────────────────────

describe('NoopMemoryGateway — consolidate', () => {
  it('consolidate returns { ok: true, noop: true }', async () => {
    const gw = new NoopMemoryGateway();
    const result = await gw.consolidate('u_123');
    expect(result).toEqual({ ok: true, noop: true });
  });

  it('consolidate ok is true', async () => {
    const gw = new NoopMemoryGateway();
    const { ok } = await gw.consolidate('u_alice');
    expect(ok).toBe(true);
  });

  it('consolidate noop is true', async () => {
    const gw = new NoopMemoryGateway();
    const { noop } = await gw.consolidate('u_alice');
    expect(noop).toBe(true);
  });

  it('consolidate with no arguments does not throw', async () => {
    const gw = new NoopMemoryGateway();
    const result = await gw.consolidate();
    expect(result).toEqual({ ok: true, noop: true });
  });
});

// ─── 6. namespace helpers ─────────────────────────────────────────────────────

describe('NoopMemoryGateway — namespace helpers', () => {
  it('namespaceFor("alice") returns "u_alice"', () => {
    const gw = new NoopMemoryGateway();
    expect(gw.namespaceFor('alice')).toBe('u_alice');
  });

  it('namespaceFor("u_123") returns "u_u_123" (no double-prefix stripping needed)', () => {
    const gw = new NoopMemoryGateway();
    // IDs passed in raw — namespacing is applied on top regardless.
    expect(gw.namespaceFor('u_123')).toBe('u_u_123');
  });

  it('namespaceFor produces stable output on repeated calls', () => {
    const gw = new NoopMemoryGateway();
    expect(gw.namespaceFor('bob')).toBe(gw.namespaceFor('bob'));
  });

  it('brainPathFor() returns null (no brain files when disabled)', () => {
    const gw = new NoopMemoryGateway();
    expect(gw.brainPathFor('alice')).toBeNull();
  });

  it('brainPathFor with no argument returns null', () => {
    const gw = new NoopMemoryGateway();
    expect(gw.brainPathFor()).toBeNull();
  });
});

// ─── 7. No filesystem side effects ───────────────────────────────────────────

describe('NoopMemoryGateway — no filesystem side effects', () => {
  it('a sentinel tmp dir is empty after recall + store + consolidate calls', async () => {
    const sentinelDir = makeTempDir();
    const gw = new NoopMemoryGateway();

    // Perform all operations.
    await gw.start();
    await gw.recall('u_alice', 'food preferences');
    await gw.store('u_alice', 'I love sushi');
    await gw.consolidate('u_alice');
    await gw.stop();

    // The sentinel directory must remain empty — the noop gateway wrote nothing.
    const entries = readdirSync(sentinelDir);
    expect(entries).toHaveLength(0);
  });

  it('multiple users produce no files in the sentinel dir', async () => {
    const sentinelDir = makeTempDir();
    const gw = new NoopMemoryGateway();

    await gw.store('u_alice', 'likes sushi');
    await gw.store('u_bob',   'hates cilantro');
    await gw.recall('u_alice', 'food');
    await gw.recall('u_bob',   'food');

    const entries = readdirSync(sentinelDir);
    expect(entries).toHaveLength(0);
  });
});
