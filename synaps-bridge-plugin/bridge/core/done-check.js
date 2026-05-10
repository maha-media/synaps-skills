// bridge/core/done-check.js
//
// Source-agnostic turn-completion detection based on session-state signals.
// No Slack types, no clients, no I/O.

/**
 * @typedef {Object} TurnState
 * @property {boolean} streamingActive    - A synaps-rpc prompt is in flight.
 * @property {boolean} agentEndSeen       - agent_end event was received.
 * @property {number}  pendingSubagents   - Count of subagents in 'running' state.
 * @property {number}  bufferedTextChars  - Chars buffered in streaming-proxy.
 * @property {number}  msSinceLastDelta   - Ms since last text_delta.
 */

/**
 * @typedef {Object} DoneResult
 * @property {boolean} done
 * @property {string}  reason
 */

/**
 * Decide whether the assistant's turn is complete based on session-state
 * signals only.
 *
 * Decision tree:
 *  1. streamingActive → not done ("in_progress")
 *  2. agentEndSeen + pendingSubagents > 0 → not done ("awaiting_subagents")
 *  3. agentEndSeen + bufferedTextChars > 0 → not done ("awaiting_flush")
 *  4. agentEndSeen + 0 subagents + 0 buffered → done ("complete")
 *  5. otherwise → not done ("in_progress")
 *
 * @param {TurnState} state
 * @returns {DoneResult}
 */
export function isTurnDone(state) {
  const { streamingActive, agentEndSeen, pendingSubagents, bufferedTextChars } =
    state;

  // 1. Prompt still in flight — nothing can be done yet.
  if (streamingActive) {
    return { done: false, reason: "in_progress" };
  }

  // 2–4 only apply once agent_end has been received.
  if (agentEndSeen) {
    if (pendingSubagents > 0) {
      return { done: false, reason: "awaiting_subagents" };
    }
    if (bufferedTextChars > 0) {
      return { done: false, reason: "awaiting_flush" };
    }
    // All clear — turn is complete.
    return { done: true, reason: "complete" };
  }

  // 5. Neither streaming nor agent_end yet (e.g. pre-prompt, idle).
  return { done: false, reason: "in_progress" };
}

/** Default poll interval (ms) used by callers. */
export const DONE_CHECK_POLL_MS = 100;

/**
 * Poll `getState()` at `intervalMs` until `isTurnDone` returns `done: true`,
 * or until `timeoutMs` has elapsed.
 *
 * @param {() => TurnState} getState
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 * @returns {Promise<{ done: boolean, reason: string, timedOut: boolean }>}
 */
export async function waitForDone(
  getState,
  { timeoutMs = 120_000, intervalMs = DONE_CHECK_POLL_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const result = isTurnDone(getState());
    if (result.done) {
      return { done: true, reason: result.reason, timedOut: false };
    }

    if (Date.now() >= deadline) {
      const lastResult = isTurnDone(getState());
      return { done: lastResult.done, reason: lastResult.reason, timedOut: true };
    }

    await _sleep(intervalMs);
  }
}

/**
 * Internal sleep — isolated so tests can intercept via fake timers.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
