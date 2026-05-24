/**
 * @file discord-formatter.js
 * @module bridge/sources/discord/discord-formatter
 *
 * Concrete Formatter for Discord's markdown dialect.
 *
 * Discord supports a subset of standard markdown natively (bold, italic,
 * code fences, inline code, strikethrough) — so formatMarkdown is near-
 * identity; we only escape dangerous @mention broadcasts.
 *
 * formatError  → "⚠️ <message>" string
 * formatSubagent → array of Discord Embed plain objects
 */

import { Formatter } from '../../core/abstractions/formatter.js';

// ─── status icons + colors ────────────────────────────────────────────────────

const STATUS_ICON = {
  pending: '⏳',
  running: '⚙️',
  done:    '✅',
  failed:  '❌',
};

// Discord embed colors as integers (0xRRGGBB).
const STATUS_COLOR = {
  pending: 0x95a5a6,  // grey
  running: 0x3498db,  // blue
  done:    0x2ecc71,  // green
  failed:  0xe74c3c,  // red
};

// ─── DiscordFormatter ─────────────────────────────────────────────────────────

export class DiscordFormatter extends Formatter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.logger=console] - Injected logger.
   */
  constructor({ logger = console } = {}) {
    super();
    /** @type {object} */
    this.logger = logger;
  }

  // ── formatMarkdown ──────────────────────────────────────────────────────────

  /**
   * Near-identity transform for Discord markdown.
   *
   * Discord renders standard markdown natively, so the only transformation
   * needed is escaping @everyone and @here to prevent unintended mass pings.
   *
   * @param {string} md - Markdown-formatted string.
   * @returns {string}  Discord-safe markdown string.
   */
  formatMarkdown(md) {
    if (typeof md !== 'string') return String(md ?? '');
    return md
      .replace(/@everyone/g, '\\@everyone')
      .replace(/@here/g, '\\@here');
  }

  // ── formatError ────────────────────────────────────────────────────────────

  /**
   * Format an error for display in Discord.
   *
   * @param {Error|*} err
   * @returns {string} `⚠️ <message>`
   */
  formatError(err) {
    const msg = (err instanceof Error ? err.message : String(err ?? 'unknown error'));
    return `⚠️ ${msg}`;
  }

  // ── formatSubagent ─────────────────────────────────────────────────────────

  /**
   * Format a subagent lifecycle state as an array of Discord Embed objects.
   *
   * Returns plain objects (not discord.js EmbedBuilder instances) so this
   * formatter remains decoupled from the discord.js library.
   *
   * @param {import('../../core/abstractions/formatter.js').SubagentState} state
   * @returns {Array<object>} Discord embed objects.
   */
  formatSubagent(state) {
    const icon  = STATUS_ICON[state.status] ?? '❓';
    const color = STATUS_COLOR[state.status] ?? 0x95a5a6;

    const statusLine = state.status;

    const fields = [];

    if (state.task_preview) {
      fields.push({ name: 'Task', value: state.task_preview, inline: false });
    }

    if (state.result_preview) {
      fields.push({ name: 'Result', value: state.result_preview, inline: false });
    }

    if (state.duration_secs != null) {
      fields.push({ name: 'Duration', value: `${state.duration_secs}s`, inline: true });
    }

    return [
      {
        title:       `${icon} ${state.agent_name}`,
        description: statusLine,
        fields,
        color,
      },
    ];
  }
}
