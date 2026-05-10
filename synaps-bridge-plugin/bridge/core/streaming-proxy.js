/**
 * @file streaming-proxy.js
 * @module bridge/core/streaming-proxy
 *
 * Text-debounce + dispatch engine.  Subscribes to a SynapsRpc-compatible
 * EventEmitter, debounces text deltas, force-flushes before non-text events,
 * and dispatches everything through the injected StreamHandle and renderers.
 *
 * Source-agnostic: no Slack/Discord imports anywhere in this file.
 */

import { EventEmitter } from 'node:events';
import { SubagentTracker } from './subagent-tracker.js';
import { ToolProgress } from './tool-progress.js';

// ─── tunables ────────────────────────────────────────────────────────────────

/** Flush text buffer immediately once it reaches this many chars. */
export const FLUSH_CHARS = 80;

/** Schedule a flush this many ms after the last text delta. */
export const FLUSH_INTERVAL_MS = 250;

// ─── StreamingProxy ──────────────────────────────────────────────────────────

export class StreamingProxy extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('node:events').EventEmitter} opts.rpc
   *   EventEmitter with the SynapsRpc event surface.
   * @param {import('./abstractions/stream-handle.js').StreamHandle} opts.streamHandle
   *   StreamHandle instance (concrete subclass).
   * @param {object} opts.capabilities
   *   AdapterCapabilities — read from the concrete adapter.
   * @param {import('./abstractions/tool-progress-renderer.js').ToolProgressRenderer} opts.toolProgressRenderer
   * @param {import('./abstractions/subagent-renderer.js').SubagentRenderer} opts.subagentRenderer
   * @param {SubagentTracker} [opts.subagentTracker]
   * @param {ToolProgress}    [opts.toolProgress]
   * @param {number}  [opts.flushChars=FLUSH_CHARS]
   * @param {number}  [opts.flushIntervalMs=FLUSH_INTERVAL_MS]
   * @param {object}  [opts.logger=console]
   */
  constructor({
    rpc,
    streamHandle,
    capabilities,
    toolProgressRenderer,
    subagentRenderer,
    subagentTracker = new SubagentTracker(),
    toolProgress = new ToolProgress(),
    flushChars = FLUSH_CHARS,
    flushIntervalMs = FLUSH_INTERVAL_MS,
    logger = console,
  } = {}) {
    super();

    this._rpc = rpc;
    this._streamHandle = streamHandle;
    this._capabilities = capabilities;
    this._toolProgressRenderer = toolProgressRenderer;
    this._subagentRenderer = subagentRenderer;
    this._subagentTracker = subagentTracker;
    this._toolProgress = toolProgress;
    this._flushChars = flushChars;
    this._flushIntervalMs = flushIntervalMs;
    this._logger = logger;

    // ── text-debounce state ────────────────────────────────────────────────
    /** @type {string} */
    this._textBuffer = '';
    /** @type {NodeJS.Timeout|null} */
    this._flushTimer = null;
    /** @type {number} */
    this._lastDeltaAt = 0;

    // ── lifecycle guards ───────────────────────────────────────────────────
    this._started = false;
    this._stopped = false;

    // ── async dispatch serializer ─────────────────────────────────────────
    // All async rpc-event handlers are chained onto this promise so that
    // concurrent frames emitted in a single stdout chunk are processed in
    // strict order.  Without serialization, fire-and-forget async calls
    // race: e.g. _handleToolcallResult runs onResult() before _handleToolcallStart
    // has run onStart(), causing _toolProgress.get() to return undefined.
    /** @type {Promise<void>} */
    this._dispatchChain = Promise.resolve();

    // ── bound listeners (stored so we can remove them in stop()) ──────────
    this._onMessageUpdateBound = (event) => this._enqueue(() => this._onMessageUpdateAsync(event));
    this._onSubagentStartBound = (payload) => this._enqueue(() => this._onSubagentStart(payload));
    this._onSubagentUpdateBound = (payload) => this._enqueue(() => this._onSubagentUpdate(payload));
    this._onSubagentDoneBound = (payload) => this._enqueue(() => this._onSubagentDone(payload));
    this._onAgentEndBound = (payload) => this._enqueue(() => this._onAgentEnd(payload));
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Open the stream and subscribe to rpc events.  Resets internal state so
   * the proxy can be reused across turns if needed.
   *
   * @param {object} [opts]
   * @param {string} [opts.conversation]
   * @param {string} [opts.thread]
   * @param {string} [opts.recipient]
   * @returns {Promise<void>}
   */
  async start({ conversation, thread, recipient } = {}) {
    this._textBuffer = '';
    this._lastDeltaAt = 0;
    this._stopped = false;
    this._started = true;

    this._rpc.on('message_update', this._onMessageUpdateBound);
    this._rpc.on('subagent_start', this._onSubagentStartBound);
    this._rpc.on('subagent_update', this._onSubagentUpdateBound);
    this._rpc.on('subagent_done', this._onSubagentDoneBound);
    this._rpc.on('agent_end', this._onAgentEndBound);

    await this._streamHandle.start({ conversation, thread, recipient });
  }

  /**
   * Force-flush any buffered text, close the stream, and unsubscribe.
   * Idempotent — calling a second time is a no-op.
   *
   * Waits for the _dispatchChain to drain so that any in-flight async handlers
   * (e.g. _handleToolcallResult) have a chance to complete before stopStream is
   * called.
   *
   * @param {object} [opts]
   * @param {*}      [opts.blocks] - Optional trailing blocks for streamHandle.stop.
   * @returns {Promise<void>}
   */
  async stop({ blocks } = {}) {
    if (this._stopped) return;
    this._stopped = true;

    this._unsubscribe();

    // Drain any in-flight async handlers before flushing / closing the stream.
    // We chain stop's own work onto _dispatchChain so it runs after all pending
    // handlers complete — but we must not enqueue via _enqueue() (which checks
    // _stopped), so we do it directly.
    await this._dispatchChain.catch(() => {});

    await this._forceFlushText();
    await this._streamHandle.stop({ blocks });
  }

  // ── query helpers (for session-router done-checks) ────────────────────────

  /** @returns {number} Current text buffer length in characters. */
  getBufferedTextChars() {
    return this._textBuffer.length;
  }

  /**
   * @returns {number} Milliseconds since the last text_delta, or 0 if none
   *   has been received.
   */
  getMsSinceLastDelta() {
    if (this._lastDeltaAt === 0) return 0;
    return Date.now() - this._lastDeltaAt;
  }

  /** @returns {number} Count of subagents with status 'running' or 'pending'. */
  getPendingSubagentCount() {
    return this._subagentTracker.pendingCount();
  }

  // ── internal: event routing ───────────────────────────────────────────────

  /**
   * Enqueue an async task onto the serial dispatch chain. Tasks run strictly
   * in the order they were enqueued. Errors are caught and logged so one bad
   * handler can never break the chain. Returns the promise for the wrapped
   * task so callers (esp. `stop()`) can await drain.
   *
   * No-ops once the proxy is stopped.
   *
   * @param {() => Promise<void>} task
   * @returns {Promise<void>}
   */
  _enqueue(task) {
    if (this._stopped) return this._dispatchChain;
    const next = this._dispatchChain.then(() => task()).catch((err) => {
      this._logger.warn(`StreamingProxy: dispatch task threw: ${err && err.message ? err.message : err}`);
    });
    this._dispatchChain = next;
    return next;
  }

  /**
   * Resolve once all currently-enqueued async handlers have completed.
   * Tests use this to deterministically drain the serial dispatch chain
   * after synchronously emitting frames via `rpc.emit(...)`.
   *
   * @returns {Promise<void>}
   */
  awaitIdle() {
    return this._dispatchChain;
  }

  /**
   * Dispatch a message_update event by its type. Awaits every per-frame
   * handler so the serial dispatch chain (`_dispatchChain`) preserves
   * happens-before order across frames emitted in a single stdout chunk.
   *
   * @param {object} event - Inner message_update event (already unwrapped by SynapsRpc).
   * @returns {Promise<void>}
   */
  async _onMessageUpdateAsync(event) {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'text_delta':
        this._bufferText(event.delta ?? '');
        break;

      case 'thinking_delta':
        // Thinking deltas are not surfaced to the user stream — silently drop.
        break;

      case 'toolcall_start':
        await this._handleToolcallStart(event);
        break;

      case 'toolcall_input_delta':
        this._handleToolcallInputDelta(event);
        break;

      case 'toolcall_input':
        await this._handleToolcallInput(event);
        break;

      case 'toolcall_result':
        await this._handleToolcallResult(event);
        break;

      default:
        this._logger.warn(`StreamingProxy: unknown message_update type '${event.type}'`);
    }
  }

  // ── internal: text debounce ───────────────────────────────────────────────

  /**
   * Append `delta` to the text buffer, then either flush immediately (if the
   * buffer has grown >= flushChars) or schedule a deferred flush.
   *
   * @param {string} delta
   */
  _bufferText(delta) {
    this._textBuffer += delta;
    this._lastDeltaAt = Date.now();

    if (this._textBuffer.length >= this._flushChars) {
      // Length threshold reached — cancel any pending timer and flush now.
      this._cancelFlushTimer();
      // Fire-and-forget; errors are caught inside _forceFlushText.
      this._forceFlushText().catch((err) =>
        this._logger.warn('StreamingProxy: flush error', err)
      );
    } else {
      this._scheduleFlush();
    }
  }

  /**
   * Schedule a deferred flush (replaces any existing timer).
   */
  _scheduleFlush() {
    this._cancelFlushTimer();
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._forceFlushText().catch((err) =>
        this._logger.warn('StreamingProxy: scheduled flush error', err)
      );
    }, this._flushIntervalMs);
  }

  /** Cancel any pending flush timer. */
  _cancelFlushTimer() {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
  }

  /**
   * Flush the text buffer to the streamHandle as a markdown_text chunk.
   * No-op if the buffer is empty.
   *
   * @returns {Promise<void>}
   */
  async _forceFlushText() {
    this._cancelFlushTimer();
    if (this._textBuffer.length === 0) return;

    const content = this._textBuffer;
    this._textBuffer = '';

    await this._streamHandle.append({ type: 'markdown_text', content });
  }

  // ── internal: tool-call lifecycle ─────────────────────────────────────────

  /**
   * @param {object} event
   * @param {string} event.tool_id
   * @param {string} event.tool_name
   */
  async _handleToolcallStart(event) {
    await this._forceFlushText();

    this._toolProgress.onStart({
      tool_id: event.tool_id,
      tool_name: event.tool_name,
    });

    const tool = this._toolProgress.get(event.tool_id);
    await this._dispatchToolState(tool);
  }

  /**
   * @param {object} event
   * @param {string} event.tool_id
   * @param {string} event.delta
   */
  _handleToolcallInputDelta(event) {
    this._toolProgress.onInputDelta({
      tool_id: event.tool_id,
      delta: event.delta ?? '',
    });
    // No visual update — accumulated silently until toolcall_input fires.
  }

  /**
   * @param {object} event
   * @param {string} event.tool_id
   * @param {*}      event.input
   */
  async _handleToolcallInput(event) {
    this._toolProgress.onInput({
      tool_id: event.tool_id,
      input: event.input,
    });
    // Visual update with finalised input (but no result yet).
    const tool = this._toolProgress.get(event.tool_id);
    if (tool) await this._dispatchToolState(tool);
  }

  /**
   * @param {object} event
   * @param {string} event.tool_id
   * @param {*}      event.result
   */
  async _handleToolcallResult(event) {
    await this._forceFlushText();

    this._toolProgress.onResult({
      tool_id: event.tool_id,
      result: event.result,
    });

    const tool = this._toolProgress.get(event.tool_id);
    if (tool) {
      await this._dispatchToolState(tool);
      this._toolProgress.reset(event.tool_id);
    }
  }

  /**
   * Dispatch a tool state update through the appropriate capability tier.
   *
   * @param {import('./tool-progress.js').TrackedTool} tool
   */
  async _dispatchToolState(tool) {
    const { richStreamChunks, auxBlocks } = this._capabilities;

    if (richStreamChunks) {
      // Rich stream: emit a task_update chunk into the active stream.
      await this._streamHandle.append({
        type: 'task_update',
        task: {
          id: tool.toolId,
          title: tool.toolName,
          status: tool.status === 'done' ? 'complete' : 'in_progress',
          input: tool.input,
          result: tool.result,
          error: tool.error,
        },
      });
    } else if (auxBlocks) {
      // Aux block: render via toolProgressRenderer and emit 'aux' event.
      const rendered = this._toolProgressRenderer.render({
        toolName: tool.toolName,
        toolId: tool.toolId,
        input: tool.input,
        result: tool.result,
        error: tool.error,
      });
      this.emit('aux', { kind: 'tool', payload: rendered });
    } else {
      // Inline text fallback. Append to buffer and schedule flush.
      const statusLabel = tool.status === 'done' ? 'done' : 'running';
      const inline = `\n_[tool: ${tool.toolName} — ${statusLabel}]_\n`;
      this._textBuffer += inline;
      this._scheduleFlush();
    }
  }

  // ── internal: subagent lifecycle ──────────────────────────────────────────

  /**
   * @param {object} payload
   * @param {string} payload.subagent_id
   * @param {string} payload.agent_name
   * @param {string} [payload.task_preview]
   */
  async _onSubagentStart(payload) {
    await this._forceFlushText();

    this._subagentTracker.onStart(payload);
    const entry = this._subagentTracker.get(payload.subagent_id);
    await this._dispatchSubagentState(entry);
  }

  /**
   * @param {object} payload
   * @param {string} payload.subagent_id
   * @param {string} payload.agent_name
   * @param {string} payload.status
   */
  async _onSubagentUpdate(payload) {
    this._subagentTracker.onUpdate(payload);
    const entry = this._subagentTracker.get(payload.subagent_id);
    if (entry) await this._dispatchSubagentState(entry);
  }

  /**
   * @param {object} payload
   * @param {string} payload.subagent_id
   * @param {string} payload.agent_name
   * @param {string} [payload.result_preview]
   * @param {number} [payload.duration_secs]
   */
  async _onSubagentDone(payload) {
    await this._forceFlushText();

    this._subagentTracker.onDone(payload);
    const entry = this._subagentTracker.get(payload.subagent_id);
    if (entry) await this._dispatchSubagentState(entry);
  }

  /**
   * @param {object} payload
   * @param {object} [payload.usage]
   */
  async _onAgentEnd(payload) {
    await this._forceFlushText();
    this.emit('agent_end', payload);
  }

  /**
   * Dispatch a subagent state snapshot through the appropriate capability tier.
   *
   * @param {import('./subagent-tracker.js').TrackedSubagent} entry
   */
  async _dispatchSubagentState(entry) {
    const { richStreamChunks, auxBlocks } = this._capabilities;

    /** @type {import('./abstractions/subagent-renderer.js').SubagentState} */
    const state = {
      id: entry.id,
      agent_name: entry.agent_name,
      status: entry.status,
      task_preview: entry.task_preview,
      result_preview: entry.result_preview,
      duration_secs: entry.duration_secs,
    };

    if (richStreamChunks) {
      // Rich stream: task_update chunk.
      await this._streamHandle.append({ type: 'task_update', task: state });
    } else if (auxBlocks) {
      // Aux block: render via subagentRenderer and emit 'aux' event.
      const rendered = this._subagentRenderer.render(state);
      this.emit('aux', { kind: 'subagent', payload: rendered });
    } else {
      // Inline text fallback — italicised. Append to buffer and schedule flush.
      const label = `_[subagent: ${entry.agent_name} — ${entry.status}]_`;
      this._textBuffer += `\n${label}\n`;
      this._scheduleFlush();
    }
  }

  // ── internal: helpers ─────────────────────────────────────────────────────

  /** Remove all rpc event listeners added in start(). */
  _unsubscribe() {
    this._rpc.off('message_update', this._onMessageUpdateBound);
    this._rpc.off('subagent_start', this._onSubagentStartBound);
    this._rpc.off('subagent_update', this._onSubagentUpdateBound);
    this._rpc.off('subagent_done', this._onSubagentDoneBound);
    this._rpc.off('agent_end', this._onAgentEndBound);
  }
}
