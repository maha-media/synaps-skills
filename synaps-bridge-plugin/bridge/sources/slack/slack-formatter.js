/**
 * @file slack-formatter.js
 * @module bridge/sources/slack/slack-formatter
 *
 * Concrete Formatter for Slack's mrkdwn dialect.
 *
 * Converts standard markdown to Slack mrkdwn:
 *   **bold**      → *bold*
 *   *italic*      → _italic_      (single-asterisk italic only)
 *   ~~strike~~    → ~strike~
 *   # Heading     → *Heading*     (all levels)
 *   [text](url)   → <url|text>
 *   ```fences```  → preserved     (Slack supports them)
 *   `inline`      → preserved
 *
 * formatError  → ":warning: <message>" string
 * formatSubagent → Block Kit block array suitable for auxBlocks path
 */

import { Formatter } from '../../core/abstractions/formatter.js';

// ─── status icons ─────────────────────────────────────────────────────────────

const STATUS_ICON = {
  pending: ':hourglass_flowing_sand:',
  running: ':gear:',
  done:    ':white_check_mark:',
  failed:  ':x:',
};

// ─── SlackFormatter ───────────────────────────────────────────────────────────

export class SlackFormatter extends Formatter {
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
   * Convert a standard markdown string into Slack mrkdwn.
   *
   * The conversion is intentionally simple — a best-effort mapping sufficient
   * for the LLM output this bridge surfaces.  It does NOT aim to be a complete
   * markdown parser.
   *
   * Strategy:
   *  1. Extract code fences and inline code into a placeholder map so their
   *     contents are never transformed by subsequent passes.
   *  2. Apply ordered regex replacements for each markdown construct.
   *  3. Re-inject the preserved code segments.
   *
   * @param {string} md - Markdown-formatted string.
   * @returns {string}  Slack mrkdwn string.
   */
  formatMarkdown(md) {
    if (typeof md !== 'string') return String(md ?? '');

    // ── step 1: extract code fences + inline code ─────────────────────────
    const placeholders = [];

    // Code fences (```...```)
    let text = md.replace(/```[\s\S]*?```/g, (match) => {
      const idx = placeholders.length;
      placeholders.push(match);
      return `\x00CODE${idx}\x00`;
    });

    // Inline code (`...`)
    text = text.replace(/`[^`]+`/g, (match) => {
      const idx = placeholders.length;
      placeholders.push(match);
      return `\x00CODE${idx}\x00`;
    });

    // ── step 2: apply conversions ─────────────────────────────────────────

    // Links: [text](url) → <url|text>
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

    // Strikethrough: ~~text~~ → ~text~
    text = text.replace(/~~(.+?)~~/g, '~$1~');

    // Italic: *text* → _text_   (single asterisk — not double)
    // We match a single * that is NOT immediately preceded or followed by
    // another *, so double-asterisk bold sequences are skipped here.
    text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_');

    // Bold: **text** → *text*
    // After the italic pass, **bold** still contains doubled asterisks.
    text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');

    // Headers: # Title → *Title*  (any number of leading #)
    // Applied AFTER bold so the resulting *Title* isn't re-processed.
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

    // ── step 3: re-inject preserved code segments ─────────────────────────
    text = text.replace(/\x00CODE(\d+)\x00/g, (_, i) => placeholders[Number(i)]);

    return text;
  }

  // ── formatError ────────────────────────────────────────────────────────────

  /**
   * Format an error for display in Slack.
   *
   * @param {Error|*} err
   * @returns {string} `:warning: <message>`
   */
  formatError(err) {
    const msg = (err instanceof Error ? err.message : String(err ?? 'unknown error'));
    return `:warning: ${msg}`;
  }

  // ── formatSubagent ─────────────────────────────────────────────────────────

  /**
   * Format a subagent lifecycle state as a Block Kit block array.
   *
   * Used in the auxBlocks path (legacy mode) where subagent state is posted as
   * a separate out-of-band message alongside the main stream.
   *
   * @param {import('../../core/abstractions/formatter.js').SubagentState} state
   * @returns {Array<object>} Block Kit blocks.
   */
  formatSubagent(state) {
    const icon = STATUS_ICON[state.status] ?? ':question:';
    const nameText = `${icon} *Subagent: ${state.agent_name}*\n_${state.status}_`;

    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: nameText },
      },
    ];

    if (state.task_preview) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `task: ${state.task_preview}` }],
      });
    }

    if (state.result_preview) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `result: ${state.result_preview}` }],
      });
    }

    if (state.duration_secs != null) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `duration: ${state.duration_secs}s` }],
      });
    }

    return blocks;
  }
}
