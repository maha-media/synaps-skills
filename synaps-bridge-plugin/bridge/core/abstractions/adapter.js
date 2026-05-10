/**
 * @file adapter.js
 * @module bridge/core/abstractions/adapter
 *
 * Source-agnostic base class for all platform adapters.
 * Concrete adapters (e.g. SlackAdapter) extend AdapterInstance and
 * implement `start()` / `stop()`.  Core code branches on the capability
 * flags — never on source identity.
 */

/**
 * The full set of capability flags every adapter must declare.
 *
 * @typedef {Object} AdapterCapabilities
 * @property {boolean} streaming        - Native incremental streaming (chat.startStream / edit-in-place)
 * @property {boolean} richStreamChunks - Stream supports typed chunks beyond plain markdown_text
 *                                        (task_update, plan_update, blocks)
 * @property {boolean} buttons          - Interactive buttons / inline keyboards in replies
 * @property {boolean} files            - File uploads
 * @property {boolean} reactions        - Can react to the incoming user message with an emoji
 * @property {boolean} threading        - Platform has a thread concept (Slack thread_ts, Discord thread id)
 * @property {boolean} auxBlocks        - Can post out-of-band auxiliary messages alongside a stream
 * @property {boolean} aiAppMode        - First-class assistant/agent surface
 *                                        (assistant_thread_started, setStatus, etc.)
 */

/**
 * Safe default: every capability is off.
 *
 * Concrete adapters spread their own overrides on top:
 * ```js
 * import { DEFAULT_CAPABILITIES } from '../abstractions/adapter.js';
 * const caps = { ...DEFAULT_CAPABILITIES, streaming: true, threading: true };
 * ```
 *
 * @type {Readonly<AdapterCapabilities>}
 */
export const DEFAULT_CAPABILITIES = Object.freeze({
  streaming:        false,
  richStreamChunks: false,
  buttons:          false,
  files:            false,
  reactions:        false,
  threading:        false,
  auxBlocks:        false,
  aiAppMode:        false,
});

/**
 * Abstract base class for all platform adapters.
 *
 * Subclasses **must** implement {@link AdapterInstance#start} and
 * {@link AdapterInstance#stop}.  Direct instantiation of `AdapterInstance`
 * is forbidden and throws at construction time.
 *
 * @abstract
 */
export class AdapterInstance {
  /**
   * @param {object}               [opts]
   * @param {string}               [opts.source]        - Source identifier, e.g. `"my-platform"`.
   * @param {AdapterCapabilities}  [opts.capabilities]  - Partial capability overrides; merged
   *                                                      with {@link DEFAULT_CAPABILITIES}.
   * @param {object}               [opts.logger]        - Logger (default: `console`).
   */
  constructor({ source, capabilities = DEFAULT_CAPABILITIES, logger = console } = {}) {
    if (new.target === AdapterInstance) {
      throw new Error('AdapterInstance is abstract');
    }

    /** @type {string} Source identifier, e.g. `"my-platform"`. */
    this.source = source;

    /**
     * Frozen capability map.  Always contains every key from
     * {@link DEFAULT_CAPABILITIES}, with concrete-adapter overrides applied.
     *
     * @type {Readonly<AdapterCapabilities>}
     */
    this.capabilities = Object.freeze({ ...DEFAULT_CAPABILITIES, ...capabilities });

    /** @type {object} Injected logger (defaults to `console`). */
    this.logger = logger;
  }

  /**
   * Connect to the upstream platform.  Must be safe to call more than once
   * (idempotent after first call).
   *
   * @abstract
   * @returns {Promise<void>}
   */
  async start() {
    throw new Error('not implemented');
  }

  /**
   * Gracefully disconnect from the upstream platform.
   *
   * @abstract
   * @returns {Promise<void>}
   */
  async stop() {
    throw new Error('not implemented');
  }
}
