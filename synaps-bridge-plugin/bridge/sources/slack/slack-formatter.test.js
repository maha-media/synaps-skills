/**
 * @file slack-formatter.test.js
 *
 * Tests for SlackFormatter.
 */

import { describe, it, expect } from 'vitest';
import { SlackFormatter } from './slack-formatter.js';

const fmt = new SlackFormatter();

describe('SlackFormatter — formatMarkdown', () => {
  it('converts **bold** → *bold*', () => {
    expect(fmt.formatMarkdown('**bold**')).toBe('*bold*');
  });

  it('converts *italic* → _italic_', () => {
    expect(fmt.formatMarkdown('*italic*')).toBe('_italic_');
  });

  it('converts mixed bold and italic on the same line', () => {
    const result = fmt.formatMarkdown('**bold** and *italic*');
    expect(result).toBe('*bold* and _italic_');
  });

  it('converts ~~strike~~ → ~strike~', () => {
    expect(fmt.formatMarkdown('~~strike~~')).toBe('~strike~');
  });

  it('converts # Heading → *Heading*', () => {
    expect(fmt.formatMarkdown('# Title')).toBe('*Title*');
  });

  it('converts ## Heading → *Heading*', () => {
    expect(fmt.formatMarkdown('## Subtitle')).toBe('*Subtitle*');
  });

  it('converts ### Heading → *Heading*', () => {
    expect(fmt.formatMarkdown('### Deep')).toBe('*Deep*');
  });

  it('preserves code fences (```...```)', () => {
    const input = '```\nconst x = 1;\n```';
    expect(fmt.formatMarkdown(input)).toBe(input);
  });

  it('preserves inline code (`x`)', () => {
    const input = 'use `console.log` for output';
    expect(fmt.formatMarkdown(input)).toBe(input);
  });

  it('converts [text](url) → <url|text>', () => {
    expect(fmt.formatMarkdown('[OpenAI](https://openai.com)')).toBe('<https://openai.com|OpenAI>');
  });

  it('handles multiple links in the same string', () => {
    const result = fmt.formatMarkdown('[A](http://a.com) and [B](http://b.com)');
    expect(result).toBe('<http://a.com|A> and <http://b.com|B>');
  });

  it('does not transform content inside code fences', () => {
    const input = '```\n**not bold** and *not italic*\n```';
    expect(fmt.formatMarkdown(input)).toBe(input);
  });

  it('does not transform content inside inline code', () => {
    const input = '`**not bold**`';
    expect(fmt.formatMarkdown(input)).toBe(input);
  });

  it('handles empty string', () => {
    expect(fmt.formatMarkdown('')).toBe('');
  });

  it('handles a multiline markdown document', () => {
    const input = '# Hello\n\n**bold text** with *italic* and `code`';
    const result = fmt.formatMarkdown(input);
    expect(result).toContain('*Hello*');
    expect(result).toContain('*bold text*');
    expect(result).toContain('_italic_');
    expect(result).toContain('`code`');
  });
});

describe('SlackFormatter — formatError', () => {
  it('returns string starting with :warning: for Error instance', () => {
    const result = fmt.formatError(new Error('nope'));
    expect(result).toBe(':warning: nope');
  });

  it('returns string starting with :warning: for plain string', () => {
    expect(fmt.formatError('something broke')).toBe(':warning: something broke');
  });

  it('handles null gracefully', () => {
    const result = fmt.formatError(null);
    expect(result).toMatch(/^:warning:/);
  });
});

describe('SlackFormatter — formatSubagent', () => {
  it('returns an array', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'running', task_preview: 'y' });
    expect(Array.isArray(result)).toBe(true);
  });

  it('first block is a section with mrkdwn text containing status and agent name', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'researcher', status: 'running', task_preview: 'find stuff' });
    expect(result[0].type).toBe('section');
    expect(result[0].text.type).toBe('mrkdwn');
    expect(result[0].text.text).toContain('researcher');
    expect(result[0].text.text).toContain('running');
  });

  it('includes task_preview in a context block when present', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'running', task_preview: 'my task' });
    const contextBlock = result.find(b => b.type === 'context');
    expect(contextBlock).toBeDefined();
    const text = contextBlock.elements[0].text;
    expect(text).toContain('my task');
  });

  it('omits task preview block when task_preview is absent', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'done' });
    // Should still be a valid array (just no context block for task)
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe('section');
  });

  it('uses :hourglass_flowing_sand: for pending status', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'pending' });
    expect(result[0].text.text).toContain(':hourglass_flowing_sand:');
  });

  it('uses :gear: for running status', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'running' });
    expect(result[0].text.text).toContain(':gear:');
  });

  it('uses :white_check_mark: for done status', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'done' });
    expect(result[0].text.text).toContain(':white_check_mark:');
  });

  it('uses :x: for failed status', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'failed' });
    expect(result[0].text.text).toContain(':x:');
  });

  it('includes result_preview when present', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'done', result_preview: 'found 3 items' });
    const allText = JSON.stringify(result);
    expect(allText).toContain('found 3 items');
  });

  it('includes duration_secs when present', () => {
    const result = fmt.formatSubagent({ id: '1', agent_name: 'x', status: 'done', duration_secs: 8.2 });
    const allText = JSON.stringify(result);
    expect(allText).toContain('8.2');
  });
});

describe('SlackFormatter — constructor', () => {
  it('can be constructed without options', () => {
    expect(() => new SlackFormatter()).not.toThrow();
  });

  it('accepts a custom logger', () => {
    const logger = { warn: () => {}, info: () => {} };
    const f = new SlackFormatter({ logger });
    expect(f.logger).toBe(logger);
  });
});
