/**
 * @file slack-subagent-renderer.js
 * @module bridge/sources/slack/slack-subagent-renderer
 *
 * Concrete SubagentRenderer for Slack.
 *
 * Produces a Block Kit block array for the auxBlocks capability tier (legacy
 * mode).  In AI-app mode the streaming-proxy emits task_update chunks directly
 * and does not call this renderer.
 *
 * Status icons:
 *   pending  → :hourglass_flowing_sand:
 *   running  → :gear:
 *   done     → :white_check_mark:
 *   failed   → :x:
 */

import { SubagentRenderer } from '../../core/abstractions/subagent-renderer.js';

const STATUS_ICON = {
  pending: ':hourglass_flowing_sand:',
  running: ':gear:',
  done:    ':white_check_mark:',
  failed:  ':x:',
};

export class SlackSubagentRenderer extends SubagentRenderer {
  constructor() {
    super();
  }

  /**
   * Render a subagent state snapshot as a Block Kit block array.
   *
   * @param {import('../../core/abstractions/subagent-renderer.js').SubagentState} state
   * @returns {Array<object>} Block Kit blocks.
   */
  render(state) {
    const icon = STATUS_ICON[state.status] ?? ':question:';

    const blocks = [];

    // ── header: icon + agent name + status ───────────────────────────────
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} *${state.agent_name}*\n_${state.status}_`,
      },
    });

    // ── divider ──────────────────────────────────────────────────────────
    blocks.push({ type: 'divider' });

    // ── context: task preview ─────────────────────────────────────────────
    if (state.task_preview) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_${state.task_preview}_` }],
      });
    }

    // ── context: result preview (done / failed) ────────────────────────────
    if (state.result_preview) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `result: ${state.result_preview}` }],
      });
    }

    // ── context: duration ─────────────────────────────────────────────────
    if (state.duration_secs != null) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `done in ${state.duration_secs}s` }],
      });
    }

    return blocks;
  }
}
