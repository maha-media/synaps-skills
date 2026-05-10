/**
 * @file slack-bot-gate.test.js
 *
 * Tests for SlackBotGate.
 */

import { describe, it, expect } from 'vitest';
import { SlackBotGate } from './slack-bot-gate.js';

const CTX = { source: 'slack', conversation: 'C123', thread: '1234.5678' };

describe('SlackBotGate — AI-app mode (default)', () => {
  it('aiAppMode defaults to true', () => {
    const gate = new SlackBotGate();
    expect(gate.aiAppMode).toBe(true);
  });

  it('evaluate returns { allowed: true } with no options', () => {
    const gate = new SlackBotGate();
    expect(gate.evaluate(CTX)).toEqual({ allowed: true });
  });

  it('evaluate returns { allowed: true } even when maxTurnsPerThread is 0', () => {
    const gate = new SlackBotGate({ aiAppMode: true, maxTurnsPerThread: 0 });
    expect(gate.evaluate(CTX)).toEqual({ allowed: true });
  });

  it('evaluate returns { allowed: true } after many recorded turns (turn limit ignored)', () => {
    const gate = new SlackBotGate({ aiAppMode: true, maxTurnsPerThread: 3 });
    gate.recordTurn(CTX);
    gate.recordTurn(CTX);
    gate.recordTurn(CTX);
    gate.recordTurn(CTX); // 4th — exceeds limit in base logic
    expect(gate.evaluate(CTX)).toEqual({ allowed: true });
  });

  it('evaluate returns { allowed: true } regardless of sender or text fields', () => {
    const gate = new SlackBotGate({ aiAppMode: true });
    const result = gate.evaluate({ ...CTX, sender: 'U999', text: 'hi there' });
    expect(result).toEqual({ allowed: true });
  });
});

describe('SlackBotGate — legacy mode (aiAppMode: false)', () => {
  it('aiAppMode=false falls back to base BotGate evaluate', () => {
    const gate = new SlackBotGate({ aiAppMode: false, maxTurnsPerThread: 5 });
    expect(gate.evaluate(CTX)).toEqual({ allowed: true });
  });

  it('aiAppMode=false enforces turn limit after maxTurnsPerThread reached', () => {
    const gate = new SlackBotGate({ aiAppMode: false, maxTurnsPerThread: 2 });
    gate.recordTurn(CTX);
    gate.recordTurn(CTX);
    const result = gate.evaluate(CTX);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('turn_limit_exceeded');
  });

  it('aiAppMode=false — gate allows turns below the limit', () => {
    const gate = new SlackBotGate({ aiAppMode: false, maxTurnsPerThread: 3 });
    gate.recordTurn(CTX);
    expect(gate.evaluate(CTX)).toEqual({ allowed: true });
  });
});

describe('SlackBotGate — recordTurn / reset', () => {
  it('recordTurn increments the internal counter regardless of aiAppMode', () => {
    const gate = new SlackBotGate({ aiAppMode: false, maxTurnsPerThread: 2 });
    gate.recordTurn(CTX);
    gate.recordTurn(CTX);
    // Now at limit; evaluate should deny.
    expect(gate.evaluate(CTX).allowed).toBe(false);
  });

  it('reset clears the counter so evaluate allows again', () => {
    const gate = new SlackBotGate({ aiAppMode: false, maxTurnsPerThread: 1 });
    gate.recordTurn(CTX);
    expect(gate.evaluate(CTX).allowed).toBe(false);

    gate.reset(CTX);
    expect(gate.evaluate(CTX).allowed).toBe(true);
  });

  it('recordTurn works in aiAppMode=true (no-op on gate outcome but counter increments)', () => {
    const gate = new SlackBotGate({ aiAppMode: true });
    gate.recordTurn(CTX);
    gate.recordTurn(CTX);
    // Still allowed because aiAppMode=true short-circuits.
    expect(gate.evaluate(CTX)).toEqual({ allowed: true });
  });
});
