/**
 * @file formatter.js
 * @module bridge/core/abstractions/formatter
 *
 * Abstract base class for all platform formatters.
 *
 * A `Formatter` converts source-agnostic content (markdown strings, error
 * objects, subagent state) into whatever representation the target platform
 * expects — e.g. a Slack Block Kit array, a Discord embed, or a plain string
 * for IRC.
 *
 * Concrete formatters live under `bridge/sources/<name>/` and must never
 * be imported from `bridge/core/**`.
 *
 * @abstract
 */

/**
 * @typedef {Object} SubagentState
 * @property {string}  id                          - Unique subagent id.
 * @property {string}  agent_name                  - Human-readable agent name.
 * @property {"pending"|"running"|"done"|"failed"} status - Current lifecycle status.
 * @property {string}  [task_preview]              - Short preview of the task.
 * @property {string}  [result_preview]            - Short preview of the result (done/failed).
 * @property {number}  [duration_secs]             - Wall-clock duration (done/failed).
 */

export class Formatter {
  /**
   * Instantiating `Formatter` directly is forbidden.
   *
   * @throws {Error} Always throws when called on `Formatter` itself.
   */
  constructor() {
    if (new.target === Formatter) {
      throw new Error('Formatter is abstract');
    }
  }

  /**
   * Convert a markdown string into the platform's native representation.
   *
   * The return type is platform-dependent: a string for text-only platforms,
   * a Block Kit array for Slack, an embed object for Discord, etc.
   *
   * @abstract
   * @param {string} md - Markdown-formatted input string.
   * @returns {*}       Platform-native string or structured object/array.
   * @throws {Error}    Always throws — subclass must override.
   */
  formatMarkdown(md) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }

  /**
   * Format an error for display in the chat thread.
   *
   * @abstract
   * @param {Error|*} err - The error to format.
   * @returns {*}         Platform-native representation.
   * @throws {Error}      Always throws — subclass must override.
   */
  formatError(err) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }

  /**
   * Format a subagent lifecycle state for display.
   *
   * @abstract
   * @param {SubagentState} state - Current subagent state snapshot.
   * @returns {*}                 Platform-native representation.
   * @throws {Error}              Always throws — subclass must override.
   */
  formatSubagent(state) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }
}
