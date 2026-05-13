/**
 * @file discord-subagent-renderer.test.js
 *
 * Tests for DiscordSubagentRenderer.
 */

import { describe, it, expect } from 'vitest';
import { DiscordSubagentRenderer } from './discord-subagent-renderer.js';

const renderer = new DiscordSubagentRenderer();

function state(overrides = {}) {
  return {
    id: 'sa-1',
    agent_name: 'researcher',
    status: 'running',
    ...overrides,
  };
}

describe('DiscordSubagentRenderer — render()', () => {
  it('returns an array containing a single embed object', () => {
    const result = renderer.render(state());
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(typeof result[0]).toBe('object');
  });

  it('embed has title, description, fields, color', () => {
    const [embed] = renderer.render(state());
    expect(embed.title).toBeDefined();
    expect(embed.description).toBeDefined();
    expect(Array.isArray(embed.fields)).toBe(true);
    expect(typeof embed.color).toBe('number');
  });

  // ── status: pending ────────────────────────────────────────────────────
  it('pending → ⏳ icon and 0x808080 color', () => {
    const [embed] = renderer.render(state({ status: 'pending' }));
    expect(embed.title).toContain('⏳');
    expect(embed.color).toBe(0x808080);
    expect(embed.description).toBe('pending');
  });

  // ── status: running ────────────────────────────────────────────────────
  it('running → ⚙️ icon and 0x3498db color', () => {
    const [embed] = renderer.render(state({ status: 'running' }));
    expect(embed.title).toContain('⚙️');
    expect(embed.color).toBe(0x3498db);
    expect(embed.description).toBe('running');
  });

  // ── status: done ───────────────────────────────────────────────────────
  it('done → ✅ icon and 0x2ecc71 color', () => {
    const [embed] = renderer.render(state({ status: 'done' }));
    expect(embed.title).toContain('✅');
    expect(embed.color).toBe(0x2ecc71);
    expect(embed.description).toBe('done');
  });

  // ── status: failed ─────────────────────────────────────────────────────
  it('failed → ❌ icon and 0xe74c3c color', () => {
    const [embed] = renderer.render(state({ status: 'failed' }));
    expect(embed.title).toContain('❌');
    expect(embed.color).toBe(0xe74c3c);
    expect(embed.description).toBe('failed');
  });

  it('title contains agent_name', () => {
    const [embed] = renderer.render(state({ agent_name: 'coder-agent' }));
    expect(embed.title).toContain('coder-agent');
  });

  // ── Task field ─────────────────────────────────────────────────────────
  it('Task field is present when task_preview is provided', () => {
    const [embed] = renderer.render(state({ task_preview: 'find CVEs in openssl' }));
    const task = embed.fields.find(f => f.name === 'Task');
    expect(task).toBeDefined();
    expect(task.value).toBe('find CVEs in openssl');
    expect(task.inline).toBe(false);
  });

  it('Task field is omitted when task_preview is absent', () => {
    const [embed] = renderer.render(state());
    expect(embed.fields.find(f => f.name === 'Task')).toBeUndefined();
  });

  // ── Result field ───────────────────────────────────────────────────────
  it('Result field is present for done status when result_preview provided', () => {
    const [embed] = renderer.render(state({ status: 'done', result_preview: 'found 3 CVEs' }));
    const r = embed.fields.find(f => f.name === 'Result');
    expect(r).toBeDefined();
    expect(r.value).toBe('found 3 CVEs');
  });

  it('Result field is present for failed status when result_preview provided', () => {
    const [embed] = renderer.render(state({ status: 'failed', result_preview: 'boom' }));
    expect(embed.fields.find(f => f.name === 'Result')).toBeDefined();
  });

  it('Result field is omitted for running status even if result_preview present', () => {
    const [embed] = renderer.render(state({ status: 'running', result_preview: 'partial' }));
    expect(embed.fields.find(f => f.name === 'Result')).toBeUndefined();
  });

  it('Result field is omitted for pending status', () => {
    const [embed] = renderer.render(state({ status: 'pending', result_preview: 'partial' }));
    expect(embed.fields.find(f => f.name === 'Result')).toBeUndefined();
  });

  // ── Duration field ─────────────────────────────────────────────────────
  it('Duration field is present (inline) for done status with duration_secs', () => {
    const [embed] = renderer.render(state({ status: 'done', duration_secs: 12.5 }));
    const d = embed.fields.find(f => f.name === 'Duration');
    expect(d).toBeDefined();
    expect(d.value).toBe('12.5s');
    expect(d.inline).toBe(true);
  });

  it('Duration field is omitted when duration_secs is absent', () => {
    const [embed] = renderer.render(state({ status: 'done' }));
    expect(embed.fields.find(f => f.name === 'Duration')).toBeUndefined();
  });

  // ── Truncation ─────────────────────────────────────────────────────────
  it('truncates task_preview to 200 chars + ellipsis', () => {
    const long = 'a'.repeat(300);
    const [embed] = renderer.render(state({ task_preview: long }));
    const task = embed.fields.find(f => f.name === 'Task');
    expect(task.value.length).toBe(201); // 200 + '…'
    expect(task.value.endsWith('…')).toBe(true);
  });

  it('truncates result_preview to 200 chars + ellipsis', () => {
    const long = 'b'.repeat(300);
    const [embed] = renderer.render(state({ status: 'done', result_preview: long }));
    const r = embed.fields.find(f => f.name === 'Result');
    expect(r.value.length).toBe(201);
    expect(r.value.endsWith('…')).toBe(true);
  });

  it('handles unknown status gracefully (does not throw)', () => {
    expect(() => renderer.render(state({ status: 'mystery' }))).not.toThrow();
  });
});
