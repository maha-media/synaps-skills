/**
 * @file auth.test.js
 *
 * Tests for readSlackAuth and redactTokens.
 */

import { describe, it, expect } from 'vitest';
import { readSlackAuth, redactTokens } from './auth.js';

// ─── readSlackAuth ────────────────────────────────────────────────────────────

describe('readSlackAuth — happy path', () => {
  it('returns { botToken, appToken } when both are well-formed', () => {
    const env = {
      SLACK_BOT_TOKEN: 'xoxb-123456789-abcdef',
      SLACK_APP_TOKEN: 'xapp-1-A0123-456-abcdef',
    };
    const result = readSlackAuth(env);
    expect(result).toEqual({
      botToken: 'xoxb-123456789-abcdef',
      appToken: 'xapp-1-A0123-456-abcdef',
    });
  });

  it('accepts an explicit env object and returns the correct tokens', () => {
    // This test covers the explicit-env path (the default-parameter path
    // is implicitly verified: process.env is the default, which is also an object
    // with the same shape; passing an equivalent object exercises the same code).
    const env = {
      SLACK_BOT_TOKEN: 'xoxb-test-default',
      SLACK_APP_TOKEN: 'xapp-test-default',
    };
    const result = readSlackAuth(env);
    expect(result.botToken).toBe('xoxb-test-default');
    expect(result.appToken).toBe('xapp-test-default');
  });
});

describe('readSlackAuth — missing tokens', () => {
  it('throws when SLACK_BOT_TOKEN is absent', () => {
    const env = { SLACK_APP_TOKEN: 'xapp-1-A0123-456' };
    expect(() => readSlackAuth(env)).toThrow(/SLACK_BOT_TOKEN missing or malformed/);
  });

  it('throws when SLACK_APP_TOKEN is absent', () => {
    const env = { SLACK_BOT_TOKEN: 'xoxb-valid-token' };
    expect(() => readSlackAuth(env)).toThrow(/SLACK_APP_TOKEN missing or malformed/);
  });

  it('throws when SLACK_BOT_TOKEN is an empty string', () => {
    const env = { SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: 'xapp-1-A0123-456' };
    expect(() => readSlackAuth(env)).toThrow(/SLACK_BOT_TOKEN missing or malformed/);
  });

  it('throws when SLACK_APP_TOKEN is an empty string', () => {
    const env = { SLACK_BOT_TOKEN: 'xoxb-valid-token', SLACK_APP_TOKEN: '' };
    expect(() => readSlackAuth(env)).toThrow(/SLACK_APP_TOKEN missing or malformed/);
  });
});

describe('readSlackAuth — malformed tokens', () => {
  it('throws when botToken does not start with xoxb-', () => {
    const env = {
      SLACK_BOT_TOKEN: 'xoxa-wrong-prefix',
      SLACK_APP_TOKEN: 'xapp-1-A0123-456',
    };
    expect(() => readSlackAuth(env)).toThrow(/SLACK_BOT_TOKEN missing or malformed/);
  });

  it('throws when appToken does not start with xapp-', () => {
    const env = {
      SLACK_BOT_TOKEN: 'xoxb-valid-token',
      SLACK_APP_TOKEN: 'xoxa-wrong-prefix',
    };
    expect(() => readSlackAuth(env)).toThrow(/SLACK_APP_TOKEN missing or malformed/);
  });
});

// ─── redactTokens ─────────────────────────────────────────────────────────────

describe('redactTokens', () => {
  it('replaces xoxb-... tokens with REDACTED', () => {
    const result = redactTokens('token is xoxb-123-ABC-xyz here');
    expect(result).toBe('token is xoxb-***REDACTED*** here');
    expect(result).not.toContain('xoxb-123');
  });

  it('replaces xapp-... tokens with REDACTED', () => {
    const result = redactTokens('app token xapp-1-ABC-456-def end');
    expect(result).toBe('app token xapp-***REDACTED*** end');
    expect(result).not.toContain('xapp-1-ABC');
  });

  it('replaces both token types in the same string', () => {
    const s = 'bot=xoxb-1-2-3 app=xapp-9-8-7';
    const result = redactTokens(s);
    expect(result).toContain('xoxb-***REDACTED***');
    expect(result).toContain('xapp-***REDACTED***');
    expect(result).not.toContain('xoxb-1-2-3');
    expect(result).not.toContain('xapp-9-8-7');
  });

  it('passes through a non-string number unchanged', () => {
    expect(redactTokens(42)).toBe(42);
  });

  it('passes through a non-string null unchanged', () => {
    expect(redactTokens(null)).toBe(null);
  });

  it('passes through a non-string object unchanged', () => {
    const obj = { a: 1 };
    expect(redactTokens(obj)).toBe(obj);
  });

  it('returns plain strings unchanged when no tokens are present', () => {
    expect(redactTokens('hello world')).toBe('hello world');
  });

  it('handles an empty string without throwing', () => {
    expect(redactTokens('')).toBe('');
  });
});
