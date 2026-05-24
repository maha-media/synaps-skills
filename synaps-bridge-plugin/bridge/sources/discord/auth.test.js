/**
 * @file auth.test.js
 *
 * Tests for readDiscordAuth and redactTokens.
 */

import { describe, it, expect } from 'vitest';
import { readDiscordAuth, redactTokens } from './auth.js';

// ─── readDiscordAuth ──────────────────────────────────────────────────────────

describe('readDiscordAuth — happy path', () => {
  it('returns { botToken } when DISCORD_BOT_TOKEN is present', () => {
    const env = { DISCORD_BOT_TOKEN: 'NjE2ODk5MDA4NjQ3NTc4NDk2.abc123.XYZabc_defghijklmnopqrstu' };
    const result = readDiscordAuth(env);
    expect(result).toEqual({ botToken: 'NjE2ODk5MDA4NjQ3NTc4NDk2.abc123.XYZabc_defghijklmnopqrstu' });
  });

  it('accepts an explicit env object and returns the correct token', () => {
    const env = { DISCORD_BOT_TOKEN: 'some-bot-token' };
    const result = readDiscordAuth(env);
    expect(result.botToken).toBe('some-bot-token');
  });
});

describe('readDiscordAuth — missing token', () => {
  it('throws when DISCORD_BOT_TOKEN is absent', () => {
    expect(() => readDiscordAuth({})).toThrow(/DISCORD_BOT_TOKEN missing or empty/);
  });

  it('throws when DISCORD_BOT_TOKEN is an empty string', () => {
    expect(() => readDiscordAuth({ DISCORD_BOT_TOKEN: '' })).toThrow(/DISCORD_BOT_TOKEN missing or empty/);
  });

  it('throws when DISCORD_BOT_TOKEN is undefined', () => {
    expect(() => readDiscordAuth({ DISCORD_BOT_TOKEN: undefined })).toThrow(/DISCORD_BOT_TOKEN missing or empty/);
  });
});

// ─── redactTokens ─────────────────────────────────────────────────────────────

describe('redactTokens', () => {
  it('redacts a Discord bot token embedded in a string', () => {
    const token = 'AAAABBBBCCCCDDDDEEEE.FfGgHh.111222333444555666777888999aa';
    const result = redactTokens(`token is ${token} here`);
    expect(result).toContain('***REDACTED***');
    expect(result).not.toContain(token);
  });

  it('passes through a string with no token unchanged', () => {
    expect(redactTokens('hello world')).toBe('hello world');
  });

  it('handles an empty string without throwing', () => {
    expect(redactTokens('')).toBe('');
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
});
