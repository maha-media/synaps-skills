/**
 * @file slack-capabilities.test.js
 *
 * Tests for the SLACK_CAPABILITIES frozen object.
 */

import { describe, it, expect } from 'vitest';
import { SLACK_CAPABILITIES } from './slack-capabilities.js';
import { DEFAULT_CAPABILITIES } from '../../core/abstractions/adapter.js';

describe('SLACK_CAPABILITIES', () => {
  it('is frozen (Object.isFrozen)', () => {
    expect(Object.isFrozen(SLACK_CAPABILITIES)).toBe(true);
  });

  it('inherits every key from DEFAULT_CAPABILITIES via spread', () => {
    for (const key of Object.keys(DEFAULT_CAPABILITIES)) {
      expect(Object.prototype.hasOwnProperty.call(SLACK_CAPABILITIES, key)).toBe(true);
    }
  });

  it('streaming is true', () => {
    expect(SLACK_CAPABILITIES.streaming).toBe(true);
  });

  it('richStreamChunks is true', () => {
    expect(SLACK_CAPABILITIES.richStreamChunks).toBe(true);
  });

  it('buttons is true', () => {
    expect(SLACK_CAPABILITIES.buttons).toBe(true);
  });

  it('files is true', () => {
    expect(SLACK_CAPABILITIES.files).toBe(true);
  });

  it('reactions is true', () => {
    expect(SLACK_CAPABILITIES.reactions).toBe(true);
  });

  it('threading is true', () => {
    expect(SLACK_CAPABILITIES.threading).toBe(true);
  });

  it('auxBlocks is true', () => {
    expect(SLACK_CAPABILITIES.auxBlocks).toBe(true);
  });

  it('aiAppMode is true', () => {
    expect(SLACK_CAPABILITIES.aiAppMode).toBe(true);
  });

  it('contains exactly the same 8 boolean keys as DEFAULT_CAPABILITIES (no extra flags)', () => {
    const defaultKeys = Object.keys(DEFAULT_CAPABILITIES).sort();
    const slackKeys   = Object.keys(SLACK_CAPABILITIES).sort();
    expect(slackKeys).toEqual(defaultKeys);
  });

  it('all values are booleans', () => {
    for (const [, v] of Object.entries(SLACK_CAPABILITIES)) {
      expect(typeof v).toBe('boolean');
    }
  });
});
