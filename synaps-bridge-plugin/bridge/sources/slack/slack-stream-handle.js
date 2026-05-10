/**
 * @file slack-stream-handle.js
 * @module bridge/sources/slack/slack-stream-handle
 *
 * Concrete StreamHandle for Slack.
 *
 * Primary path (useNativeStreaming=true):
 *   chat.startStream  → chat.appendStream (typed chunks) → chat.stopStream
 *
 * Fallback path (useNativeStreaming=false):
 *   chat.postMessage (placeholder) → chat.update (repeated edits) → chat.update (final)
 *
 * Core (streaming-proxy) drives this via the abstract StreamHandle interface and
 * never imports this file directly.
 */

import { StreamHandle } from '../../core/abstractions/stream-handle.js';

// ─── SlackStreamHandle ────────────────────────────────────────────────────────

export class SlackStreamHandle extends StreamHandle {
  /**
   * Chunk types that this handle can forward to the Slack API.
   * Unknown types are logged and silently dropped.
   */
  static SUPPORTED_CHUNK_TYPES = ['markdown_text', 'task_update', 'plan_update', 'blocks'];

  /**
   * @param {object}  opts
   * @param {object}  opts.client                   - Slack WebClient (or mock) with
   *                                                   `chat.startStream / appendStream / stopStream`
   *                                                   and `chat.postMessage / update` on it.
   * @param {string}  opts.channel                  - Slack channel id (C-prefixed).
   * @param {string}  [opts.thread_ts]              - Parent thread timestamp (optional).
   * @param {object}  opts.formatter                - SlackFormatter instance.
   * @param {boolean} [opts.useNativeStreaming=true] - true → chat.startStream path;
   *                                                   false → chat.postMessage + chat.update.
   * @param {object}  [opts.logger=console]         - Injected logger.
   */
  constructor({
    client,
    channel,
    thread_ts = null,
    formatter,
    useNativeStreaming = true,
    logger = console,
  } = {}) {
    super();

    /** @type {object} */
    this._client = client;

    /** @type {string} */
    this._channel = channel;

    /** @type {string|null} */
    this._thread_ts = thread_ts;

    /** @type {object} */
    this._formatter = formatter;

    /** @type {boolean} */
    this._useNativeStreaming = useNativeStreaming;

    /** @type {object} */
    this._logger = logger;

    // ── native path state ─────────────────────────────────────────────────
    /** @type {string|null} stream_id returned by chat.startStream */
    this._streamId = null;

    // ── fallback path state ───────────────────────────────────────────────
    /** @type {string|null} ts of the placeholder postMessage */
    this._ts = null;

    /** @type {string} accumulated text for the fallback path */
    this._textBuffer = '';

    /** @type {Array<object>} blocks queued in fallback mode, flushed in stop() */
    this._pendingBlocks = [];

    // ── lifecycle guard ───────────────────────────────────────────────────
    /** @type {boolean} */
    this._stopped = false;
  }

  // ── start ─────────────────────────────────────────────────────────────────

  /**
   * Open the stream.
   *
   * Native:   calls `chat.startStream`; stores `stream_id`.
   * Fallback: calls `chat.postMessage` with a single space; stores `ts`.
   *
   * Unlike `append` / `stop`, errors from `start` ARE propagated — the caller
   * needs to know if the stream could not be opened.
   *
   * @param {object} [opts]
   * @param {string} [opts.recipient]    - Optional recipient_user_id for AI-app mode.
   * @returns {Promise<void>}
   * @throws {Error} If the underlying Slack API call fails.
   */
  async start({ recipient } = {}) {
    if (this._useNativeStreaming) {
      const params = {
        channel: this._channel,
        ...(this._thread_ts ? { thread_ts: this._thread_ts } : {}),
        ...(recipient       ? { recipient_user_id: recipient } : {}),
      };

      const res = await this._client.chat.startStream(params);

      if (!res.ok) {
        throw new Error(`chat.startStream failed: ${res.error ?? 'unknown'}`);
      }

      this._streamId = res.stream_id;
    } else {
      const params = {
        channel: this._channel,
        text: ' ',
        ...(this._thread_ts ? { thread_ts: this._thread_ts } : {}),
      };

      const res = await this._client.chat.postMessage(params);

      if (!res.ok) {
        throw new Error(`chat.postMessage failed: ${res.error ?? 'unknown'}`);
      }

      this._ts = res.ts;
    }
  }

  // ── append ────────────────────────────────────────────────────────────────

