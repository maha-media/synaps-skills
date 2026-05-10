/**
 * @file slack-subagent-renderer.test.js
 *
 * Tests for SlackSubagentRenderer.
 */

import { describe, it, expect } from 'vitest';
import { SlackSubagentRenderer } from './slack-subagent-renderer.js';

const renderer = new SlackSubagentRenderer();

function state(overrides = {}) {
  return {
    id: 'sa-1',
    agent_name: 'researcher',
    status: 'running',
    ...overrides,
  };
}

describe('SlackSubagentRenderer — render()', () => {
  it('returns an array (Block Kit)', () => {
    expect(Array.isArray(renderer.render(state()))).toBe(true);
  });

  it('pending status → :hourglass_flowing_sand: in first block', () => {
    const result = renderer.render(state({ status: 'pending' }));
    expect(result[0].text.text).toContain(':hourglass_flowing_sand:');
  });

  it('running status → :gear: in first block', () => {
    const result = renderer.render(state({ status: 'running' }));
    expect(result[0].text.text).toContain(':gear:');
  });

  it('done status → :white_check_mark: in first block', () => {
    const result = renderer.render(state({ status: 'done' }));
    expect(result[0].text.text).toContain(':white_check_mark:');
  });

  it('failed status → :x: in first block', () => {
    const result = renderer.render(state({ status: 'failed' }));
    expect(result[0].text.text).toContain(':x:');
  });

  it('agent_name is present in the first block text', () => {
    const result = renderer.render(state({ agent_name: 'coder-agent' }));
    expect(result[0].text.text).toContain('coder-agent');
  });

  it('status is present in the first block text', () => {
    const result = renderer.render(state({ status: 'running' }));
    expect(result[0].text.text).toContain('running');
  });

  it('first block type is section with mrkdwn', () => {
    const result = renderer.render(state());
    expect(result[0].type).toBe('section');
    expect(result[0].text.type).toBe('mrkdwn');
  });

  it('includes a divider block', () => {
    const result = renderer.render(state());
    expect(result.some(b => b.type === 'divider')).toBe(true);
  });

  it('task_preview is included when present', () => {
    const result = renderer.render(state({ task_preview: 'find CVEs in openssl' }));
    const allText = JSON.stringify(result);
    expect(allText).toContain('find CVEs in openssl');
  });

  it('task_preview is absent when not provided', () => {
    const result = renderer.render(state());
    // No extra context blocks about task
    const hasTask = result.some(b =>
      b.type === 'context' &&
      b.elements?.some(e => e.text?.includes('task'))
    );
    expect(hasTask).toBe(false);
  });

  it('result_preview is included when present', () => {
    const result = renderer.render(state({ status: 'done', result_preview: 'found 3 CVEs' }));
    const allText = JSON.stringify(result);
    expect(allText).toContain('found 3 CVEs');
  });

  it('duration_secs is included when present', () => {
    const result = renderer.render(state({ status: 'done', duration_secs: 12.5 }));
    const allText = JSON.stringify(result);
    expect(allText).toContain('12.5');
  });

  it('duration_secs is absent when not provided', () => {
    const result = renderer.render(state());
    const allText = JSON.stringify(result);
    // No mention of a duration
    expect(allText).not.toMatch(/done in \d/);
  });

  it('handles unknown status gracefully (uses fallback icon)', () => {
    // Should not throw; just uses a fallback icon.
    expect(() => renderer.render(state({ status: 'unknown_state' }))).not.toThrow();
  });

  it('output is Block Kit array — each element has a type string', () => {
    const result = renderer.render(state({ task_preview: 'x', result_preview: 'y', duration_secs: 1 }));
    for (const block of result) {
      expect(typeof block.type).toBe('string');
    }
  });
});
