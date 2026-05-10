/**
 * @file bot-gate.test.js
 * Tests for bridge/core/abstractions/bot-gate.js
 */
import { describe, it, expect } from 'vitest';
import { BotGate } from './bot-gate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CTX = { source: 'platform-a', conversation: 'C123', thread: 'T456' };
const CTX2 = { source: 'platform-a', conversation: 'C123', thread: 'T789' };
const CTX3 = { source: 'platform-b', conversation: 'G000', thread: 'T000' };

// ---------------------------------------------------------------------------
// BotGate — construction (concrete class, no abstract guard)
// ---------------------------------------------------------------------------

describe('BotGate construction', () => {
  it('can be instantiated directly (it is concrete)', () => {
    expect(() => new BotGate()).not.toThrow();
  });

  it('defaults: maxTurnsPerThread = Infinity, logger = console', () => {
    const g = new BotGate();
    expect(g.maxTurnsPerThread).toBe(Infinity);
    expect(g.logger).toBe(console);
  });

  it('accepts custom maxTurnsPerThread and logger', () => {
    const logger = { warn: () => {} };
    const g = new BotGate({ maxTurnsPerThread: 5, logger });
    expect(g.maxTurnsPerThread).toBe(5);
    expect(g.logger).toBe(logger);
  });
});

// ---------------------------------------------------------------------------
// BotGate — evaluate (default implementation)
// ---------------------------------------------------------------------------

describe('BotGate#evaluate — default (unlimited)', () => {
  it('returns { allowed: true } with no prior turns', () => {
    const g = new BotGate();
    const result = g.evaluate(CTX);
    expect(result).toEqual({ allowed: true });
  });

  it('returns { allowed: true } after many turns when limit is Infinity', () => {
    const g = new BotGate();
    for (let i = 0; i < 1000; i++) g.recordTurn(CTX);
    expect(g.evaluate(CTX)).toEqual({ allowed: true });
  });
});

describe('BotGate#evaluate — turn limit enforcement', () => {
  it('returns { allowed: true } up to the limit', () => {
    const g = new BotGate({ maxTurnsPerThread: 2 });
    expect(g.evaluate(CTX)).toEqual({ allowed: true });
    g.recordTurn(CTX);
    expect(g.evaluate(CTX)).toEqual({ allowed: true });
  });

  it('returns { allowed: false, reason: "turn_limit_exceeded" } at the limit', () => {
    const g = new BotGate({ maxTurnsPerThread: 2 });
    g.recordTurn(CTX);
    g.recordTurn(CTX);
    const result = g.evaluate(CTX);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('turn_limit_exceeded');
  });

  it('enforces limit per key independently', () => {
    const g = new BotGate({ maxTurnsPerThread: 1 });
    g.recordTurn(CTX);
    // CTX is exhausted, CTX2 is fresh
    expect(g.evaluate(CTX)).toMatchObject({ allowed: false });
    expect(g.evaluate(CTX2)).toEqual({ allowed: true });
  });

  it('handles different sources independently', () => {
    const g = new BotGate({ maxTurnsPerThread: 1 });
    g.recordTurn(CTX);
    expect(g.evaluate(CTX3)).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// BotGate — evaluate accepts optional sender / text without error
// ---------------------------------------------------------------------------

describe('BotGate#evaluate — optional fields', () => {
  it('accepts sender and text without throwing', () => {
    const g = new BotGate();
    expect(() =>
      g.evaluate({ ...CTX, sender: 'U001', text: 'hello' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// BotGate — recordTurn
// ---------------------------------------------------------------------------

describe('BotGate#recordTurn', () => {
  it('increments the counter on each call', () => {
    const g = new BotGate({ maxTurnsPerThread: 3 });
    g.recordTurn(CTX);
    expect(g.evaluate(CTX)).toEqual({ allowed: true }); // 1 < 3

    g.recordTurn(CTX);
    expect(g.evaluate(CTX)).toEqual({ allowed: true }); // 2 < 3

    g.recordTurn(CTX);
    expect(g.evaluate(CTX)).toMatchObject({ allowed: false }); // 3 >= 3
  });

  it('does not affect other thread keys', () => {
    const g = new BotGate({ maxTurnsPerThread: 1 });
    g.recordTurn(CTX);
    expect(g.evaluate(CTX2)).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// BotGate — reset
// ---------------------------------------------------------------------------

describe('BotGate#reset', () => {
  it('clears the turn counter so evaluate returns allowed again', () => {
    const g = new BotGate({ maxTurnsPerThread: 1 });
    g.recordTurn(CTX);
    expect(g.evaluate(CTX)).toMatchObject({ allowed: false });

    g.reset(CTX);
    expect(g.evaluate(CTX)).toEqual({ allowed: true });
  });

  it('does not affect other thread keys', () => {
    const g = new BotGate({ maxTurnsPerThread: 1 });
    g.recordTurn(CTX);
    g.recordTurn(CTX2);
    g.reset(CTX);

    expect(g.evaluate(CTX)).toEqual({ allowed: true });
    expect(g.evaluate(CTX2)).toMatchObject({ allowed: false });
  });

  it('is safe to call when no turns have been recorded (no-op)', () => {
    const g = new BotGate();
    expect(() => g.reset(CTX)).not.toThrow();
    expect(g.evaluate(CTX)).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// BotGate — subclassing
// ---------------------------------------------------------------------------

describe('BotGate subclassing', () => {
  class AlwaysDenyGate extends BotGate {
    evaluate(ctx) {
      return { allowed: false, reason: 'always_deny' };
    }
  }

  it('subclass can override evaluate', () => {
    const g = new AlwaysDenyGate();
    expect(g.evaluate(CTX)).toEqual({ allowed: false, reason: 'always_deny' });
  });

  it('subclass still inherits recordTurn and reset', () => {
    const g = new AlwaysDenyGate({ maxTurnsPerThread: 1 });
    g.recordTurn(CTX);
    g.reset(CTX);
    // _counts is cleared — base class internals work even in subclass
    expect(g._counts.has(`${CTX.source}|${CTX.conversation}|${CTX.thread}`)).toBe(false);
  });
});