  /**
   * Append a typed chunk to the in-progress stream.
   *
   * Native path: every supported chunk type is forwarded to `chat.appendStream`
   *   wrapped in the Slack chunk envelope `{ stream_id, chunk: { type, ... } }`.
   *
   * Fallback path: only `markdown_text` is supported inline — text is accumulated
   *   in `_textBuffer` and `chat.update` is called.  `blocks` chunks are queued
   *   and sent in `stop()`.  Other chunk types are silently dropped with a warning.
   *
   * Errors from the Slack API are caught and logged via `logger.warn`; they are
   * never re-thrown so the streaming loop stays alive.
   *
   * @param {import('../../core/abstractions/stream-handle.js').StreamChunk} chunk
   * @returns {Promise<void>}
   */
  async append(chunk) {
    if (!chunk || !chunk.type) {
      this._logger.warn('SlackStreamHandle.append: received chunk with no type', chunk);
      return;
    }

    if (!SlackStreamHandle.SUPPORTED_CHUNK_TYPES.includes(chunk.type)) {
      this._logger.warn(`SlackStreamHandle.append: unknown chunk type '${chunk.type}' — dropped`);
      return;
    }

    if (this._useNativeStreaming) {
      await this._nativeAppend(chunk);
    } else {
      await this._fallbackAppend(chunk);
    }
  }

  // ── stop ──────────────────────────────────────────────────────────────────

  /**
   * Close the stream.  Idempotent — a second call is a no-op.
   *
   * Native:   calls `chat.stopStream` with optional trailing `blocks`.
   * Fallback: sends a final `chat.update` with accumulated text + queued blocks.
   *
   * @param {object} [opts]
   * @param {*}      [opts.blocks] - Optional trailing Block Kit array (footer).
   * @returns {Promise<void>}
   */
  async stop({ blocks } = {}) {
    if (this._stopped) return;
    this._stopped = true;

    if (this._useNativeStreaming) {
      await this._nativeStop({ blocks });
    } else {
      await this._fallbackStop({ blocks });
    }
  }

  // ── private: native path ──────────────────────────────────────────────────

  /**
   * @private
   * @param {import('../../core/abstractions/stream-handle.js').StreamChunk} chunk
   */
  async _nativeAppend(chunk) {
    let slackChunk;

    switch (chunk.type) {
      case 'markdown_text': {
        const mrkdwn = this._formatter.formatMarkdown(chunk.content ?? '');
        slackChunk = { type: 'markdown_text', markdown_text: mrkdwn };
        break;
      }
      case 'task_update':
        slackChunk = { type: 'task_update', task_update: chunk.task };
        break;
      case 'plan_update':
        slackChunk = { type: 'plan_update', plan_update: chunk.plan };
        break;
      case 'blocks':
        slackChunk = { type: 'blocks', blocks: chunk.blocks };
        break;
      default:
        // Should be unreachable after the SUPPORTED_CHUNK_TYPES guard in append().
        this._logger.warn(`SlackStreamHandle._nativeAppend: unhandled type '${chunk.type}'`);
        return;
    }

    try {
      await this._client.chat.appendStream({
        stream_id: this._streamId,
        chunk: slackChunk,
      });
    } catch (err) {
      this._logger.warn('SlackStreamHandle: chat.appendStream error', err);
    }
  }

  /**
   * @private
   * @param {object} [opts]
   * @param {*}      [opts.blocks]
   */
  async _nativeStop({ blocks } = {}) {
    try {
      await this._client.chat.stopStream({
        stream_id: this._streamId,
        ...(blocks != null ? { blocks } : {}),
      });
    } catch (err) {
      this._logger.warn('SlackStreamHandle: chat.stopStream error', err);
    }
  }

  // ── private: fallback path ────────────────────────────────────────────────

  /**
   * @private
   * @param {import('../../core/abstractions/stream-handle.js').StreamChunk} chunk
   */
  async _fallbackAppend(chunk) {
    if (chunk.type === 'markdown_text') {
      this._textBuffer += chunk.content ?? '';

      try {
        await this._client.chat.update({
          channel: this._channel,
          ts: this._ts,
          text: this._textBuffer,
        });
      } catch (err) {
        this._logger.warn('SlackStreamHandle: chat.update error (append)', err);
      }
    } else if (chunk.type === 'blocks') {
      // Blocks are queued and emitted at stop() time.
      const b = chunk.blocks;
      if (Array.isArray(b)) {
        this._pendingBlocks.push(...b);
      }
    } else {
      // task_update / plan_update — not renderable in legacy mode.
      this._logger.warn(
        `SlackStreamHandle (fallback): chunk type '${chunk.type}' not renderable in legacy mode — dropped`
      );
    }
  }

  /**
   * @private
   * @param {object} [opts]
   * @param {*}      [opts.blocks]
   */
  async _fallbackStop({ blocks } = {}) {
    // Merge caller-supplied trailing blocks with any queued blocks.
    const allBlocks = [
      ...this._pendingBlocks,
      ...(Array.isArray(blocks) ? blocks : blocks != null ? [blocks] : []),
    ];

    try {
      await this._client.chat.update({
        channel: this._channel,
        ts: this._ts,
        text: this._textBuffer || ' ',
        ...(allBlocks.length > 0 ? { blocks: allBlocks } : {}),
      });
    } catch (err) {
      this._logger.warn('SlackStreamHandle: chat.update error (stop)', err);
    }
  }
}
