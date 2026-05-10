/**
 * @file bridge/core/inbox-notifier.js
 *
 * InboxNotifier — writes a Rust-`Event`-shaped JSON file into the
 * SynapsCLI watcher's inbox directory whenever the Phase-5 Reaper
 * stops a workspace container.
 *
 * Mirrors `watcher::supervisor::notify_inbox_completion` from SynapsCLI
 * (`src/watcher/supervisor.rs`).  The JSON payload MUST exactly match the
 * Rust `Event` / `EventSource` / `EventContent` struct serialisation so the
 * in-container SynapsCLI event bus can deserialise it without modification.
 *
 * NoopInboxNotifier
 *   - Same public API surface.
 *   - Every `notifyWorkspaceReaped()` call resolves to `{ written: false, reason: 'noop' }`.
 *   - Used when the inbox feature is disabled or no inboxDir is configured.
 *
 * ─── Cardinal rules ──────────────────────────────────────────────────────────
 * • ESM only (import / export)
 * • No top-level await
 * • No I/O in constructors
 * • No slack / synaps service imports (core layer)
 * • FS errors are caught + warn-logged — notifyWorkspaceReaped() NEVER throws
 */

import { randomUUID as _randomUUID } from 'node:crypto';
import { promises as _fsPromises } from 'node:fs';
import { join } from 'node:path';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a Date as `YYYYMMDD-HHMMSS` (UTC) — matches the Rust
 * `chrono::Utc::now().format("%Y%m%d-%H%M%S")` pattern.
 *
 * @param {Date} date
 * @returns {string}
 */
function formatTimestamp(date) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const Y  = date.getUTCFullYear();
  const Mo = pad(date.getUTCMonth() + 1);
  const D  = pad(date.getUTCDate());
  const H  = pad(date.getUTCHours());
  const Mi = pad(date.getUTCMinutes());
  const S  = pad(date.getUTCSeconds());
  return `${Y}${Mo}${D}-${H}${Mi}${S}`;
}

/**
 * Build the human-readable detail string that goes inside `content.text`.
 * Falls back gracefully when `details` is missing / not an object.
 *
 * @param {unknown} details
 * @returns {string}
 */
function humanDetail(details) {
  if (!details || typeof details !== 'object') return String(details ?? '');

  // ageMs → "Xm idle"
  if (typeof details.ageMs === 'number') {
    const mins = Math.round(details.ageMs / 60_000);
    return `${mins}m idle`;
  }

  // Fallback: join key=value pairs
  return Object.entries(details)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

// ─── InboxNotifier ────────────────────────────────────────────────────────────

export class InboxNotifier {
  /**
   * @param {object}   opts
   * @param {string}   opts.inboxDir      - Absolute path to the workspace's
   *                                        `~/.synaps-cli/inbox/` mount point.
   * @param {object}   [opts.fs]          - Injectable fs (must expose `mkdir` + `writeFile`).
   *                                        Defaults to `node:fs/promises`.
   * @param {Function} [opts.now]         - () => Date — injectable clock for tests.
   * @param {object}   [opts.logger]      - { info, warn, error, debug }
   * @param {Function} [opts.randomUUID]  - () => string — injectable UUID generator.
   */
  constructor({ inboxDir, fs, now, logger, randomUUID } = {}) {
    if (!inboxDir || typeof inboxDir !== 'string') {
      throw new TypeError('InboxNotifier: inboxDir must be a non-empty string');
    }

    this._inboxDir    = inboxDir;
    this._fs          = fs ?? _fsPromises;
    this._now         = now ?? (() => new Date());
    this._logger      = logger ?? console;
    this._randomUUID  = randomUUID ?? _randomUUID;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Write a `workspace_reaped` event JSON file into `inboxDir`.
   *
   * Never throws — any filesystem error is caught, warn-logged, and reflected
   * in the returned `{ written: false, error }` value.
   *
   * @param {object}      args
   * @param {string}      args.workspaceId
   * @param {string|null} args.synapsUserId
   * @param {string}      args.reason       - e.g. `'stale_heartbeat'`
   * @param {object}      [args.details]    - Free-form additional context.
   * @returns {Promise<{ written: true, path: string } | { written: false, error: string }>}
   */
  async notifyWorkspaceReaped({ workspaceId, synapsUserId, reason, details } = {}) {
    const now       = this._now();
    const id        = this._randomUUID();
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const ts        = now instanceof Date ? now : new Date(now);
    const filename  = `reaper-${workspaceId}-${formatTimestamp(ts)}.json`;
    const filePath  = join(this._inboxDir, filename);

    // Build the Rust-compatible Event payload.
    const payload = {
      id,
      timestamp,
      source: {
        source_type: 'reaper',
        name:        workspaceId,
        callback:    null,
      },
      channel:  null,
      sender:   null,
      content: {
        text:         `Workspace '${workspaceId}' reaped (${reason}, ${humanDetail(details)})`,
        content_type: 'workspace_reaped',
        severity:     'High',
        data: {
          workspace_id:   workspaceId,
          synaps_user_id: synapsUserId ?? null,
          reason,
          details:        details ?? {},
        },
      },
      expects_response: false,
      reply_to:         null,
    };

    // ── 1. Ensure directory exists ───────────────────────────────────────────
    try {
      await this._fs.mkdir(this._inboxDir, { recursive: true });
    } catch (err) {
      this._logger.warn('InboxNotifier: mkdir failed', {
        inboxDir: this._inboxDir,
        err: err.message,
      });
      return { written: false, error: err.message };
    }

    // ── 2. Write event file ──────────────────────────────────────────────────
    try {
      await this._fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      this._logger.warn('InboxNotifier: writeFile failed', {
        path: filePath,
        err:  err.message,
      });
      return { written: false, error: err.message };
    }

    this._logger.info('InboxNotifier: event written', {
      workspaceId,
      path: filePath,
    });

    return { written: true, path: filePath };
  }
}

// ─── NoopInboxNotifier ────────────────────────────────────────────────────────

/**
 * Drop-in replacement for InboxNotifier used when the inbox feature is
 * disabled or no inboxDir is available.  All methods resolve immediately
 * without performing any I/O.
 */
export class NoopInboxNotifier {
  /**
   * Does nothing — inbox feature is disabled.
   *
   * @returns {Promise<{ written: false, reason: 'noop' }>}
   */
  // eslint-disable-next-line no-unused-vars
  async notifyWorkspaceReaped(..._args) {
    return { written: false, reason: 'noop' };
  }
}
