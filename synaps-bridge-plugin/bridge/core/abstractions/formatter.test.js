/**
 * @file formatter.test.js
 * Tests for bridge/core/abstractions/formatter.js
 */
import { describe, it, expect } from 'vitest';
import { Formatter } from './formatter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal concrete subclass that implements all three abstract methods. */
class ConcreteFormatter extends Formatter {
  formatMarkdown(md)   { return `**${md}**`; }
  formatError(err)     { return `ERROR: ${err.message ?? err}`; }
  formatSubagent(state) { return `[${state.status}] ${state.agent_name}`; }
}

/** Subclass that explicitly delegates to super to expose the "not implemented" paths. */
class StubFormatter extends Formatter {
  formatMarkdown(md)    { return super.formatMarkdown(md); }
  formatError(err)      { return super.formatError(err); }
  formatSubagent(state) { return super.formatSubagent(state); }
}

// ---------------------------------------------------------------------------
// Abstract guard
// ---------------------------------------------------------------------------

describe('Formatter (abstract)', () => {
  it('throws when instantiated directly', () => {
    expect(() => new Formatter()).toThrow('Formatter is abstract');
  });
});

// ---------------------------------------------------------------------------
// Default method stubs — each must throw "not implemented"
// ---------------------------------------------------------------------------

describe('Formatter default method stubs', () => {
  const stub = new StubFormatter();

  it('formatMarkdown() throws "not implemented"', () => {
    expect(() => stub.formatMarkdown('# hello')).toThrow('not implemented');
  });

  it('formatError() throws "not implemented"', () => {
    expect(() => stub.formatError(new Error('boom'))).toThrow('not implemented');
  });

  it('formatSubagent() throws "not implemented"', () => {
    expect(() =>
      stub.formatSubagent({ id: '1', agent_name: 'bot', status: 'running' }),
    ).toThrow('not implemented');
  });
});

// ---------------------------------------------------------------------------
// ConcreteFormatter — exercising every method
// ---------------------------------------------------------------------------

describe('ConcreteFormatter', () => {
  const f = new ConcreteFormatter();

  it('can be instantiated (extends Formatter)', () => {
    expect(f).toBeInstanceOf(Formatter);
  });

  it('formatMarkdown wraps text in bold markdown', () => {
    expect(f.formatMarkdown('hello')).toBe('**hello**');
  });

  it('formatMarkdown accepts empty string', () => {
    expect(f.formatMarkdown('')).toBe('****');
  });

  it('formatError formats an Error object', () => {
    expect(f.formatError(new Error('something broke'))).toBe('ERROR: something broke');
  });

  it('formatError accepts non-Error values gracefully', () => {
    // A plain string has no .message property — the implementation falls back
    // to the value itself via the `?? err` coercion, yielding 'ERROR: raw string'.
    expect(f.formatError('raw string')).toBe('ERROR: raw string');
  });

  it('formatSubagent formats pending state', () => {
    const state = { id: 'a1', agent_name: 'researcher', status: 'pending' };
    expect(f.formatSubagent(state)).toBe('[pending] researcher');
  });

  it('formatSubagent formats running state', () => {
    const state = { id: 'a2', agent_name: 'writer', status: 'running', task_preview: 'Draft intro' };
    expect(f.formatSubagent(state)).toBe('[running] writer');
  });

  it('formatSubagent formats done state', () => {
    const state = {
      id: 'a3', agent_name: 'analyst', status: 'done',
      result_preview: 'Summary complete', duration_secs: 12,
    };
    expect(f.formatSubagent(state)).toBe('[done] analyst');
  });

  it('formatSubagent formats failed state', () => {
    const state = { id: 'a4', agent_name: 'broken', status: 'failed', duration_secs: 1 };
    expect(f.formatSubagent(state)).toBe('[failed] broken');
  });
});
