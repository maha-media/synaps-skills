/**
 * @file bridge/core/mcp/mcp-rate-limiter.test.js
 *
 * Vitest unit tests for McpRateLimiter (Phase 8 — Track 1).
 *
 * All time is virtualised via the `now` injection so no real waits are needed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { McpRateLimiter } from './mcp-rate-limiter.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a virtual clock starting at `startMs`.
 * Returns `{ now, advance }` where `advance(ms)` increments the clock.
 */
function makeClock(startMs = 1_000_000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

/**
 * Build a limiter with the given per-token / per-IP config and an injected
 * virtual clock.
 */
function makeLimiter({ tokenCapacity = 3, tokenRefill = 1, ipCapacity = 5, ipRefill = 2, clock } = {}) {
  const c = clock ?? makeClock();
  return {
    limiter: new McpRateLimiter({
      perToken: { capacity: tokenCapacity, refillPerSec: tokenRefill },
      perIp:    { capacity: ipCapacity,    refillPerSec: ipRefill },
      now:      c.now,
    }),
    clock: c,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('McpRateLimiter', () => {
  // ── 1. Constructor guards ──────────────────────────────────────────────────

  it('throws when perToken is missing', () => {
    expect(() => new McpRateLimiter({ perIp: { capacity: 10, refillPerSec: 1 } }))
      .toThrow(TypeError);
  });

  it('throws when perIp is missing', () => {
    expect(() => new McpRateLimiter({ perToken: { capacity: 10, refillPerSec: 1 } }))
      .toThrow(TypeError);
  });

  // ── 2. First request is always allowed (bucket starts full) ───────────────

  it('allows the first request (bucket starts full)', () => {
    const { limiter } = makeLimiter();
    const result = limiter.check({ tokenHash: 'abc', ip: '1.2.3.4' });
    expect(result.allowed).toBe(true);
  });

  // ── 3. Drains capacity, then blocks ───────────────────────────────────────

  it('blocks after capacity is exhausted', () => {
    const { limiter } = makeLimiter({ tokenCapacity: 3, tokenRefill: 1 });
    // 3 allowed
    expect(limiter.check({ tokenHash: 'tok', ip: '10.0.0.1' }).allowed).toBe(true);
    expect(limiter.check({ tokenHash: 'tok', ip: '10.0.0.1' }).allowed).toBe(true);
    expect(limiter.check({ tokenHash: 'tok', ip: '10.0.0.1' }).allowed).toBe(true);
    // 4th blocked (tokenHash bucket drained first since ipCapacity = 5)
    const blocked = limiter.check({ tokenHash: 'tok', ip: '10.0.0.1' });
    expect(blocked.allowed).toBe(false);
  });

  // ── 4. Refills over virtual time → allowed again ──────────────────────────

  it('allows requests again after bucket refills', () => {
    const clock = makeClock();
    const { limiter } = makeLimiter({ tokenCapacity: 2, tokenRefill: 1, ipCapacity: 10, ipRefill: 10, clock });

    // Drain token bucket.
    limiter.check({ tokenHash: 'tok2', ip: '5.5.5.5' });
    limiter.check({ tokenHash: 'tok2', ip: '5.5.5.5' });

    // Immediately blocked.
    expect(limiter.check({ tokenHash: 'tok2', ip: '5.5.5.5' }).allowed).toBe(false);

    // Advance 1 second — 1 token refilled.
    clock.advance(1_000);
    expect(limiter.check({ tokenHash: 'tok2', ip: '5.5.5.5' }).allowed).toBe(true);
  });

  // ── 5. Per-token vs per-IP independence ───────────────────────────────────

  it('different tokenHashes have independent buckets', () => {
    const { limiter } = makeLimiter({ tokenCapacity: 1, tokenRefill: 1, ipCapacity: 100, ipRefill: 10 });

    // Drain token bucket for 'tok-A'.
    limiter.check({ tokenHash: 'tok-A', ip: '9.9.9.9' });
    expect(limiter.check({ tokenHash: 'tok-A', ip: '9.9.9.9' }).allowed).toBe(false);

    // 'tok-B' should still have a full bucket.
    expect(limiter.check({ tokenHash: 'tok-B', ip: '9.9.9.9' }).allowed).toBe(true);
  });

  it('different IPs have independent buckets', () => {
    const { limiter } = makeLimiter({ tokenCapacity: 100, tokenRefill: 10, ipCapacity: 1, ipRefill: 1 });

    // Drain IP bucket for '1.1.1.1'.
    limiter.check({ tokenHash: 'common', ip: '1.1.1.1' });
    expect(limiter.check({ tokenHash: 'common', ip: '1.1.1.1' }).allowed).toBe(false);

    // '2.2.2.2' should still have a full bucket.
    expect(limiter.check({ tokenHash: 'common', ip: '2.2.2.2' }).allowed).toBe(true);
  });

  // ── 6. Null tokenHash skips the per-token bucket ──────────────────────────

  it('skips per-token check when tokenHash is null', () => {
    // Token capacity = 0 would always block, but null skips it.
    const clock = makeClock();
    const limiter = new McpRateLimiter({
      perToken: { capacity: 0, refillPerSec: 0.001 },
      perIp:    { capacity: 100, refillPerSec: 10 },
      now:      clock.now,
    });
    const result = limiter.check({ tokenHash: null, ip: '3.3.3.3' });
    expect(result.allowed).toBe(true);
  });

  it('skips per-token check when tokenHash is undefined', () => {
    const clock = makeClock();
    const limiter = new McpRateLimiter({
      perToken: { capacity: 0, refillPerSec: 0.001 },
      perIp:    { capacity: 100, refillPerSec: 10 },
      now:      clock.now,
    });
    const result = limiter.check({ ip: '3.3.3.3' });
    expect(result.allowed).toBe(true);
  });

  // ── 7. Null ip skips the per-IP bucket ───────────────────────────────────

  it('skips per-ip check when ip is null', () => {
    const clock = makeClock();
    const limiter = new McpRateLimiter({
      perToken: { capacity: 100, refillPerSec: 10 },
      perIp:    { capacity: 0, refillPerSec: 0.001 },
      now:      clock.now,
    });
    const result = limiter.check({ tokenHash: 'mytoken', ip: null });
    expect(result.allowed).toBe(true);
  });

  it('skips per-ip check when ip is undefined', () => {
    const clock = makeClock();
    const limiter = new McpRateLimiter({
      perToken: { capacity: 100, refillPerSec: 10 },
      perIp:    { capacity: 0, refillPerSec: 0.001 },
      now:      clock.now,
    });
    const result = limiter.check({ tokenHash: 'mytoken' });
    expect(result.allowed).toBe(true);
  });

  // ── 8. retryAfterMs is a positive number when blocked ─────────────────────

  it('retryAfterMs is a positive integer when token dimension blocks', () => {
    const { limiter } = makeLimiter({ tokenCapacity: 1, tokenRefill: 1, ipCapacity: 100, ipRefill: 10 });
    limiter.check({ tokenHash: 'tok', ip: '7.7.7.7' }); // drain
    const blocked = limiter.check({ tokenHash: 'tok', ip: '7.7.7.7' });
    expect(blocked.allowed).toBe(false);
    expect(typeof blocked.retryAfterMs).toBe('number');
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(Number.isInteger(blocked.retryAfterMs)).toBe(true);
  });

  it('retryAfterMs is a positive integer when IP dimension blocks', () => {
    const { limiter } = makeLimiter({ tokenCapacity: 100, tokenRefill: 10, ipCapacity: 1, ipRefill: 2 });
    limiter.check({ tokenHash: 'tok', ip: '8.8.8.8' }); // drain IP bucket
    const blocked = limiter.check({ tokenHash: 'tok', ip: '8.8.8.8' });
    expect(blocked.allowed).toBe(false);
    expect(typeof blocked.retryAfterMs).toBe('number');
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('retryAfterMs matches Math.ceil(1/refillPerSec * 1000)', () => {
    // perToken refillPerSec = 3 → Math.ceil(1000/3) = 334
    const { limiter } = makeLimiter({ tokenCapacity: 1, tokenRefill: 3, ipCapacity: 100, ipRefill: 10 });
    limiter.check({ tokenHash: 'tok', ip: '9.9.9.9' });
    const blocked = limiter.check({ tokenHash: 'tok', ip: '9.9.9.9' });
    expect(blocked.retryAfterMs).toBe(Math.ceil(1000 / 3));
  });

  // ── 9. scope correctly identifies which dimension blocked ─────────────────

  it('scope === "token" when token dimension blocks', () => {
    const { limiter } = makeLimiter({ tokenCapacity: 1, tokenRefill: 1, ipCapacity: 100, ipRefill: 10 });
    limiter.check({ tokenHash: 'tok', ip: '4.4.4.4' });
    const blocked = limiter.check({ tokenHash: 'tok', ip: '4.4.4.4' });
    expect(blocked.scope).toBe('token');
  });

  it('scope === "ip" when only IP dimension blocks', () => {
    const { limiter } = makeLimiter({ tokenCapacity: 100, tokenRefill: 10, ipCapacity: 1, ipRefill: 2 });
    limiter.check({ tokenHash: 'tok', ip: '6.6.6.6' });
    const blocked = limiter.check({ tokenHash: 'tok', ip: '6.6.6.6' });
    expect(blocked.scope).toBe('ip');
  });

  it('scope === "token" when both dimensions block (token takes priority)', () => {
    const clock = makeClock();
    const limiter = new McpRateLimiter({
      perToken: { capacity: 1, refillPerSec: 1 },
      perIp:    { capacity: 1, refillPerSec: 1 },
      now:      clock.now,
    });
    limiter.check({ tokenHash: 'tok', ip: '5.5.5.5' }); // drains both
    const blocked = limiter.check({ tokenHash: 'tok', ip: '5.5.5.5' });
    expect(blocked.allowed).toBe(false);
    expect(blocked.scope).toBe('token');
  });

  // ── 10. now injection works ────────────────────────────────────────────────

  it('uses the injected now() function for time', () => {
    const clock = makeClock(500_000);
    const { limiter } = makeLimiter({ tokenCapacity: 1, tokenRefill: 1, ipCapacity: 10, ipRefill: 5, clock });

    // Drain.
    limiter.check({ tokenHash: 'injected', ip: '1.1.1.1' });
    expect(limiter.check({ tokenHash: 'injected', ip: '1.1.1.1' }).allowed).toBe(false);

    // Real time hasn't moved, but virtual time has.
    clock.advance(2_000); // 2 s → 2 tokens refilled, capped at 1
    expect(limiter.check({ tokenHash: 'injected', ip: '1.1.1.1' }).allowed).toBe(true);
  });

  // ── 11. Pruning doesn't drop active (partially-drained) buckets ───────────

  it('does not prune buckets that still have active (drained) state', () => {
    const clock = makeClock();
    // Use PRUNE_INTERVAL=200 so we need 200 successful calls to trigger a prune.
    const limiter = new McpRateLimiter({
      perToken: { capacity: 1_000, refillPerSec: 0.001 },  // refills very slowly
      perIp:    { capacity: 1_000_000, refillPerSec: 100 },
      now:      clock.now,
    });

    // Drain the token bucket partially.
    for (let i = 0; i < 5; i++) limiter.check({ tokenHash: 'active', ip: '10.0.0.1' });

    // Advance time past the prune age BUT do NOT let the bucket fully refill.
    // 0.001 tokens/sec × 61 s = 0.061 tokens refilled — still << capacity (1000)
    clock.advance(61_000);

    // Fire 200 more requests to trigger the prune pass.
    for (let i = 0; i < 200; i++) limiter.check({ tokenHash: `burst-${i}`, ip: '10.0.0.1' });

    // The 'active' token bucket should still be tracked (was never at full capacity
    // for 60 s because it was drained before the advance).
    // Verify by checking that it is NOT re-initialised to full capacity.
    // If pruned & re-created, it would allow 1000 requests; if retained it has ~995.
    let allowed = 0;
    for (let i = 0; i < 1_000; i++) {
      const r = limiter.check({ tokenHash: 'active', ip: `unique-${i}` });
      if (r.allowed) allowed++;
      else break;
    }
    // Retained bucket should have been partially drained — not a full 1000.
    expect(allowed).toBeLessThan(1_000);
    expect(allowed).toBeGreaterThan(0);
  });

  // ── 12. Pruning removes fully-idle buckets ────────────────────────────────

  it('prunes idle full-capacity buckets after 60 s', () => {
    const clock = makeClock();
    // High refill rate so the bucket reaches full capacity quickly.
    const limiter = new McpRateLimiter({
      perToken: { capacity: 10, refillPerSec: 100 },  // fully refills in 0.1 s
      perIp:    { capacity: 1_000_000, refillPerSec: 1_000 },
      now:      clock.now,
    });

    // Create a bucket for 'idle-tok' by making one request.
    limiter.check({ tokenHash: 'idle-tok', ip: '1.1.1.1' });
    // Advance 1 s → bucket fully refills (100 tokens/s × 1 s >> capacity 10).
    clock.advance(1_000);
    // Make one more request so the lazy refill runs and lastRefillMs is set
    // to the *current* virtual time (t+1000).  The bucket is now full again.
    limiter.check({ tokenHash: 'idle-tok', ip: '1.1.1.1' });
    // Now advance another 1 s so the bucket is refilled back to capacity
    // and tick once more to record the refill timestamp.
    clock.advance(1_000);
    limiter.check({ tokenHash: 'idle-tok', ip: '1.1.1.1' });

    // Advance 61 s with NO further touches on 'idle-tok'.
    // After this, its lastRefillMs is >60 s in the past AND it will be at
    // full capacity once the next check triggers the lazy refill.
    clock.advance(61_000);

    // Fire 200 successful requests with *unique* token hashes.
    // Each one returns allowed=true → _callCount increments → prune fires at 200.
    for (let i = 0; i < 200; i++) {
      limiter.check({ tokenHash: `prune-tok-${i}`, ip: '2.2.2.2' });
    }

    // After the prune pass, 'idle-tok' should have been evicted.
    expect(limiter._tokenBuckets.has('idle-tok')).toBe(false);
  });
});
