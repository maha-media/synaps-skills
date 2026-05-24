/**
 * @file discord-tool-progress-renderer.test.js
 *
 * Tests for DiscordToolProgressRenderer.
 */

import { describe, it, expect } from 'vitest';
import { DiscordToolProgressRenderer } from './discord-tool-progress-renderer.js';

const renderer = new DiscordToolProgressRenderer();

describe('DiscordToolProgressRenderer — render()', () => {
  it('returns an array containing a single embed object', () => {
    const result = renderer.render({ toolName: 'bash', toolId: 't1', input: { cmd: 'ls' } });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it('embed has title, description, fields, color', () => {
    const [embed] = renderer.render({ toolName: 'bash', toolId: 't1', input: { cmd: 'ls' } });
    expect(embed.title).toBeDefined();
    expect(embed.description).toBeDefined();
    expect(Array.isArray(embed.fields)).toBe(true);
    expect(typeof embed.color).toBe('number');
  });

  it('title contains 🔧 and the tool name', () => {
    const [embed] = renderer.render({ toolName: 'bash', toolId: 't1', input: null });
    expect(embed.title).toContain('🔧');
    expect(embed.title).toContain('bash');
  });

  it('description contains the toolId wrapped in backticks', () => {
    const [embed] = renderer.render({ toolName: 'bash', toolId: 'tid-xyz', input: null });
    expect(embed.description).toBe('`tid-xyz`');
  });

  // ── in-progress ────────────────────────────────────────────────────────
  it('in-progress (no result, no error) → grey color 0x808080', () => {
    const [embed] = renderer.render({
      toolName: 'read_file', toolId: 't1', input: { path: '/etc/hosts' },
    });
    expect(embed.color).toBe(0x808080);
    expect(embed.fields.find(f => f.name === 'Result')).toBeUndefined();
    expect(embed.fields.find(f => f.name === 'Error')).toBeUndefined();
  });

  it('in-progress includes Input field rendered as a JSON code block', () => {
    const [embed] = renderer.render({
      toolName: 'read_file', toolId: 't1', input: { path: '/etc/hosts' },
    });
    const inputField = embed.fields.find(f => f.name === 'Input');
    expect(inputField).toBeDefined();
    expect(inputField.value).toContain('```json');
    expect(inputField.value).toContain('path');
    expect(inputField.value).toContain('/etc/hosts');
    expect(inputField.inline).toBe(false);
  });

  // ── success ────────────────────────────────────────────────────────────
  it('with result → green color 0x2ecc71 and Result field', () => {
    const [embed] = renderer.render({
      toolName: 'read_file', toolId: 't1', input: null,
      result: 'file contents here',
    });
    expect(embed.color).toBe(0x2ecc71);
    const resultField = embed.fields.find(f => f.name === 'Result');
    expect(resultField).toBeDefined();
    expect(resultField.value).toBe('file contents here');
  });

  it('with falsy result like 0 still renders Result field and green color', () => {
    const [embed] = renderer.render({
      toolName: 'count', toolId: 't1', input: null, result: 0,
    });
    expect(embed.color).toBe(0x2ecc71);
    expect(embed.fields.find(f => f.name === 'Result')).toBeDefined();
  });

  // ── failure ────────────────────────────────────────────────────────────
  it('with Error instance → red color 0xe74c3c and Error field with message', () => {
    const [embed] = renderer.render({
      toolName: 'bash', toolId: 't1', input: null,
      error: new Error('permission denied'),
    });
    expect(embed.color).toBe(0xe74c3c);
    const errorField = embed.fields.find(f => f.name === 'Error');
    expect(errorField).toBeDefined();
    expect(errorField.value).toBe('permission denied');
  });

  it('with non-Error error string → red color and Error field with stringified value', () => {
    const [embed] = renderer.render({
      toolName: 'bash', toolId: 't1', input: null, error: 'timeout',
    });
    expect(embed.color).toBe(0xe74c3c);
    const errorField = embed.fields.find(f => f.name === 'Error');
    expect(errorField).toBeDefined();
    expect(errorField.value).toBe('timeout');
  });

  it('error takes precedence over result for coloring', () => {
    const [embed] = renderer.render({
      toolName: 'bash', toolId: 't1', input: null,
      result: 'partial', error: new Error('bad'),
    });
    expect(embed.color).toBe(0xe74c3c);
  });

  // ── truncation ─────────────────────────────────────────────────────────
  it('truncates Input value to 200 chars + ellipsis (inside the code fence)', () => {
    const longInput = 'a'.repeat(300);
    const [embed] = renderer.render({ toolName: 'bash', toolId: 't1', input: longInput });
    const inputField = embed.fields.find(f => f.name === 'Input');
    // 200 'a's followed by '…', wrapped in code fence
    expect(inputField.value).toContain('a'.repeat(200));
    expect(inputField.value).not.toContain('a'.repeat(201));
    expect(inputField.value).toContain('…');
  });

  it('truncates Result value to 200 chars + ellipsis', () => {
    const longResult = 'b'.repeat(300);
    const [embed] = renderer.render({
      toolName: 'bash', toolId: 't1', input: null, result: longResult,
    });
    const resultField = embed.fields.find(f => f.name === 'Result');
    expect(resultField.value.length).toBe(201);
    expect(resultField.value.endsWith('…')).toBe(true);
  });

  it('truncates Error value to 200 chars + ellipsis', () => {
    const longErr = 'c'.repeat(300);
    const [embed] = renderer.render({
      toolName: 'bash', toolId: 't1', input: null, error: new Error(longErr),
    });
    const errField = embed.fields.find(f => f.name === 'Error');
    expect(errField.value.length).toBe(201);
    expect(errField.value.endsWith('…')).toBe(true);
  });

  it('object input is JSON.stringified inside the code fence', () => {
    const [embed] = renderer.render({
      toolName: 'bash', toolId: 't1', input: { cmd: 'ls', flags: ['-la'] },
    });
    const inputField = embed.fields.find(f => f.name === 'Input');
    expect(inputField.value).toContain('"cmd"');
    expect(inputField.value).toContain('"ls"');
  });
});
