/**
 * @file tool-progress-renderer.test.js
 * Tests for bridge/core/abstractions/tool-progress-renderer.js
 */
import { describe, it, expect } from 'vitest';
import { ToolProgressRenderer } from './tool-progress-renderer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal concrete implementation.
 * Returns a plain object describing the call so assertions can inspect it.
 */
class ConcreteToolProgressRenderer extends ToolProgressRenderer {
  render({ toolName, toolId, input, result, error }) {
    return { toolName, toolId, input, result, error };
  }
}

/**
 * Subclass that calls super.render() so we can test the default "not implemented" throw.
 */
class StubToolProgressRenderer extends ToolProgressRenderer {
  render(args) { return super.render(args); }
}

// ---------------------------------------------------------------------------
// Abstract guard
// ---------------------------------------------------------------------------

describe('ToolProgressRenderer (abstract)', () => {
  it('throws when instantiated directly', () => {
    expect(() => new ToolProgressRenderer()).toThrow('ToolProgressRenderer is abstract');
  });
});

// ---------------------------------------------------------------------------
// Default method stub — render must throw "not implemented"
// ---------------------------------------------------------------------------

describe('ToolProgressRenderer default method stub', () => {
  it('render() throws "not implemented"', () => {
    const stub = new StubToolProgressRenderer();
    expect(() =>
      stub.render({ toolName: 'bash', toolId: 't1', input: {} }),
    ).toThrow('not implemented');
  });
});

// ---------------------------------------------------------------------------
// ConcreteToolProgressRenderer — exercising render
// ---------------------------------------------------------------------------

describe('ConcreteToolProgressRenderer', () => {
  const r = new ConcreteToolProgressRenderer();

  it('can be instantiated', () => {
    expect(() => new ConcreteToolProgressRenderer()).not.toThrow();
  });

  it('is an instance of ToolProgressRenderer', () => {
    expect(r).toBeInstanceOf(ToolProgressRenderer);
  });

  it('render returns expected shape for an in-progress call (no result/error)', () => {
    const out = r.render({ toolName: 'read_file', toolId: 'tc_001', input: { path: '/tmp/a' } });
    expect(out).toEqual({
      toolName: 'read_file',
      toolId:   'tc_001',
      input:    { path: '/tmp/a' },
      result:   undefined,
      error:    undefined,
    });
  });

  it('render forwards result payload', () => {
    const out = r.render({
      toolName: 'search_web',
      toolId:   'tc_002',
      input:    { query: 'vitest' },
      result:   { hits: 10 },
    });
    expect(out.result).toEqual({ hits: 10 });
    expect(out.error).toBeUndefined();
  });

  it('render forwards error payload', () => {
    const out = r.render({
      toolName: 'bash',
      toolId:   'tc_003',
      input:    { cmd: 'rm -rf /' },
      error:    new Error('permission denied'),
    });
    expect(out.error).toBeInstanceOf(Error);
    expect(out.result).toBeUndefined();
  });

  it('render accepts null input (streaming input not yet complete)', () => {
    const out = r.render({ toolName: 'bash', toolId: 'tc_004', input: null });
    expect(out.input).toBeNull();
  });

  it('render is synchronous (does not return a Promise by default)', () => {
    const out = r.render({ toolName: 'x', toolId: 'y', input: {} });
    expect(out).not.toBeInstanceOf(Promise);
  });
});
