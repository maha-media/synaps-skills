/**
 * @file tool-progress.js
 * @module bridge/core/tool-progress
 *
 * Tracker for tool-call lifecycle within a single agent turn. No I/O; pure
 * in-memory state machine keyed by tool_id.
 */

/**
 * @typedef {Object} TrackedTool
 * @property {string}           toolId
 * @property {string}           toolName
 * @property {string}           inputBuffer   - Accumulating JSON fragments.
 * @property {*}                input         - Final parsed input (set on toolcall_input).
 * @property {*}                [result]
 * @property {*}                [error]
 * @property {"running"|"done"} status
 * @property {number}           startedAt
 * @property {number}           [doneAt]
 */

export class ToolProgress {
  /**
   * @param {object}   [opts]
   * @param {()=>number} [opts.nowMs] - Injectable clock. Defaults to Date.now.
   */
  constructor({ nowMs = () => Date.now() } = {}) {
    /** @type {()=>number} */
    this._nowMs = nowMs;

    /** @type {Map<string, TrackedTool>} insertion-ordered */
    this._map = new Map();
  }

  /**
   * Record a new tool-call starting.
   *
   * @param {object} params
   * @param {string} params.tool_id
   * @param {string} params.tool_name
   */
  onStart({ tool_id, tool_name }) {
    /** @type {TrackedTool} */
    const entry = {
      toolId: tool_id,
      toolName: tool_name,
      inputBuffer: '',
      input: null,
      status: 'running',
      startedAt: this._nowMs(),
    };
    this._map.set(tool_id, entry);
  }

  /**
   * Append a JSON fragment to the tool's input buffer.
   *
   * @param {object} params
   * @param {string} params.tool_id
   * @param {string} params.delta
   */
  onInputDelta({ tool_id, delta }) {
    const entry = this._map.get(tool_id);
    if (!entry) return;
    entry.inputBuffer += delta;
  }

  /**
   * Set the final parsed input value (overrides buffer-derived state).
   *
   * @param {object} params
   * @param {string} params.tool_id
   * @param {*}      params.input
   */
  onInput({ tool_id, input }) {
    const entry = this._map.get(tool_id);
    if (!entry) return;
    entry.input = input;
  }

  /**
   * Record a successful tool result and mark the entry done.
   *
   * @param {object} params
   * @param {string} params.tool_id
   * @param {*}      params.result
   */
  onResult({ tool_id, result }) {
    const entry = this._map.get(tool_id);
    if (!entry) return;
    entry.result = result;
    entry.status = 'done';
    entry.doneAt = this._nowMs();
  }

  /**
   * Record a tool error and mark the entry done.
   * Stub for forward-compat — not yet emitted by the RPC wire.
   *
   * @param {object} params
   * @param {string} params.tool_id
   * @param {*}      params.error
   */
  onError({ tool_id, error }) {
    const entry = this._map.get(tool_id);
    if (!entry) return;
    entry.error = error;
    entry.status = 'done';
    entry.doneAt = this._nowMs();
  }

  /**
   * @param {string} tool_id
   * @returns {TrackedTool|undefined}
   */
  get(tool_id) {
    return this._map.get(tool_id);
  }

  /**
   * @returns {TrackedTool[]} All entries in insertion order.
   */
  list() {
    return Array.from(this._map.values());
  }

  /**
   * Remove an entry after the streaming-proxy has rendered the final state.
   *
   * @param {string} tool_id
   */
  reset(tool_id) {
    this._map.delete(tool_id);
  }
}
