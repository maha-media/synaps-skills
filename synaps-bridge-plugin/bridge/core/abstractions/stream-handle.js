/**
 * @file stream-handle.js
 * @module bridge/core/abstractions/stream-handle
 *
 * Abstract base class for platform streaming handles.
 *
 * A `StreamHandle` manages a single in-progress streaming reply: it is opened
 * once (`start`), receives zero-or-more typed chunks (`append`), then closed
 * (`stop`).  Concrete implementations (e.g. `SlackStreamHandle`) call the
 * appropriate platform APIs.
 *
 * Core code (streaming-proxy) always interacts through this interface and
 * never imports a concrete implementation directly.
 *
 * @abstract
 */

/**
 * A single chunk appended to an in-progress stream.
 *
 * `type` selects the variant; exactly one of the optional payload fields is
 * present for each variant:
 *
 * | `type`          | payload field | notes                                         |
 * |-----------------|---------------|-----------------------------------------------|
 * | `markdown_text` | `content`     | Incremental markdown string fragment.         |
 * | `task_update`   | `task`        | Subagent state update (rich-chunk adapters).  |
 * | `plan_update`   | `plan`        | Plan-step update (rich-chunk adapters).       |
 * | `blocks`        | `blocks`      | Block Kit (or equivalent) array.             |
 *
 * @typedef {Object} StreamChunk
 * @property {"markdown_text"|"task_update"|"plan_update"|"blocks"} type
 * @property {string} [content] - Markdown text fragment (`markdown_text` type).
 * @property {*}      [task]    - Task-update payload (`task_update` type).
 * @property {*}      [plan]    - Plan-update payload (`plan_update` type).
 * @property {*}      [blocks]  - Block Kit array (`blocks` type).
 */

export class StreamHandle {
  /**
   * Instantiating `StreamHandle` directly is forbidden.
   *
   * @throws {Error} Always throws when called on `StreamHandle` itself.
   */
  constructor() {
    if (new.target === StreamHandle) {
      throw new Error('StreamHandle is abstract');
    }
  }

  /**
   * Open the stream and post the initial placeholder message (or open the
   * streaming API connection).  Must be called exactly once before `append`.
   *
   * @abstract
   * @param {object} [opts]
   * @param {string} [opts.conversation] - Platform conversation / channel id.
   * @param {string} [opts.thread]       - Thread identifier for the reply.
   * @param {string} [opts.recipient]    - User or DM recipient id.
   * @returns {Promise<void>}
   * @throws {Error} Always throws — subclass must override.
   */
  async start({ conversation, thread, recipient } = {}) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }

  /**
   * Append a typed chunk to the in-progress stream.
   *
   * @abstract
   * @param {StreamChunk} chunk - The chunk to append.
   * @returns {Promise<void>}
   * @throws {Error} Always throws — subclass must override.
   */
  async append(chunk) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }

  /**
   * Close the stream.  Concrete implementations may use the `blocks` option
   * to post trailing static content (e.g. a footer Block Kit message).
   *
   * @abstract
   * @param {object} [opts]
   * @param {*}      [opts.blocks] - Optional trailing blocks / footer payload.
   * @returns {Promise<void>}
   * @throws {Error} Always throws — subclass must override.
   */
  async stop({ blocks } = {}) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }
}
