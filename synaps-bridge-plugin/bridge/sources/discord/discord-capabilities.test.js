/**
 * @file discord-capabilities.test.js
 *
 * Tests for the DISCORD_CAPABILITIES frozen object.
 */

import { describe, it, expect } from 'vitest';
import { DISCORD_CAPABILITIES } from './discord-capabilities.js';
import { DEFAULT_CAPABILITIES } from '../../core/abstractions/adapter.js';

describe('DISCORD_CAPABILITIES', () => {
  it('is frozen (Object.isFrozen)', () => {
    expect(Object.isFrozen(DISCORD_CAPABILITIES)).toBe(true);
  });

  it('inherits every key from DEFAULT_CAPABILITIES via spread', () => {
    for (const key of Object.keys(DEFAULT_CAPABILITIES)) {
      expect(Object.prototype.hasOwnProperty.call(DISCORD_CAPABILITIES, key)).toBe(true);
    }
  });

  it('streaming is false', () => {
    expect(DISCORD_CAPABILITIES.streaming).toBe(false);
  });

  it('richStreamChunks is false', () => {
    expect(DISCORD_CAPABILITIES.richStreamChunks).toBe(false);
  });

  it('buttons is true', () => {
    expect(DISCORD_CAPABILITIES.buttons).toBe(true);
  });

  it('files is true', () => {
    expect(DISCORD_CAPABILITIES.files).toBe(true);
  });

  it('reactions is true', () => {
    expect(DISCORD_CAPABILITIES.reactions).toBe(true);
  });

  it('threading is true', () => {
    expect(DISCORD_CAPABILITIES.threading).toBe(true);
  });

  it('auxBlocks is true', () => {
    expect(DISCORD_CAPABILITIES.auxBlocks).toBe(true);
  });

  it('aiAppMode is false', () => {
    expect(DISCORD_CAPABILITIES.aiAppMode).toBe(false);
  });

  it('contains exactly the same keys as DEFAULT_CAPABILITIES (no extra flags)', () => {
    const defaultKeys = Object.keys(DEFAULT_CAPABILITIES).sort();
    const discordKeys = Object.keys(DISCORD_CAPABILITIES).sort();
    expect(discordKeys).toEqual(defaultKeys);
  });

  it('all values are booleans', () => {
    for (const [, v] of Object.entries(DISCORD_CAPABILITIES)) {
      expect(typeof v).toBe('boolean');
    }
  });
});
