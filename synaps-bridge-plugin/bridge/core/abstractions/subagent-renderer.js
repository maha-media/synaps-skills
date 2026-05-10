/**
 * @file subagent-renderer.js
 * @module bridge/core/abstractions/subagent-renderer
 *
 * Abstract base class for platform subagent-state renderers.
 *
 * A `SubagentRenderer` converts a {@link SubagentState} snapshot into the
 * platform's native representation.  In AI-app mode (Slack) this is a
 * `task_update` chunk payload; in legacy mode it is a Block Kit array for an
 * out-of-band aux message; for text-only platforms it is a plain string.
 *
 * Core code (streaming-proxy / subagent-tracker) calls `render` and routes
 * the opaque return value through the appropriate capability tier —
 * `richStreamChunks` → `auxBlocks` → inline text — without knowing the
 * concrete renderer type.
 *
 * Concrete renderers live under `bridge/sources/<name>/`.
 *
 * @abstract
 */

/**
 * A point-in-time snapshot of a subagent's lifecycle state.
 *
 * @typedef {Object} SubagentState
 * @property {string}  id                          - Unique subagent identifier.
 * @property {string}  agent_name                  - Human-readable agent name.
 * @property {"pending"|"running"|"done"|"failed"} status - Current lifecycle status.
 * @property {string}  [task_preview]              - Short preview of the assigned task.
 * @property {string}  [result_preview]            - Short preview of the result
 *                                                   (populated for `done` / `failed`).
 * @property {number}  [duration_secs]             - Wall-clock duration in seconds
 *                                                   (populated for `done` / `failed`).
 */

export class SubagentRenderer {
  /**
   * Instantiating `SubagentRenderer` directly is forbidden.
   *
   * @throws {Error} Always throws when called on `SubagentRenderer` itself.
   */
  constructor() {
    if (new.target === SubagentRenderer) {
      throw new Error('SubagentRenderer is abstract');
    }
  }

  /**
   * Render a subagent state snapshot into the platform's native representation.
   *
   * @abstract
   * @param {SubagentState} state - Current snapshot of the subagent's lifecycle.
   * @returns {*}                 Renderer-specific representation (chunk payload,
   *                              blocks array, plain string, etc.)
   * @throws {Error}              Always throws — subclass must override.
   */
  render(state) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }
}
