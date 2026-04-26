/**
 * web-tools/_lib/env.mjs  (ESM)
 *
 * Tiny env-file loader for non-interactive shells.
 *
 * Why this exists: bash tool calls (Claude Code, Synaps CLI, agent harnesses)
 * spawn non-login non-interactive shells that DO NOT source ~/.bashrc.
 * If the user has `export EXA_API_KEY=...` in their bashrc, an agent invoking
 * search.js via a one-shot bash call will see EXA_API_KEY missing.
 *
 * Solution: a canonical env file at ~/.config/synaps/web-tools.env that any
 * capability script can read directly, regardless of shell context.
 *
 * Format: dotenv-ish — `KEY=VALUE` per line, `#` comments and blank lines
 * ignored, optional `export ` prefix tolerated, surrounding matched quotes
 * stripped. NO interpolation, NO multi-line values.
 *
 * API:
 *   parseEnvFile(text)              → Record<string, string>
 *   loadEnvFile(path, opts?)        → Record<string, string>
 *
 * opts:
 *   injectInto: object              if provided, sets keys in this object
 *                                   (e.g. process.env) WITHOUT clobbering
 *                                   pre-set values (env wins over file).
 *   warnOnLoosePerms: boolean       if true and file mode is broader than
 *                                   0600, emit a one-line stderr warning.
 *
 * Best-effort: never throws. Returns {} on any I/O or parse failure.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_ENV_FILE = join(homedir(), ".config", "synaps", "web-tools.env");

/**
 * Parse a dotenv-style string into a key-value object.
 * Lenient: skips malformed lines silently.
 */
export function parseEnvFile(text) {
  const out = {};
  if (typeof text !== "string" || !text) return out;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Strip optional `export ` prefix
    const stripped = line.replace(/^export\s+/, "");

    const eq = stripped.indexOf("=");
    if (eq <= 0) continue; // no `=` or empty key

    const key = stripped.slice(0, eq).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = stripped.slice(eq + 1);
    // Don't trim value's trailing/leading whitespace by default — could be
    // significant. But strip ONE pair of matching surrounding quotes.
    if (value.length >= 2) {
      const first = value[0], last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load a dotenv-style file.
 * Returns parsed key-value object. Returns {} on missing file or read error.
 */
export function loadEnvFile(path, opts = {}) {
  const filePath = path || DEFAULT_ENV_FILE;
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return {}; // missing file is fine
  }
  if (!stat.isFile()) return {};

  // Optional perm warning: file should be 0600 since it holds secrets.
  if (opts.warnOnLoosePerms && process.platform !== "win32") {
    const mode = stat.mode & 0o777;
    if (mode & 0o077) {
      // Any group/other bits set
      try {
        console.error(
          `[web-tools] warning: ${filePath} has mode 0${mode.toString(8)} ` +
          `(should be 0600). Tighten with: chmod 600 ${filePath}`
        );
      } catch {}
    }
  }

  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return {};
  }

  let parsed;
  try {
    parsed = parseEnvFile(text);
  } catch {
    return {};
  }

  if (opts.injectInto && typeof opts.injectInto === "object") {
    for (const [k, v] of Object.entries(parsed)) {
      // Pre-set env wins over file — never clobber.
      if (opts.injectInto[k] === undefined || opts.injectInto[k] === "") {
        opts.injectInto[k] = v;
      }
    }
  }

  return parsed;
}
