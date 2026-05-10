/**
 * bridge/core/mcp/mcp-tool-descriptors.test.js
 */
import { describe, it, expect } from 'vitest';
import {
  SYNAPS_CHAT_TOOL_DESCRIPTOR,
  ALL_TOOL_DESCRIPTORS,
  validateArgs,
} from './mcp-tool-descriptors.js';

// ─── SYNAPS_CHAT_TOOL_DESCRIPTOR ──────────────────────────────────────────────

describe('SYNAPS_CHAT_TOOL_DESCRIPTOR', () => {
  it('is frozen at the top level', () => {
    expect(Object.isFrozen(SYNAPS_CHAT_TOOL_DESCRIPTOR)).toBe(true);
  });

  it('inputSchema is frozen', () => {
    expect(Object.isFrozen(SYNAPS_CHAT_TOOL_DESCRIPTOR.inputSchema)).toBe(true);
  });

  it('inputSchema.properties is frozen', () => {
    expect(Object.isFrozen(SYNAPS_CHAT_TOOL_DESCRIPTOR.inputSchema.properties)).toBe(true);
  });

  it('inputSchema.properties.prompt is frozen', () => {
    expect(Object.isFrozen(SYNAPS_CHAT_TOOL_DESCRIPTOR.inputSchema.properties.prompt)).toBe(true);
  });

  it('inputSchema.properties.context is frozen', () => {
    expect(Object.isFrozen(SYNAPS_CHAT_TOOL_DESCRIPTOR.inputSchema.properties.context)).toBe(true);
  });

  it('name is "synaps_chat"', () => {
    expect(SYNAPS_CHAT_TOOL_DESCRIPTOR.name).toBe('synaps_chat');
  });

  it('has prompt and context properties in inputSchema', () => {
    const props = SYNAPS_CHAT_TOOL_DESCRIPTOR.inputSchema.properties;
    expect(props).toHaveProperty('prompt');
    expect(props).toHaveProperty('context');
  });

  it('only prompt is required', () => {
    const { required } = SYNAPS_CHAT_TOOL_DESCRIPTOR.inputSchema;
    expect(required).toContain('prompt');
    expect(required).not.toContain('context');
  });

  it('additionalProperties is false', () => {
    expect(SYNAPS_CHAT_TOOL_DESCRIPTOR.inputSchema.additionalProperties).toBe(false);
  });
});

// ─── ALL_TOOL_DESCRIPTORS ─────────────────────────────────────────────────────

describe('ALL_TOOL_DESCRIPTORS', () => {
  it('has length 1', () => {
    expect(ALL_TOOL_DESCRIPTORS).toHaveLength(1);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ALL_TOOL_DESCRIPTORS)).toBe(true);
  });

  it('first element is SYNAPS_CHAT_TOOL_DESCRIPTOR', () => {
    expect(ALL_TOOL_DESCRIPTORS[0]).toBe(SYNAPS_CHAT_TOOL_DESCRIPTOR);
  });
});

// ─── validateArgs ─────────────────────────────────────────────────────────────

describe('validateArgs', () => {
  const schema = SYNAPS_CHAT_TOOL_DESCRIPTOR.inputSchema;

  it('accepts {prompt: "hi"} → valid', () => {
    expect(validateArgs({ prompt: 'hi' }, schema)).toEqual({ valid: true });
  });

  it('accepts {prompt: "hi", context: "system"} → valid', () => {
    expect(validateArgs({ prompt: 'hi', context: 'system' }, schema)).toEqual({ valid: true });
  });

  it('rejects missing prompt → invalid', () => {
    const result = validateArgs({}, schema);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/prompt/);
  });

  it('rejects null args → invalid', () => {
    const result = validateArgs(null, schema);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/plain object/);
  });

  it('rejects string arg (non-object) → invalid', () => {
    const result = validateArgs('hi', schema);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/plain object/);
  });

  it('rejects array arg → invalid', () => {
    const result = validateArgs(['hi'], schema);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/plain object/);
  });

  it('rejects extra property when additionalProperties: false', () => {
    const result = validateArgs({ prompt: 'hi', unknown: 'oops' }, schema);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/unknown/);
  });

  it('rejects non-string prompt', () => {
    const result = validateArgs({ prompt: 42 }, schema);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/prompt/);
  });

  it('rejects non-string context', () => {
    const result = validateArgs({ prompt: 'hi', context: 123 }, schema);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/context/);
  });
});
