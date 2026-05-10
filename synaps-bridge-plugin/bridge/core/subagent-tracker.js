/**
 * @file subagent-tracker.js
 * @module bridge/core/subagent-tracker
 *
 * Pure state-machine for tracking subagent lifecycles within a single agent
 * turn. No I/O; no side effects beyond internal Map mutations.
 */

/**
 * @typedef {"pending"|"running"|"done"|"failed"} SubagentStatus
 */

/**
 * @typedef {Object} TrackedSubagent
 * @property {string}          id
 * @property {string}          agent_name
 * @property {SubagentStatus}  status
 * @property {string}          [task_preview]
 * @property {string}          [result_preview]
 * @property {number}          [duration_secs]
 * @property {number}          startedAt    - epoch ms
 * @property {number}          [updatedAt]
 * @property {number}          [doneAt]
 */

/**
 * Coerce a freeform status string from the wire protocol to our typed enum.
 *
 * @param {string|undefined} raw
 * @returns {SubagentStatus}
 */
function coerceStatus(raw) {
  if (raw === 'pending') return 'pending';
  if (raw === 'in_progress' || raw === 'running') return 'running';
  return 'running'; // safe default
}

export class SubagentTracker {
  /**
   * @param {object}   [opts]
   * @param {()=>number} [opts.nowMs] - Injectable clock (epoch ms). Defaults to Date.now.
   */
  constructor({ nowMs = () => Date.now() } = {}) {
    /** @type {()=>number} */
    this._nowMs = nowMs;

    /** @type {Map<string, TrackedSubagent>} insertion-ordered */
    this._map = new Map();
  }

  /**
   * Record a new subagent starting. Creates entry with status='running'.
   *
   * @param {object} params
   * @param {string} params.subagent_id
   * @param {string} params.agent_name
   * @param {string} [params.task_preview]
   */
  onStart({ subagent_id, agent_name, task_preview }) {
    /** @type {TrackedSubagent} */
    const entry = {
      id: subagent_id,
      agent_name,
      status: 'running',
      startedAt: this._nowMs(),
    };
    if (task_preview !== undefined) entry.task_preview = task_preview;
    this._map.set(subagent_id, entry);
  }

  /**
   * Update an existing subagent's status. Coerces freeform wire values.
   *
   * @param {object} params
   * @param {string} params.subagent_id
   * @param {string} params.agent_name
   * @param {string} params.status
   */
  onUpdate({ subagent_id, agent_name, status }) {
    const entry = this._map.get(subagent_id);
    if (!entry) {
      // Create on-the-fly if start was missed
      this._map.set(subagent_id, {
        id: subagent_id,
        agent_name,
        status: coerceStatus(status),
        startedAt: this._nowMs(),
        updatedAt: this._nowMs(),
      });
      return;
    }
    entry.agent_name = agent_name;
    entry.status = coerceStatus(status);
    entry.updatedAt = this._nowMs();
  }

  /**
   * Mark a subagent as done (or failed).
   *
   * Status is 'failed' if `duration_secs < 0` or `result_preview` matches
   * `/^error/i`. Otherwise 'done'.
   *
   * @param {object} params
   * @param {string} params.subagent_id
   * @param {string} params.agent_name
   * @param {string} [params.result_preview]
   * @param {number} [params.duration_secs]
   */
  onDone({ subagent_id, agent_name, result_preview, duration_secs }) {
    const now = this._nowMs();
    const entry = this._map.get(subagent_id) ?? {
      id: subagent_id,
      agent_name,
      startedAt: now,
    };

    const failed =
      (typeof duration_secs === 'number' && duration_secs < 0) ||
      (typeof result_preview === 'string' && /^error/i.test(result_preview));

    entry.status = failed ? 'failed' : 'done';
    entry.doneAt = now;
    entry.updatedAt = now;
    if (result_preview !== undefined) entry.result_preview = result_preview;
    if (duration_secs !== undefined) entry.duration_secs = duration_secs;

    this._map.set(subagent_id, entry);
  }

  /**
   * @param {string} subagent_id
   * @returns {TrackedSubagent|undefined}
   */
  get(subagent_id) {
    return this._map.get(subagent_id);
  }

  /**
   * @returns {TrackedSubagent[]} All entries in insertion order.
   */
  list() {
    return Array.from(this._map.values());
  }

  /**
   * Count of subagents that are still 'running' or 'pending'.
   * @returns {number}
   */
  pendingCount() {
    let count = 0;
    for (const entry of this._map.values()) {
      if (entry.status === 'running' || entry.status === 'pending') count++;
    }
    return count;
  }
}
