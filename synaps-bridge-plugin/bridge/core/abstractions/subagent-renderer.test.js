/**
 * @file subagent-renderer.test.js
 * Tests for bridge/core/abstractions/subagent-renderer.js
 */
import { describe, it, expect } from 'vitest';
import { SubagentRenderer } from './subagent-renderer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal concrete implementation.
 * Returns a plain object so assertions can inspect what was passed in.
 */
class ConcreteSubagentRenderer extends SubagentRenderer {
  render(state) {
    return { rendered: true, state };
  }
}

/**
 * Subclass that calls super.render() to expose the "not implemented" throw.
 */
class StubSubagentRenderer extends SubagentRenderer {
  render(state) { return super.render(state); }
}

// ---------------------------------------------------------------------------
// Sample SubagentState fixtures
// ---------------------------------------------------------------------------

const PENDING_STATE = {
  id: 'sa_001',
  agent_name: 'researcher',
  status: 'pending',
  task_preview: 'Find recent papers on embeddings',
};

const RUNNING_STATE = {
  id: 'sa_001',
  agent_name: 'researcher',
  status: 'running',
  task_preview: 'Find recent papers on embeddings',
};

const DONE_STATE = {
  id: 'sa_001',
  agent_name: 'researcher',
  status: 'done',
  task_preview: 'Find recent papers on embeddings',
  result_preview: 'Found 5 relevant papers.',
  duration_secs: 8,
};

const FAILED_STATE = {
  id: 'sa_002',
  agent_name: 'writer',
  status: 'failed',
  duration_secs: 2,
};

// ---------------------------------------------------------------------------
// Abstract guard
// ---------------------------------------------------------------------------

describe('SubagentRenderer (abstract)', () => {
  it('throws when instantiated directly', () => {
    expect(() => new SubagentRenderer()).toThrow('SubagentRenderer is abstract');
  });
});

// ---------------------------------------------------------------------------
// Default method stub — render must throw "not implemented"
// ---------------------------------------------------------------------------

describe('SubagentRenderer default method stub', () => {
  it('render() throws "not implemented"', () => {
    const stub = new StubSubagentRenderer();
    expect(() => stub.render(PENDING_STATE)).toThrow('not implemented');
  });
});

// ---------------------------------------------------------------------------
// ConcreteSubagentRenderer — exercising render across all lifecycle states
// ---------------------------------------------------------------------------

describe('ConcreteSubagentRenderer', () => {
  const r = new ConcreteSubagentRenderer();

  it('can be instantiated', () => {
    expect(() => new ConcreteSubagentRenderer()).not.toThrow();
  });

  it('is an instance of SubagentRenderer', () => {
    expect(r).toBeInstanceOf(SubagentRenderer);
  });

  it('render passes through pending state', () => {
    const out = r.render(PENDING_STATE);
    expect(out.rendered).toBe(true);
    expect(out.state.status).toBe('pending');
    expect(out.state.id).toBe('sa_001');
    expect(out.state.task_preview).toBe('Find recent papers on embeddings');
  });

  it('render passes through running state', () => {
    const out = r.render(RUNNING_STATE);
    expect(out.state.status).toBe('running');
  });

  it('render passes through done state with result_preview and duration_secs', () => {
    const out = r.render(DONE_STATE);
    expect(out.state.status).toBe('done');
    expect(out.state.result_preview).toBe('Found 5 relevant papers.');
    expect(out.state.duration_secs).toBe(8);
  });

  it('render passes through failed state', () => {
    const out = r.render(FAILED_STATE);
    expect(out.state.status).toBe('failed');
    expect(out.state.agent_name).toBe('writer');
    expect(out.state.duration_secs).toBe(2);
  });

  it('render is synchronous (does not return a Promise by default)', () => {
    const out = r.render(PENDING_STATE);
    expect(out).not.toBeInstanceOf(Promise);
  });

  it('render receives the exact same state object reference', () => {
    const state = { ...RUNNING_STATE };
    const out = r.render(state);
    expect(out.state).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// SubagentRenderer subclassing — override pattern used by concrete adapters
// ---------------------------------------------------------------------------

describe('SubagentRenderer subclassing', () => {
  class TextSubagentRenderer extends SubagentRenderer {
    render({ agent_name, status }) {
      return `[${status.toUpperCase()}] ${agent_name}`;
    }
  }

  const r = new TextSubagentRenderer();

  it('custom render returns a string', () => {
    expect(r.render(PENDING_STATE)).toBe('[PENDING] researcher');
  });

  it('custom render handles all statuses', () => {
    expect(r.render(RUNNING_STATE)).toBe('[RUNNING] researcher');
    expect(r.render(DONE_STATE)).toBe('[DONE] researcher');
    expect(r.render(FAILED_STATE)).toBe('[FAILED] writer');
  });
});
