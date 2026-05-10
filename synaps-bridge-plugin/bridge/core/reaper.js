/**
 * @file bridge/core/reaper.js
 *
 * Reaper — periodic sweep that finds stale heartbeats and terminates the
 * corresponding subjects (workspaces, rpcs).
 *
 * Spec reference: PHASE_5_BRIEF.md § "A3 — Reaper"
 *                 PHASE_6_BRIEF.md § "6.5 InboxNotifier" + "B2 — Reaper InboxNotifier wiring"
 *
 * Design notes
 * ────────────
 *  • `setInterval` / `clearInterval` are injected so vitest fake timers can
 *    drive the scheduler without patching globals.
 *  • `sweepNow()` is serial (workspace → rpc → scp) to avoid thundering-herd
 *    on shared resources.
 *  • Per-target errors are caught and recorded in the summary; the sweep
 *    continues.  Top-level `repo.findStale` errors are caught per-section so
 *    a failure in one component type doesn't abort the others.
 *  • `workspaceManager.markReaped` failures are best-effort: the error is
 *    recorded in errors[] but `repo.remove` still runs so the heartbeat is
 *    cleaned up.
 *  • SCP heartbeats are informational only — systemd Restart=always handles
 *    process-level recovery.
 *  • `inboxNotifier` fires only for container-level workspace reaps (layer-boundary
 *    discipline: rpc reaps are the watcher's responsibility).  Notifier errors
 *    are caught and warn-logged; they NEVER fail the reap.
 *  • When `inboxNotifier` is null/absent, behavior is identical to Phase 5.
 */

// ─── defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = Object.freeze({
  workspaceMs: 30 * 60_000, // 30 min
  rpcMs:        5 * 60_000, //  5 min
  scpMs:           30_000,  // 30 s — info only
});

const NOOP_LOGGER = {
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
};

// ─── Reaper ───────────────────────────────────────────────────────────────────

/**
 * Periodic sweep that terminates subjects whose heartbeats have gone stale.
 *
 * @example
 * const reaper = new Reaper({ repo, workspaceManager, rpcKiller, intervalMs: 60_000, logger });
 * reaper.start();
 * // … later …
 * reaper.stop();
 */
export class Reaper {
  /**
   * @param {object}   opts
   * @param {object}   opts.repo                      - HeartbeatRepo (.findStale / .remove).
   * @param {object}   [opts.workspaceManager]        - Optional; needs .stopWorkspace(id) and .markReaped(id).
   * @param {Function} [opts.rpcKiller]               - Optional; async (sessionId) => void.
   * @param {number}   opts.intervalMs                - Sweep cadence in milliseconds (required).
   * @param {object}   [opts.thresholds]              - Override any subset of default thresholds.
   * @param {number}   [opts.thresholds.workspaceMs]  - Default 30 min.
   * @param {number}   [opts.thresholds.rpcMs]        - Default 5 min.
   * @param {number}   [opts.thresholds.scpMs]        - Default 30 s.
   * @param {object}   [opts.logger]                  - Logger with .info/.warn/.error/.debug.
   * @param {Function} [opts.setInterval]             - Injected setInterval (default: globalThis.setInterval).
   * @param {Function} [opts.clearInterval]           - Injected clearInterval (default: globalThis.clearInterval).
   * @param {Function} [opts.now]                     - Injected clock; returns current Date. Default: () => new Date().
   * @param {object}   [opts.inboxNotifier]           - Optional InboxNotifier; when present, fires a
   *                                                    workspace_reaped inbox event after each successful
   *                                                    workspace reap.  Null/absent = Phase 5 back-compat.
   * @param {Function} [opts.inboxDirFor]             - Optional; (workspaceId: string) => string — resolves
   *                                                    the per-workspace inbox directory path.  Required only
   *                                                    when inboxNotifier is set.
   */
  constructor({
    repo,
    workspaceManager,
    rpcKiller,
    intervalMs,
    thresholds = {},
    logger,
    setInterval:   setIntervalImpl   = globalThis.setInterval,
    clearInterval: clearIntervalImpl = globalThis.clearInterval,
    now = () => new Date(),
    inboxNotifier = null,
    inboxDirFor   = null,
  } = {}) {
    if (!repo) {
      throw new Error('Reaper: opts.repo is required');
    }
    if (intervalMs === undefined || intervalMs === null) {
      throw new Error('Reaper: opts.intervalMs is required');
    }
    if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error('Reaper: opts.intervalMs must be a positive finite number');
    }

    this._repo             = repo;
    this._workspaceManager = workspaceManager ?? null;
    this._rpcKiller        = rpcKiller        ?? null;
    this._intervalMs       = intervalMs;

    // Merge caller-supplied thresholds over defaults (partial override).
    this._thresholds = Object.freeze({
      ...DEFAULT_THRESHOLDS,
      ...thresholds,
    });

    this._logger           = logger ?? NOOP_LOGGER;
    this._setInterval      = setIntervalImpl;
    this._clearInterval    = clearIntervalImpl;
    this._now              = now;

    // Phase 6 — InboxNotifier (optional, null = Phase 5 back-compat).
    this._inboxNotifier    = inboxNotifier ?? null;
    this._inboxDirFor      = inboxDirFor   ?? null;

    this._timer            = null;
    this._running          = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Begin periodic sweeps.  Calls sweepNow() immediately (fire-and-forget),
   * then schedules the recurring interval.
   *
   * @throws {Error} If already running.
   */
  start() {
    if (this._running) {
      throw new Error('Reaper: already running — call stop() first');
    }

    this._running = true;

    // Immediate fire-and-forget sweep so the first sweep doesn't wait
    // intervalMs before running.
    this.sweepNow().catch((err) => {
      this._logger.error('reaper sweep failed (immediate)', err);
    });

    this._timer = this._setInterval(() => {
      this.sweepNow().catch((err) => {
        this._logger.error('reaper sweep failed (interval)', err);
      });
    }, this._intervalMs);
  }

