/**
 * @file discord-formatter.test.js
 *
 * Tests for DiscordFormatter.
 */

import { describe, it, expect } from 'vitest';
import { DiscordFormatter } from './discord-formatter.js';

const fmt = new DiscordFormatter();

describe('DiscordFormatter — formatMarkdown', () => {
  it('returns plain text unchanged', () => {
    expect(fmt.formatMarkdown('hello world')).toBe('hello world');
  });

  it('escapes @everyone with a backslash', () => {
    expect(fmt.formatMarkdown('hey @everyone listen up')).toBe('hey \\@everyone listen up');
  });

  it('escapes @here with a backslash', () => {
    expect(fmt.formatMarkdown('ping @here please')).toBe('ping \\@here please');
  });

  it('escapes both @everyone and @here in the same string', () => {
    const result = fmt.formatMarkdown('@everyone and @here should be safe');
    expect(result).toBe('\\@everyone and \\@here should be safe');
  });

  it('preserves standard markdown constructs (bold, italic, code)', () => {
    const md = '**bold** *italic* `code` ~~strike~~';
    expect(fmt.formatMarkdown(md)).toBe(md);
  });

  it('handles empty string', () => {
    expect(fmt.formatMarkdown('')).toBe('');
  });

  it('coerces non-string to string', () => {
    expect(fmt.formatMarkdown(42)).toBe('42');
  });

  it('coerces null to empty string', () => {
    expect(fmt.formatMarkdown(null)).toBe('');
  });
});

describe('DiscordFormatter — formatError', () => {
  it('returns ⚠️ prefix for Error instance', () => {
    const result = fmt.formatError(new Error('something broke'));
    expect(result).toBe('⚠️ something broke');
  });

  it('returns ⚠️ prefix for plain string', () => {
    expect(fmt.formatError('oops')).toBe('⚠️ oops');
  });

  it('handles null gracefully', () => {
    const result = fmt.formatError(null);
    expect(result).toMatch(/^⚠️/);
  });

  it('handles undefined gracefully', () => {
    const result = fmt.formatError(undefined);
    expect(result).toMatch(/^⚠️/);
  });
});

describe('DiscordFormatter — formatSubagent', () => {
  it('returns an array', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'worker', status: 'running' });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('embed has title containing agent_name', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'researcher', status: 'running' });
    expect(result[0].title).toContain('researcher');
  });

  it('embed description is the status string', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'done' });
    expect(result[0].description).toBe('done');
  });

  it('embed has a color integer', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'done' });
    expect(typeof result[0].color).toBe('number');
  });

  it('uses ⏳ icon for pending status', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'pending' });
    expect(result[0].title).toContain('⏳');
  });

  it('uses ⚙️ icon for running status', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'running' });
    expect(result[0].title).toContain('⚙️');
  });

  it('uses ✅ icon for done status', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'done' });
    expect(result[0].title).toContain('✅');
  });

  it('uses ❌ icon for failed status', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'failed' });
    expect(result[0].title).toContain('❌');
  });

  it('includes task_preview as a field when present', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'running', task_preview: 'find bugs' });
    const allText = JSON.stringify(result);
    expect(allText).toContain('find bugs');
  });

  it('omits task field when task_preview is absent', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'done' });
    const hasTask = result[0].fields.some(f => f.name === 'Task');
    expect(hasTask).toBe(false);
  });

  it('includes result_preview as a field when present', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'done', result_preview: 'found 3 items' });
    const allText = JSON.stringify(result);
    expect(allText).toContain('found 3 items');
  });

  it('includes duration_secs as a field when present', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'done', duration_secs: 4.2 });
    const allText = JSON.stringify(result);
    expect(allText).toContain('4.2');
  });

  it('omits duration field when duration_secs is absent', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'done' });
    const hasDur = result[0].fields.some(f => f.name === 'Duration');
    expect(hasDur).toBe(false);
  });
});

describe('DiscordFormatter — constructor', () => {
  it('can be constructed without options', () => {
    expect(() => new DiscordFormatter()).not.toThrow();
  });

  it('accepts a custom logger', () => {
    const logger = { warn: () => {}, info: () => {} };
    const f = new DiscordFormatter({ logger });
    expect(f.logger).toBe(logger);
  });
});
