/**
 * @file discord-bot-gate.test.js
 *
 * Tests for DiscordBotGate.
 */

import { describe, it, expect } from 'vitest';
import { DiscordBotGate } from './discord-bot-gate.js';

const CTX = { source: 'discord', conversation: '1234567890', thread: '9876543210' };

describe('DiscordBotGate — default behavior', () => {
  it('can be constructed with no options', () => {
    expect(() => new DiscordBotGate()).not.toThrow();
  });

  it('evaluate returns { allowed: true } when no turns recorded', () => {
    const gate = new DiscordBotGate();
    expect(gate.evaluate(CTX)).toEqual({ allowed: true });
  });

  it('evaluate allows turns below maxTurnsPerThread', () => {
    const gate = new DiscordBotGate({ maxTurnsPerThread: 3 });
    gate.recordTurn(CTX);
    gate.recordTurn(CTX);
    expect(gate.evaluate(CTX)).toEqual({ allowed: true });
  });

  it('evaluate denies when maxTurnsPerThread is reached', () => {
    const gate = new DiscordBotGate({ maxTurnsPerThread: 2 });
    gate.recordTurn(CTX);
    gate.recordTurn(CTX);
    const result = gate.evaluate(CTX);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('turn_limit_exceeded');
  });

  it('evaluate uses Infinity limit by default (always allows)', () => {
    const gate = new DiscordBotGate();
    for (let i = 0; i < 100; i++) gate.recordTurn(CTX);
    expect(gate.evaluate(CTX)).toEqual({ allowed: true });
  });
});

describe('DiscordBotGate — recordTurn / reset', () => {
  it('reset clears the counter so evaluate allows again', () => {
    const gate = new DiscordBotGate({ maxTurnsPerThread: 1 });
    gate.recordTurn(CTX);
    expect(gate.evaluate(CTX).allowed).toBe(false);

    gate.reset(CTX);
    expect(gate.evaluate(CTX).allowed).toBe(true);
  });

  it('accepts an injected logger', () => {
    const logger = { warn: () => {}, info: () => {} };
    const gate = new DiscordBotGate({ logger });
    expect(gate.logger).toBe(logger);
  });
});
