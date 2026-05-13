/**
 * @file discord-stream-handle.js
 * @module bridge/sources/discord/discord-stream-handle
 *
 * Concrete StreamHandle for Discord.
 *
 * Discord has no native streaming API, so we use the fallback pattern:
 *   channel.send("⏳") → message.edit() (debounced, repeated) → message.edit() (final stop)
 *
 * A typing indicator is maintained via channel.sendTyping() on an 8-second interval.
 */

import { StreamHandle } from '../../core/abstractions/stream-handle.js';

// ─── constants ────────────────────────────────────────────────────────────────

const TYPING_INTERVAL_MS = 8_000;
const EDIT_DEBOUNCE_MS   = 1_000;

// ─── DiscordStreamHandle ──────────────────────────────────────────────────────

export class DiscordStreamHandle extends StreamHandle {
  /**
   * @param {object}  opts
   * @param {object}  opts.channel   - Discord channel-like: `{ send(), sendTyping() }`.
   * @param {object}  opts.formatter - DiscordFormatter instance.
   * @param {object}  [opts.logger=console]
   */
  constructor({ channel, formatter, logger = console } = {}) {
    super();

    /** @type {object} */
    this._channel = channel;
    /** @type {object} */
    this._formatter = formatter;
    /** @type {object} */
    this._logger = logger;

    /** @type {object|null} The Discord message returned by channel.send() */
    this._message = null;

    /** @type {string} Accumulated markdown text */
    this._buffer = '';

    /** @type {Array<object>} Blocks queued for stop() */
    this._pendingBlocks = [];

    /** @type {ReturnType<typeof setInterval>|null} */
    this._typingInterval = null;

    /** @type {ReturnType<typeof setTimeout>|null} Debounce timer for message.edit() */
    this._debounceTimer = null;

    /** @type {boolean} */
    this._stopped = false;
  }

  // ── start ──────────────────────────────────────────────────────────────────

  /**
   * Post the placeholder message and start the typing indicator.
   *
   * Errors ARE propagated — the caller needs to know if we can't open the stream.
   *
   * @param {object} [opts]
   * @param {string} [opts.conversation]
   * @param {string} [opts.thread]
   * @param {string} [opts.recipient]
   * @returns {Promise<void>}
   */
  async start({ conversation, thread, recipient } = {}) { // eslint-disable-line no-unused-vars
    this._message = await this._channel.send('⏳');

    this._typingInterval = setInterval(() => {
      this._channel.sendTyping().catch((err) => {
        this._logger.warn('DiscordStreamHandle: sendTyping error', err);
      });
    }, TYPING_INTERVAL_MS);
  }

  // ── append ─────────────────────────────────────────────────────────────────

  /**
   * Append a typed chunk to the in-progress stream.
   *
   * - markdown_text → accumulate into buffer, debounce edit
   * - task_update / plan_update → log + drop
   * - blocks → queue for stop()
   * - Errors are swallowed and logged — never thrown.
   *
   * @param {import('../../core/abstractions/stream-handle.js').StreamChunk} chunk
   * @returns {Promise<void>}
   */
  async append(chunk) {
    if (this._stopped) return;

    if (!chunk || !chunk.type) {
      this._logger.warn('DiscordStreamHandle.append: chunk with no type', chunk);
      return;
    }

    try {
      switch (chunk.type) {
        case 'markdown_text': {
          this._buffer += chunk.content ?? '';
          this._scheduleFlush();
          break;
        }
        case 'task_update':
        case 'plan_update': {
          this._logger.warn(
            `DiscordStreamHandle.append: chunk type '${chunk.type}' not supported — dropped`,
          );
          break;
        }
        case 'blocks': {
          if (Array.isArray(chunk.blocks)) {
            this._pendingBlocks.push(...chunk.blocks);
          }
          break;
        }
        default: {
          this._logger.warn(
            `DiscordStreamHandle.append: unknown chunk type '${chunk.type}' — dropped`,
          );
        }
      }
    } catch (err) {
      this._logger.warn('DiscordStreamHandle.append: unexpected error', err);
    }
  }

  // ── stop ───────────────────────────────────────────────────────────────────

  /**
   * Close the stream. Idempotent — second call is a no-op.
   *
   * @param {object} [opts]
   * @param {*}      [opts.blocks] - Optional trailing blocks.
   * @returns {Promise<void>}
   */
  async stop({ blocks } = {}) {
    if (this._stopped) return;
    this._stopped = true;

    if (this._typingInterval !== null) {
      clearInterval(this._typingInterval);
      this._typingInterval = null;
    }

    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    if (Array.isArray(blocks)) {
      this._pendingBlocks.push(...blocks);
    } else if (blocks != null) {
      this._pendingBlocks.push(blocks);
    }

    await this._flush();
  }

  // ── private ────────────────────────────────────────────────────────────────

  /**
   * Schedule a debounced flush.
   * @private
   */
  _scheduleFlush() {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._flush().catch((err) => {
        this._logger.warn('DiscordStreamHandle: debounced flush error', err);
      });
    }, EDIT_DEBOUNCE_MS);
  }

  /**
   * Execute message.edit() with the current buffer content.
   * @private
   * @returns {Promise<void>}
   */
  async _flush() {
    if (!this._message) return;

    const content = this._formatter.formatMarkdown(this._buffer) || '⏳';

    try {
      await this._message.edit({ content });
    } catch (err) {
      this._logger.warn('DiscordStreamHandle: message.edit error', err);
    }
  }
}
