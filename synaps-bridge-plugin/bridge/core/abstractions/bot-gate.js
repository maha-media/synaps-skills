/**
 * @file bot-gate.js
 * @module bridge/core/abstractions/bot-gate
 *
 * Concrete (non-abstract) per-(source, conversation, thread) turn counter.
 *
 * Concrete adapters subclass `BotGate` and override `evaluate` to add
 * platform-specific rules — e.g. `SlackBotGate` short-circuits on
 * `aiAppMode` where every user utterance is inherently intentional.
 *
 * Core code only ever calls `evaluate`, `recordTurn`, and `reset`; it never
 * inspects the internal `_counts` map.
 */

/**
 * Gate result returned by {@link BotGate#evaluate}.
 *
 * @typedef {Object} GateResult
 * @property {boolean}  allowed - `true` if the turn should proceed.
 * @property {string}  [reason] - Machine-readable denial reason, present when
 *                                `allowed` is `false`.
 */

/**
 * Per-(source, conversation, thread) turn gate.
 *
 * The default implementation enforces a simple ceiling on the total number of
 * turns recorded for a given thread.  Pass `maxTurnsPerThread: Infinity` (the
 * default) to disable the limit entirely.
 */
export class BotGate {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxTurnsPerThread=Infinity] - Maximum number of turns
   *   allowed before the gate starts returning `{ allowed: false }`.
   * @param {object} [opts.logger=console]             - Injected logger.
   */
  constructor({ maxTurnsPerThread = Infinity, logger = console } = {}) {
    /** @type {number} */
    this.maxTurnsPerThread = maxTurnsPerThread;

    /** @type {object} */
    this.logger = logger;

    /**
     * Internal turn counter keyed by `"${source}|${conversation}|${thread}"`.
     *
     * @private
     * @type {Map<string, number>}
     */
    this._counts = new Map();
  }

  /**
   * Build the internal map key for a given (source, conversation, thread) triple.
   *
   * @private
   * @param {object} ctx
   * @param {string} ctx.source       - Source identifier, e.g. `"irc"` or `"webhook"`.
   * @param {string} ctx.conversation - Platform conversation / channel id.
   * @param {string} ctx.thread       - Thread identifier (or `""` for top-level).
   * @returns {string}
   */
  _key({ source, conversation, thread }) {
    return `${source}|${conversation}|${thread}`;
  }

  /**
   * Decide whether a new turn is allowed.
   *
   * The default implementation checks the recorded turn count against
   * `maxTurnsPerThread`.  Subclasses may override this method and call
   * `super.evaluate(...)` for the base check before applying additional rules.
   *
   * @param {object}  ctx
   * @param {string}  ctx.source       - Source identifier.
   * @param {string}  ctx.conversation - Platform conversation / channel id.
   * @param {string}  ctx.thread       - Thread identifier.
   * @param {string} [ctx.sender]      - Sender user id (available for subclass use).
   * @param {string} [ctx.text]        - Message text (available for subclass use).
   * @returns {GateResult}
   */
  evaluate({ source, conversation, thread, sender, text }) { // eslint-disable-line no-unused-vars
    const k = this._key({ source, conversation, thread });
    const used = this._counts.get(k) ?? 0;
    if (used >= this.maxTurnsPerThread) {
      return { allowed: false, reason: 'turn_limit_exceeded' };
    }
    return { allowed: true };
  }

  /**
   * Increment the turn counter for the given (source, conversation, thread).
   * Call this *after* a turn is successfully processed.
   *
   * @param {object} ctx
   * @param {string} ctx.source
   * @param {string} ctx.conversation
   * @param {string} ctx.thread
   * @returns {void}
   */
  recordTurn({ source, conversation, thread }) {
    const k = this._key({ source, conversation, thread });
    this._counts.set(k, (this._counts.get(k) ?? 0) + 1);
  }

  /**
   * Clear the turn counter for the given (source, conversation, thread).
   * Useful after a session reset or for test teardown.
   *
   * @param {object} ctx
   * @param {string} ctx.source
   * @param {string} ctx.conversation
   * @param {string} ctx.thread
   * @returns {void}
   */
  reset({ source, conversation, thread }) {
    this._counts.delete(this._key({ source, conversation, thread }));
  }
}
