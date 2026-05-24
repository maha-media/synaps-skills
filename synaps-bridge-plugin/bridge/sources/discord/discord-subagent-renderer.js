/**
 * @file discord-subagent-renderer.js
 * @module bridge/sources/discord/discord-subagent-renderer
 *
 * Concrete SubagentRenderer for Discord.
 *
 * Produces an array of Discord Embed objects (plain JS — not discord.js
 * classes) suitable for inclusion in a message's `embeds` field.
 *
 * Status icons / colors:
 *   pending  → ⏳   0x808080
 *   running  → ⚙️   0x3498db
 *   done     → ✅   0x2ecc71
 *   failed   → ❌   0xe74c3c
 */

import { SubagentRenderer } from '../../core/abstractions/subagent-renderer.js';

const MAX_FIELD_CHARS = 200;

const STATUS_ICON = {
  pending: '⏳',
  running: '⚙️',
  done:    '✅',
  failed:  '❌',
};

const STATUS_COLOR = {
  pending: 0x808080,
  running: 0x3498db,
  done:    0x2ecc71,
  failed:  0xe74c3c,
};

function truncate(s, max) {
  if (s == null) return s;
  const str = String(s);
  return str.length > max ? str.slice(0, max) + '…' : str;
}

export class DiscordSubagentRenderer extends SubagentRenderer {
  constructor() {
    super();
  }

  /**
   * Render a subagent state snapshot as a Discord embed array.
   *
   * @param {import('../../core/abstractions/subagent-renderer.js').SubagentState} state
   * @returns {Array<object>} Array containing a single Discord embed object.
   */
  render(state) {
    const icon  = STATUS_ICON[state.status]  ?? '❔';
    const color = STATUS_COLOR[state.status] ?? 0x808080;

    const isTerminal = state.status === 'done' || state.status === 'failed';

    const fields = [
      { name: 'Task',     value: truncate(state.task_preview, MAX_FIELD_CHARS), inline: false },
      isTerminal
        ? { name: 'Result', value: truncate(state.result_preview, MAX_FIELD_CHARS), inline: false }
        : { name: 'Result', value: undefined, inline: false },
      isTerminal && state.duration_secs != null
        ? { name: 'Duration', value: `${state.duration_secs}s`, inline: true }
        : { name: 'Duration', value: undefined, inline: true },
    ].filter(f => f.value);

    return [{
      title:       `${icon} ${state.agent_name}`,
      description: state.status,
      fields,
      color,
    }];
  }
}
