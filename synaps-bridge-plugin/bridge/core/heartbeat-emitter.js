/**
 * @file bridge/core/heartbeat-emitter.js
 *
 * HeartbeatEmitter — periodic timer that calls repo.record() at a configured
 * cadence with optional dynamic details and health callbacks.
 *
 * Spec reference: PHASE_5_BRIEF.md § "A2 — HeartbeatEmitter"
 *
 * Design notes
 * ────────────
 *  • `setInterval` and `clearInterval` are injected so vitest fake timers
 *    exercise the real scheduling path without monkey-patching globals.
 *  • `beatNow()` is intentionally error-swallowing — if the repo call or either
 *    callback throws, we log a warn and return; the interval keeps ticking.
 *  • `stop()` is async so callers can await the best-effort shutdown beat.
 *  • `start()` is synchronous after scheduling; the initial beatNow() is
 *    fire-and-forget (not awaited) so start() returns immediately.
 */

// ─── No-op logger ─────────────────────────────────────────────────────────────

const NOOP_LOGGER = {
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
};

// ─── HeartbeatEmitter ─────────────────────────────────────────────────────────

export class HeartbeatEmitter {
  /**
   * @param {object} opts
   * @param {object}   opts.repo             – HeartbeatRepo; must expose `.record()`
   * @param {string}   opts.component        – non-empty string
   * @param {string}   opts.id               – non-empty string
   * @param {number}   opts.intervalMs       – ms between beats; must be > 0
   * @param {Function} [opts.detailsFn]      – () => object | Promise<object>
   * @param {Function} [opts.healthFn]       – () => boolean | Promise<boolean>
   * @param {object}   [opts.logger]         – { debug, info, warn, error }
   * @param {Function} [opts.setInterval]    – injectable (default globalThis.setInterval)
   * @param {Function} [opts.clearInterval]  – injectable (default globalThis.clearInterval)
   */
  constructor({
    repo,
    component,
    id,
    intervalMs,
    detailsFn,
    healthFn,
    logger,
    setInterval:   setIntervalImpl   = globalThis.setInterval,
    clearInterval: clearIntervalImpl = globalThis.clearInterval,
  } = {}) {
    // ── Validation ────────────────────────────────────────────────────────────
    if (repo === undefined || repo === null) {
      throw new TypeError('HeartbeatEmitter: repo is required');
    }
    if (typeof repo.record !== 'function') {
      throw new TypeError('HeartbeatEmitter: repo.record must be a function');
    }
    if (typeof component !== 'string' || component.trim() === '') {
      throw new TypeError('HeartbeatEmitter: component must be a non-empty string');
    }
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TypeError('HeartbeatEmitter: id must be a non-empty string');
    }
    if (typeof intervalMs !== 'number' || intervalMs <= 0) {
      throw new TypeError('HeartbeatEmitter: intervalMs must be a number > 0');
    }

    // ── Private state ─────────────────────────────────────────────────────────
    this._repo              = repo;
    this._component         = component;
    this._id                = id;
    this._intervalMs        = intervalMs;
    this._detailsFn         = typeof detailsFn === 'function' ? detailsFn : null;
    this._healthFn          = typeof healthFn  === 'function' ? healthFn  : null;
    this._logger            = logger ?? NOOP_LOGGER;
    this._setInterval       = setIntervalImpl;
    this._clearInterval     = clearIntervalImpl;
    this._timer             = null;
    this._running           = false;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Begin emitting.
   * Calls beatNow() immediately (fire-and-forget), then schedules the interval.
   * Throws if already running.
   */
  start() {
    if (this._running) {
      throw new Error('HeartbeatEmitter: already started');
    }

    this._running = true;

    // Fire immediately — do NOT await; start() must remain synchronous.
    this.beatNow().catch((err) => {
      /* istanbul ignore next — beatNow() swallows internally; belt-and-braces */
      this._logger.warn('heartbeat emit failed', {
        component: this._component,
        id:        this._id,
        error:     err?.message,
      });
    });

    this._timer = this._setInterval(() => {
      this.beatNow().catch((err) => {
        /* istanbul ignore next */
        this._logger.warn('heartbeat emit failed', {
          component: this._component,
          id:        this._id,
          error:     err?.message,
        });
      });
    }, this._intervalMs);

    this._logger.info('heartbeat emitter started', {
      component:  this._component,
      id:         this._id,
      intervalMs: this._intervalMs,
    });
  }

  /**
   * Stop emitting.
   * Clears the interval timer, marks _running = false, then best-effort emits a
   * final healthy=false beat.
   * No-op if not currently running.
   */
  async stop() {
    if (!this._running) {
      return; // already stopped or never started
    }

    this._clearInterval(this._timer);
    this._timer   = null;
    this._running = false;

    this._logger.info('heartbeat emitter stopped', {
      component: this._component,
      id:        this._id,
    });

    // Best-effort final beat — swallow any error
    await this._repo
      .record({
        component: this._component,
        id:        this._id,
        healthy:   false,
        details:   { reason: 'shutdown' },
      })
      .catch((err) => {
        this._logger.warn('heartbeat final beat failed', {
          component: this._component,
          id:        this._id,
          error:     err?.message,
        });
      });
  }

  /**
   * Single beat — resolves regardless of whether repo.record() succeeded.
   * Errors from healthFn, detailsFn, or repo.record are caught and logged.
   */
  async beatNow() {
    const { _component: component, _id: id } = this;

    let healthy = true;
    let details = {};

    try {
      // Resolve health
      if (this._healthFn !== null) {
        healthy = await this._healthFn();
      }

      // Resolve details
      if (this._detailsFn !== null) {
        details = await this._detailsFn();
      }

      // Record
      await this._repo.record({ component, id, healthy, details });

      // Success log
      if (typeof this._logger.debug === 'function') {
        this._logger.debug('heartbeat', { component, id, healthy, ageMs: 0 });
      }
    } catch (err) {
      this._logger.warn('heartbeat emit failed', {
        component,
        id,
        error: err?.message,
      });
    }
  }

  /**
   * Whether the emitter is currently running.
   * @returns {boolean}
   */
  get running() {
    return this._running;
  }
}
