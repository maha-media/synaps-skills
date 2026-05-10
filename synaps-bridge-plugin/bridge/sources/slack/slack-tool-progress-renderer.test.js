/**
 * @file slack-tool-progress-renderer.test.js
 *
 * Tests for SlackToolProgressRenderer.
 */

import { describe, it, expect } from 'vitest';
import { SlackToolProgressRenderer } from './slack-tool-progress-renderer.js';

const renderer = new SlackToolProgressRenderer();

describe('SlackToolProgressRenderer — render()', () => {
  it('returns an array (Block Kit)', () => {
    const result = renderer.render({ toolName: 'bash', toolId: 'tid1', input: null });
    expect(Array.isArray(result)).toBe(true);
  });

  it('first block is a section containing the tool name', () => {
    const result = renderer.render({ toolName: 'bash', toolId: 'tid1', input: null });
    expect(result[0].type).toBe('section');
    expect(result[0].text.text).toContain('bash');
  });

  it('includes the toolId in the header block', () => {
    const result = renderer.render({ toolName: 'bash', toolId: 'tid-xyz', input: null });
    expect(result[0].text.text).toContain('tid-xyz');
  });

  it('in-progress (no result, no error) — does not include :white_check_mark: or :x:', () => {
    const result = renderer.render({ toolName: 'read_file', toolId: 't1', input: { path: '/etc/hosts' } });
    const allText = JSON.stringify(result);
    expect(allText).not.toContain(':white_check_mark:');
    expect(allText).not.toContain(':x:');
  });

  it('with result: renders preview with :white_check_mark:', () => {
    const result = renderer.render({
      toolName: 'read_file', toolId: 't1', input: null,
      result: 'file contents here',
    });
    const allText = JSON.stringify(result);
    expect(allText).toContain(':white_check_mark:');
    expect(allText).toContain('file contents here');
  });

  it('with error: renders :x: and error message', () => {
    const result = renderer.render({
      toolName: 'bash', toolId: 't1', input: null,
      error: new Error('permission denied'),
    });
    const allText = JSON.stringify(result);
    expect(allText).toContain(':x:');
    expect(allText).toContain('permission denied');
  });

  it('with error string (non-Error): still renders :x:', () => {
    const result = renderer.render({
      toolName: 'bash', toolId: 't1', input: null,
      error: 'timeout',
    });
    const allText = JSON.stringify(result);
    expect(allText).toContain(':x:');
    expect(allText).toContain('timeout');
  });

  it('input is truncated to 200 chars', () => {
    const longInput = 'a'.repeat(300);
    const result = renderer.render({ toolName: 'bash', toolId: 't1', input: longInput });
    const allText = JSON.stringify(result);
    // 200 chars + ellipsis "…" — the JSON shouldn't contain 300 consecutive 'a's
    expect(allText.includes('a'.repeat(201))).toBe(false);
    expect(allText.includes('a'.repeat(200))).toBe(true);
  });

  it('includes input in a context block as a code snippet', () => {
    const result = renderer.render({ toolName: 'bash', toolId: 't1', input: { cmd: 'ls' } });
    const contextBlock = result.find(b => b.type === 'context');
    expect(contextBlock).toBeDefined();
    const text = contextBlock.elements[0].text;
    expect(text).toContain('cmd');
  });

  it('omits input block when input is null', () => {
    const result = renderer.render({ toolName: 'bash', toolId: 't1', input: null });
    // Should have at most 1 block (the header section) since no input / result / error
    expect(result.every(b => b.type !== 'context' || !JSON.stringify(b).includes('```'))).toBe(true);
  });

  it('header block uses :wrench: emoji', () => {
    const result = renderer.render({ toolName: 'bash', toolId: 't1', input: null });
    expect(result[0].text.text).toContain(':wrench:');
  });
});