  /**
   * Stop sweeps.  Cancels the timer.  Safe to call before start() (no-op).
   */
  stop() {
    if (!this._running) return;

    this._clearInterval(this._timer);
    this._timer   = null;
    this._running = false;
  }

  /**
   * Whether periodic sweeps are currently scheduled.
   * @type {boolean}
   */
  get running() {
    return this._running;
  }

  // ── Core sweep ─────────────────────────────────────────────────────────────

  /**
   * Execute a single sweep across all component types.
   *
   * Returns a summary object:
   * ```
   * {
   *   reaped:   { workspaces: string[], rpcs: string[] },
   *   scpStale: string[],
   *   errors:   Array<{ component: string, id: string, error: Error }>,
   * }
   * ```
   *
   * Top-level `repo.findStale` errors for a component section are caught and
   * logged; the remaining sections still run.  Per-target errors are caught,
   * logged, and recorded in `errors[]`; the sweep continues to the next target.
   *
   * @returns {Promise<object>}
   */
  async sweepNow() {
    const reaped   = { workspaces: [], rpcs: [] };
    const scpStale = [];
    const errors   = [];

    // ── 1. Workspace sweep ──────────────────────────────────────────────────
    let workspaces = [];
    try {
      workspaces = await this._repo.findStale({
        component:   'workspace',
        olderThanMs: this._thresholds.workspaceMs,
      });
    } catch (err) {
      this._logger.error('reaper: repo.findStale failed for workspace', err);
      workspaces = [];
    }

    if (workspaces.length > 0) {
      if (!this._workspaceManager) {
        this._logger.warn(
          'reaper: workspaceManager not configured — skipping workspace reap',
          { count: workspaces.length },
        );
      } else {
        for (const doc of workspaces) {
          const id = doc.id;
          // Calculate age for inbox notification payload (best-effort: default 0 if ts absent).
          const heartbeat = doc;
          const ageMs     = heartbeat.ts ? (this._now().getTime() - new Date(heartbeat.ts).getTime()) : 0;

          try {
            await this._workspaceManager.stopWorkspace(id);
          } catch (err) {
            this._logger.error('reaper: stopWorkspace failed', { id, err });
            errors.push({ component: 'workspace', id, error: err });
            continue; // skip repo.remove — workspace may still be live
          }

          // markReaped is best-effort: failure is recorded but does NOT
          // prevent the heartbeat removal below.
          try {
            await this._workspaceManager.markReaped(id);
          } catch (markErr) {
            this._logger.warn('reaper: markReaped failed (best-effort)', { id, error: markErr });
            errors.push({ component: 'workspace', id, error: markErr });
          }

          try {
            await this._repo.remove({ component: 'workspace', id });
          } catch (removeErr) {
            this._logger.warn('reaper: repo.remove failed for workspace', { id, error: removeErr });
            errors.push({ component: 'workspace', id, error: removeErr });
          }

          // Phase 6 — fire inbox notification (container-level reap only; NOT for rpc reaps).
          // Errors are caught + warn-logged; they NEVER fail the reap.
          if (this._inboxNotifier !== null) {
            try {
              await this._inboxNotifier.notifyWorkspaceReaped({
                workspaceId:  id,
                synapsUserId: heartbeat?.details?.synaps_user_id ?? null,
                reason:       'stale_heartbeat',
                details:      { ageMs, threshold: this._thresholds.workspaceMs },
              });
            } catch (err) {
              this._logger.warn('inbox notify failed', { workspaceId: id, err: err.message });
            }
          }

          reaped.workspaces.push(id);
        }
      }
    }

    // ── 2. RPC sweep ────────────────────────────────────────────────────────
    let rpcs = [];
    try {
      rpcs = await this._repo.findStale({
        component:   'rpc',
        olderThanMs: this._thresholds.rpcMs,
      });
    } catch (err) {
      this._logger.error('reaper: repo.findStale failed for rpc', err);
      rpcs = [];
    }

    if (rpcs.length > 0) {
      if (!this._rpcKiller) {
        this._logger.warn(
          'reaper: rpcKiller not configured — skipping rpc reap',
          { count: rpcs.length },
        );
      } else {
        for (const doc of rpcs) {
          const id = doc.id;
          try {
            await this._rpcKiller(id);
          } catch (err) {
            this._logger.error('reaper: rpcKiller failed', { id, err });
            errors.push({ component: 'rpc', id, error: err });
            continue; // skip repo.remove — session may still be live
          }

          try {
            await this._repo.remove({ component: 'rpc', id });
          } catch (removeErr) {
            this._logger.warn('reaper: repo.remove failed for rpc', { id, error: removeErr });
            errors.push({ component: 'rpc', id, error: removeErr });
          }

          reaped.rpcs.push(id);
        }
      }
    }

    // ── 3. SCP sweep (info-only) ─────────────────────────────────────────────
    let scpDocs = [];
    try {
      scpDocs = await this._repo.findStale({
        component:   'scp',
        olderThanMs: this._thresholds.scpMs,
      });
    } catch (err) {
      this._logger.error('reaper: repo.findStale failed for scp', err);
      scpDocs = [];
    }

    for (const doc of scpDocs) {
      this._logger.warn('reaper: scp heartbeat stale; relying on systemd restart', { id: doc.id });
      scpStale.push(doc.id);
    }

    // ── 4. Summary ───────────────────────────────────────────────────────────
    const summary = { reaped, scpStale, errors };
    this._logger.info('reaper sweep complete', summary);

    return summary;
  }
}
