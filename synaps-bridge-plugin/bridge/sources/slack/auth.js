/**
 * @file auth.js
 * @module bridge/sources/slack/auth
 *
 * Single chokepoint for reading Slack secrets from the environment.
 * All other modules receive tokens by injection — they NEVER touch
 * process.env directly.
 */

// ─── readSlackAuth ─────────────────────────────────────────────────────────────

/**
 * Read Slack auth credentials from the environment.  This is the ONLY
 * place in the codebase that reads SLACK_* variables from process.env.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{ botToken: string, appToken: string }}
 * @throws {Error} If either token is missing or does not start with the
 *   expected prefix (`xoxb-` for botToken, `xapp-` for appToken).
 */
export function readSlackAuth(env = process.env) {
  const botToken = env.SLACK_BOT_TOKEN;
  const appToken = env.SLACK_APP_TOKEN;

  if (!botToken || !botToken.startsWith('xoxb-')) {
    throw new Error('SLACK_BOT_TOKEN missing or malformed (expected xoxb-…)');
  }
  if (!appToken || !appToken.startsWith('xapp-')) {
    throw new Error('SLACK_APP_TOKEN missing or malformed (expected xapp-…)');
  }

  return { botToken, appToken };
}

// ─── redactTokens ──────────────────────────────────────────────────────────────

/**
 * Redact any Slack tokens embedded in a string.
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
  return s
    .replace(/xoxb-[A-Za-z0-9-]+/g, 'xoxb-***REDACTED***')
    .replace(/xapp-[A-Za-z0-9-]+/g, 'xapp-***REDACTED***');
}
