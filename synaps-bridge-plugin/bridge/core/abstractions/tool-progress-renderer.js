/**
 * @file tool-progress-renderer.js
 * @module bridge/core/abstractions/tool-progress-renderer
 *
 * Abstract base class for platform tool-progress renderers.
 *
 * A `ToolProgressRenderer` converts a single tool-call lifecycle event —
 * start, result, or error — into the platform's native representation.  The
 * return value is opaque to core code: it may be a string (inline text), a
 * Block Kit array (Slack), an embed (Discord), etc.
 *
 * The streaming-proxy consults the adapter's capability tier to choose whether
 * the rendered value is injected as a `blocks` chunk into the active stream
 * (`richStreamChunks: true`), posted as an out-of-band aux message
 * (`auxBlocks: true`), or appended as plain text.
 *
 * Concrete renderers live under `bridge/sources/<name>/`.
 *
 * @abstract
 */

export class ToolProgressRenderer {
  /**
   * Instantiating `ToolProgressRenderer` directly is forbidden.
   *
   * @throws {Error} Always throws when called on `ToolProgressRenderer` itself.
   */
  constructor() {
    if (new.target === ToolProgressRenderer) {
      throw new Error('ToolProgressRenderer is abstract');
    }
  }

  /**
   * Render a single tool-call lifecycle event.
   *
   * Exactly one of `result` or `error` is present when the tool call has
   * completed; neither is present when the tool call is still in progress.
   *
   * @abstract
   * @param {object}  args
   * @param {string}  args.toolName   - Human-readable tool name.
   * @param {string}  args.toolId     - Unique tool-call identifier.
   * @param {*}       args.input      - Parsed tool input (may be `null` while streaming).
   * @param {*}      [args.result]    - Tool result payload (present when succeeded).
   * @param {*}      [args.error]     - Error value (present when the tool call failed).
   * @returns {*}    Renderer-specific representation (string, blocks array, etc.)
   * @throws {Error} Always throws — subclass must override.
   */
  render({ toolName, toolId, input, result, error }) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }
}
