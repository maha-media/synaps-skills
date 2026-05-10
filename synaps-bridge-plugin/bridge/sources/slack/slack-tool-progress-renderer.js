/**
 * @file slack-tool-progress-renderer.js
 * @module bridge/sources/slack/slack-tool-progress-renderer
 *
 * Concrete ToolProgressRenderer for Slack.
 *
 * Produces a Block Kit block array for the auxBlocks capability tier (legacy
 * mode).  In AI-app mode the streaming-proxy emits task_update chunks directly
 * and does not call this renderer.
 *
 * Layout:
 *   :wrench: *toolName*  (toolId)
 *   ``` <input JSON, truncated to 200 chars> ```
 *   ✅ result preview  OR  :x: error.message  (when present)
 */

import { ToolProgressRenderer } from '../../core/abstractions/tool-progress-renderer.js';

const INPUT_MAX_CHARS = 200;

export class SlackToolProgressRenderer extends ToolProgressRenderer {
  constructor() {
    super();
  }

  /**
   * Render a tool-call lifecycle event as a Block Kit block array.
   *
   * @param {object}  args
   * @param {string}  args.toolName
   * @param {string}  args.toolId
   * @param {*}       args.input
   * @param {*}      [args.result]
   * @param {*}      [args.error]
   * @returns {Array<object>} Block Kit blocks.
   */
  render({ toolName, toolId, input, result, error }) {
    const blocks = [];

    // ── header ────────────────────────────────────────────────────────────
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:wrench: *${toolName}* \`${toolId}\``,
      },
    });

    // ── input ─────────────────────────────────────────────────────────────
    if (input != null) {
      let inputStr;
      try {
        inputStr = typeof input === 'string' ? input : JSON.stringify(input);
      } catch {
        inputStr = String(input);
      }

      if (inputStr.length > INPUT_MAX_CHARS) {
        inputStr = inputStr.slice(0, INPUT_MAX_CHARS) + '…';
      }

      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `\`\`\`${inputStr}\`\`\`` }],
      });
    }

    // ── result / error ────────────────────────────────────────────────────
    if (error != null) {
      const errMsg = error instanceof Error ? error.message : String(error);
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `:x: ${errMsg}` }],
      });
    } else if (result != null) {
      let resultStr;
      try {
        resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      } catch {
        resultStr = String(result);
      }
      const preview = resultStr.trim().slice(0, INPUT_MAX_CHARS);
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `:white_check_mark: ${preview}` }],
      });
    }

    return blocks;
  }
}
