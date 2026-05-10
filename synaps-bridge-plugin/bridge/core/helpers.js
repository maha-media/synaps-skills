// bridge/core/helpers.js
//
// Pure source-agnostic utility functions.
// No Slack / Discord imports. No process.env reads. No I/O.

// ─── Model-directive parsing ─────────────────────────────────────────────────

/**
 * @typedef {Object} ParsedDirective
 * @property {string|null} model  - The requested model name, or null if absent.
 * @property {string}      body   - Message text with the directive line removed.
 */

/**
 * Extract the first-line directive `set-model: <name>` from a user message.
 * Matching is case-insensitive and tolerates optional whitespace around the
 * colon.  The directive MUST appear on the very first line; a directive
 * embedded in the middle of a message is ignored.
 *
 * @param {string} message
 * @returns {ParsedDirective}
 */
export function parseSetModelDirective(message) {
  const firstNewline = message.indexOf("\n");
  const firstLine =
    firstNewline === -1 ? message : message.slice(0, firstNewline);

  const match = firstLine.match(/^set-model\s*:\s*(\S+)\s*$/i);
  if (!match) {
    return { model: null, body: message };
  }

  const model = match[1];
  // Strip the directive line and the single following newline (if any).
  const body =
    firstNewline === -1 ? "" : message.slice(firstNewline + 1);

  return { model, body };
}

// ─── String utilities ────────────────────────────────────────────────────────

/**
 * Truncate `s` to at most `maxChars` characters.
 * If truncated, `ellipsis` is appended (replacing the last characters so the
 * total length stays ≤ maxChars).
 *
 * @param {string} s
 * @param {number} maxChars
 * @param {string} [ellipsis="…"]
 * @returns {string}
 */
export function truncate(s, maxChars, ellipsis = "…") {
  if (s.length <= maxChars) return s;
  const cutAt = Math.max(0, maxChars - ellipsis.length);
  return s.slice(0, cutAt) + ellipsis;
}

/**
 * Stable JSON.stringify with alphabetically sorted object keys.
 * Useful for producing deterministic cache keys / content hashes.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  return JSON.stringify(value, (_, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  });
}

// ANSI CSI sequences: ESC [ ... <final byte 0x40–0x7E>
// Also handles ESC followed by a single non-CSI character (OSC, etc.).
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

/**
 * Strip ANSI/VT escape sequences from `s`.
 *
 * @param {string} s
 * @returns {string}
 */
export function stripAnsi(s) {
  return s.replace(ANSI_RE, "");
}

/**
 * Resolve after `ms` milliseconds.
 * Works with `vi.useFakeTimers()` because it uses `setTimeout` internally.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Error formatting ────────────────────────────────────────────────────────

/**
 * Format an Error for a single log line.
 * Includes `err.message` and, if present, `err.code`.  Stack is omitted.
 *
 * @param {Error|unknown} err
 * @returns {string}
 */
export function formatErrorLine(err) {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const code = /** @type {any} */ (err).code;
  return code != null
    ? `${err.message} (code=${code})`
    : err.message;
}

// ─── Session key ─────────────────────────────────────────────────────────────

/**
 * Compose a stable, deterministic session key for the
 * (source, conversation, thread) triple.
 *
 * @param {{ source: string, conversation: string, thread: string }} params
 * @returns {string}
 */
export function sessionKey({ source, conversation, thread }) {
  // Simple colon-separated concatenation.  Values must not contain colons;
  // callers are responsible for encoding if needed.
  return `${source}:${conversation}:${thread}`;
}
