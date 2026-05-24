/**
 * @file discord-tool-progress-renderer.js
 * @module bridge/sources/discord/discord-tool-progress-renderer
 *
 * Concrete ToolProgressRenderer for Discord.
 *
 * Produces an array of Discord Embed objects (plain JS — not discord.js
 * classes) representing the lifecycle of a tool call.
 *
 * Color scheme:
 *   in-progress  → 0x808080 (grey)
 *   success      → 0x2ecc71 (green)
 *   failure      → 0xe74c3c (red)
 */

import { ToolProgressRenderer } from '../../core/abstractions/tool-progress-renderer.js';

const MAX_FIELD_CHARS = 200;

function truncate(s, max) {
  if (s == null) return s;
  const str = String(s);
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function safeStringify(v) {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export class DiscordToolProgressRenderer extends ToolProgressRenderer {
  constructor() {
    super();
  }

  /**
   * Render a tool-call lifecycle event as a Discord embed array.
   *
   * @param {object}  args
   * @param {string}  args.toolName
   * @param {string}  args.toolId
   * @param {*}       args.input
   * @param {*}      [args.result]
   * @param {*}      [args.error]
   * @returns {Array<object>} Array containing a single Discord embed object.
   */
  render({ toolName, toolId, input, result, error }) {
    const inputStr = safeStringify(input);
    const resultStr = result !== undefined ? safeStringify(result) : undefined;
    const errorStr  = error != null
      ? (error instanceof Error ? error.message : String(error))
      : undefined;

    const fields = [
      {
        name: 'Input',
        value: inputStr !== undefined
          ? '```json\n' + truncate(inputStr, MAX_FIELD_CHARS) + '\n```'
          : undefined,
        inline: false,
      },
      {
        name: 'Result',
        value: resultStr !== undefined ? truncate(resultStr, MAX_FIELD_CHARS) : undefined,
        inline: false,
      },
      {
        name: 'Error',
        value: errorStr !== undefined ? truncate(errorStr, MAX_FIELD_CHARS) : undefined,
        inline: false,
      },
    ].filter(f => f.value !== undefined);

    const color = error != null
      ? 0xe74c3c
      : result !== undefined
        ? 0x2ecc71
        : 0x808080;

    return [{
      title:       `🔧 ${toolName}`,
      description: `\`${toolId}\``,
      fields,
      color,
    }];
  }
}
