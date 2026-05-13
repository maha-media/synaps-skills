/**
 * @file auth.js
 * @module bridge/sources/discord/auth
 *
 * Single chokepoint for reading Discord secrets from the environment.
 * All other modules receive tokens by injection — they NEVER touch
 * process.env directly.
 */

// ─── readDiscordAuth ──────────────────────────────────────────────────────────

/**
 * Read Discord auth credentials from the environment.  This is the ONLY
 * place in the codebase that reads DISCORD_* variables from process.env.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{ botToken: string }}
 * @throws {Error} If the token is missing or empty.
 */
export function readDiscordAuth(env = process.env) {
  const botToken = env.DISCORD_BOT_TOKEN;

  if (!botToken) {
    throw new Error('DISCORD_BOT_TOKEN missing or empty');
  }

  return { botToken };
}

// ─── redactTokens ─────────────────────────────────────────────────────────────

/**
 * Redact any Discord bot tokens embedded in a string.
 *
 * Discord bot tokens are base64-encoded segments joined by dots, e.g.:
 *   NjE2ODk5MDA4NjQ3NTc4NDk2.abc123.XYZ-abc_def
 *
 * Defense-in-depth: called on every string that might reach a log line so
 * that a token accidentally included in a log message is stripped even if the
 * caller forgot to sanitise it upstream.
 *
 * @param {*} s - Value to redact.  Non-strings are returned unchanged.
 * @returns {*} Redacted string, or the original value if it was not a string.
 */
export function redactTokens(s) {
  if (typeof s !== 'string') return s;
  // Discord bot tokens: three base64url segments separated by dots.
  return s.replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, '***REDACTED***');
}
