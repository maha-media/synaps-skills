/**
 * @file stream-handle.test.js
 * Tests for bridge/core/abstractions/stream-handle.js
 */
import { describe, it, expect } from 'vitest';
import { StreamHandle } from './stream-handle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal concrete implementation that records every call so we can assert
 * the correct arguments were forwarded.
 */
class ConcreteStreamHandle extends StreamHandle {
  constructor() {
    super();
    this.calls = [];
  }

  async start(opts = {}) {
    this.calls.push({ method: 'start', opts });
  }

  async append(chunk) {
    this.calls.push({ method: 'append', chunk });
  }

  async stop(opts = {}) {
    this.calls.push({ method: 'stop', opts });
  }
}

/**
 * Subclass that delegates every call to `super` so we can test the default
 * "not implemented" throws.
 */
class StubStreamHandle extends StreamHandle {
  async start(opts)   { return super.start(opts); }
  async append(chunk) { return super.append(chunk); }
  async stop(opts)    { return super.stop(opts); }
}

// ---------------------------------------------------------------------------
// Abstract guard
// ---------------------------------------------------------------------------

describe('StreamHandle (abstract)', () => {
  it('throws when instantiated directly', () => {
    expect(() => new StreamHandle()).toThrow('StreamHandle is abstract');
  });
});

// ---------------------------------------------------------------------------
// Default method stubs — each must throw "not implemented"
// ---------------------------------------------------------------------------

describe('StreamHandle default method stubs', () => {
  const stub = new StubStreamHandle();

  it('start() throws "not implemented"', async () => {
    await expect(stub.start()).rejects.toThrow('not implemented');
  });

  it('append() throws "not implemented"', async () => {
    await expect(stub.append({ type: 'markdown_text', content: 'hi' })).rejects.toThrow('not implemented');
  });

  it('stop() throws "not implemented"', async () => {
    await expect(stub.stop()).rejects.toThrow('not implemented');
  });
});

// ---------------------------------------------------------------------------
// ConcreteStreamHandle — exercising every method
// ---------------------------------------------------------------------------

describe('ConcreteStreamHandle', () => {
  it('can be instantiated', () => {
    expect(() => new ConcreteStreamHandle()).not.toThrow();
  });

  it('is an instance of StreamHandle', () => {
    expect(new ConcreteStreamHandle()).toBeInstanceOf(StreamHandle);
  });
});

describe('ConcreteStreamHandle#start', () => {
  it('records the call with default empty opts', async () => {
    const h = new ConcreteStreamHandle();
    await h.start();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].method).toBe('start');
  });

  it('forwards conversation, thread, recipient', async () => {
    const h = new ConcreteStreamHandle();
    await h.start({ conversation: 'C1', thread: 'T1', recipient: 'U1' });
    expect(h.calls[0].opts).toEqual({ conversation: 'C1', thread: 'T1', recipient: 'U1' });
  });

  it('returns a Promise', () => {
    const h = new ConcreteStreamHandle();
    expect(h.start()).toBeInstanceOf(Promise);
  });
});

describe('ConcreteStreamHandle#append', () => {
  it('records markdown_text chunk', async () => {
    const h = new ConcreteStreamHandle();
    const chunk = { type: 'markdown_text', content: 'hello' };
    await h.append(chunk);
    expect(h.calls[0]).toEqual({ method: 'append', chunk });
  });

  it('records task_update chunk', async () => {
    const h = new ConcreteStreamHandle();
    const chunk = { type: 'task_update', task: { id: 'a1', status: 'running' } };
    await h.append(chunk);
    expect(h.calls[0].chunk.type).toBe('task_update');
    expect(h.calls[0].chunk.task).toEqual({ id: 'a1', status: 'running' });
  });

  it('records plan_update chunk', async () => {
    const h = new ConcreteStreamHandle();
    const chunk = { type: 'plan_update', plan: { step: 1 } };
    await h.append(chunk);
    expect(h.calls[0].chunk.type).toBe('plan_update');
  });

  it('records blocks chunk', async () => {
    const h = new ConcreteStreamHandle();
    const chunk = { type: 'blocks', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }] };
    await h.append(chunk);
    expect(h.calls[0].chunk.type).toBe('blocks');
  });

  it('accumulates multiple appends in order', async () => {
    const h = new ConcreteStreamHandle();
    await h.append({ type: 'markdown_text', content: 'a' });
    await h.append({ type: 'markdown_text', content: 'b' });
    await h.append({ type: 'markdown_text', content: 'c' });
    expect(h.calls).toHaveLength(3);
    expect(h.calls.map(c => c.chunk.content)).toEqual(['a', 'b', 'c']);
  });
});

describe('ConcreteStreamHandle#stop', () => {
  it('records the call with default empty opts', async () => {
    const h = new ConcreteStreamHandle();
    await h.stop();
    expect(h.calls[0].method).toBe('stop');
  });

  it('forwards blocks option', async () => {
    const h = new ConcreteStreamHandle();
    const blocks = [{ type: 'divider' }];
    await h.stop({ blocks });
    expect(h.calls[0].opts.blocks).toBe(blocks);
  });

  it('full lifecycle: start → append × 2 → stop is recorded in order', async () => {
    const h = new ConcreteStreamHandle();
    await h.start({ conversation: 'C1', thread: 'T1' });
    await h.append({ type: 'markdown_text', content: 'Hello ' });
    await h.append({ type: 'markdown_text', content: 'world' });
    await h.stop({ blocks: [] });

    expect(h.calls.map(c => c.method)).toEqual(['start', 'append', 'append', 'stop']);
  });
});
