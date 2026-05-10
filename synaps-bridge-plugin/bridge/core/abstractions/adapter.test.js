/**
 * @file adapter.test.js
 * Tests for bridge/core/abstractions/adapter.js
 */
import { describe, it, expect } from 'vitest';
import { AdapterInstance, DEFAULT_CAPABILITIES } from './adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal concrete subclass — implements both abstract methods.
 */
class ConcreteAdapter extends AdapterInstance {
  constructor(opts) {
    super(opts);
    this.started = false;
    this.stopped = false;
  }
  async start() { this.started = true; }
  async stop()  { this.stopped = true; }
}

// ---------------------------------------------------------------------------
// DEFAULT_CAPABILITIES
// ---------------------------------------------------------------------------

describe('DEFAULT_CAPABILITIES', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_CAPABILITIES)).toBe(true);
  });

  it('contains exactly the eight expected flags, all false', () => {
    const keys = [
      'streaming', 'richStreamChunks', 'buttons', 'files',
      'reactions', 'threading', 'auxBlocks', 'aiAppMode',
    ];
    expect(Object.keys(DEFAULT_CAPABILITIES).sort()).toEqual(keys.sort());
    for (const k of keys) {
      expect(DEFAULT_CAPABILITIES[k]).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AdapterInstance — abstract guard
// ---------------------------------------------------------------------------

describe('AdapterInstance (abstract)', () => {
  it('throws when instantiated directly', () => {
    expect(() => new AdapterInstance()).toThrow('AdapterInstance is abstract');
  });
});

// ---------------------------------------------------------------------------
// AdapterInstance — default method guards
// ---------------------------------------------------------------------------

describe('AdapterInstance default method stubs', () => {
  // Use a subclass that deliberately does NOT override start/stop so we can
  // call the super implementations.
  class StubAdapter extends AdapterInstance {
    async start() { return super.start(); }
    async stop()  { return super.stop();  }
  }

  const stub = new StubAdapter({ source: 'test' });

  it('start() throws "not implemented"', async () => {
    await expect(stub.start()).rejects.toThrow('not implemented');
  });

  it('stop() throws "not implemented"', async () => {
    await expect(stub.stop()).rejects.toThrow('not implemented');
  });
});

// ---------------------------------------------------------------------------
// ConcreteAdapter — construction
// ---------------------------------------------------------------------------

describe('ConcreteAdapter construction', () => {
  it('accepts no arguments (uses defaults)', () => {
    const a = new ConcreteAdapter();
    expect(a.source).toBeUndefined();
    expect(a.capabilities).toEqual(DEFAULT_CAPABILITIES);
    expect(a.logger).toBe(console);
  });

  it('stores source string', () => {
    const a = new ConcreteAdapter({ source: 'platform-a' });
    expect(a.source).toBe('platform-a');
  });

  it('merges capabilities with defaults', () => {
    const a = new ConcreteAdapter({ capabilities: { streaming: true, threading: true } });
    expect(a.capabilities.streaming).toBe(true);
    expect(a.capabilities.threading).toBe(true);
    // untouched flags stay false
    expect(a.capabilities.buttons).toBe(false);
    expect(a.capabilities.aiAppMode).toBe(false);
  });

  it('freezes the merged capabilities object', () => {
    const a = new ConcreteAdapter({ capabilities: { streaming: true } });
    expect(Object.isFrozen(a.capabilities)).toBe(true);
  });

  it('accepts a custom logger', () => {
    const logger = { info: () => {} };
    const a = new ConcreteAdapter({ logger });
    expect(a.logger).toBe(logger);
  });

  it('does not mutate DEFAULT_CAPABILITIES when overrides are provided', () => {
    new ConcreteAdapter({ capabilities: { streaming: true } });
    expect(DEFAULT_CAPABILITIES.streaming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ConcreteAdapter — lifecycle methods
// ---------------------------------------------------------------------------

describe('ConcreteAdapter lifecycle', () => {
  it('start() resolves and sets started flag', async () => {
    const a = new ConcreteAdapter({ source: 'test' });
    await a.start();
    expect(a.started).toBe(true);
  });

  it('stop() resolves and sets stopped flag', async () => {
    const a = new ConcreteAdapter({ source: 'test' });
    await a.stop();
    expect(a.stopped).toBe(true);
  });
});
