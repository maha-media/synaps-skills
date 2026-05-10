/**
 * @file bridge/core/web-stream-bridge.js
 * @module bridge/core/web-stream-bridge
 *
 * Pure-function module: translates SCP RPC chunk objects (emitted by
 * StreamingProxy / session layer) into Vercel AI SDK numbered data-stream
 * frame strings.
 *
 * ─── AI SDK numbered data-stream protocol ────────────────────────────────────
 *   0:"text"\n            ← text delta   (JSON-stringified string)
 *   2:[{...}]\n           ← data parts   (JSON-serialised array)
 *   8:[{...}]\n           ← annotations  (JSON-serialised array)
 *   3:"error message"\n   ← error        (JSON-stringified string)
 *   e:{"finishReason":"stop"}\n  ← step finish
 *   d:{"finishReason":"stop","usage":{...}}\n  ← done frame
 *
 * EVERY frame is `<prefix>:<json>\n` where the prefix is a single hex digit or
 * lowercase letter.  String payloads use JSON.stringify (so embedded quotes and
 * newlines are properly escaped).  Array/object payloads are bare JSON.
 *
 * ─── Cardinal rules ──────────────────────────────────────────────────────────
 * • Pure functions — no I/O, no imports beyond what is already part of JS.
 * • ESM only (import / export).
 * • No top-level await.
 */

// ─── Frame-prefix constants ───────────────────────────────────────────────────

export const WEB_STREAM_FRAME_PREFIX = Object.freeze({
  text:        '0',
  data:        '2',
  annotations: '8',
  error:       '3',
  step_finish: 'e',
  finish:      'd',
});

// ─── Internal frame builders ──────────────────────────────────────────────────

/**
 * Build a `0:` text-delta frame.
 * @param {string} text - Raw text (may contain quotes, newlines, etc.).
 * @returns {string}
 */
function textFrame(text) {
  return `${WEB_STREAM_FRAME_PREFIX.text}:${JSON.stringify(text)}\n`;
}

/**
 * Build a `2:` data-parts frame from a single object.
 * @param {object} obj
 * @returns {string}
 */
function dataFrame(obj) {
  return `${WEB_STREAM_FRAME_PREFIX.data}:${JSON.stringify([obj])}\n`;
}

/**
 * Build an `8:` annotations frame from a single object.
 * @param {object} obj
 * @returns {string}
 */
function annotationFrame(obj) {
  return `${WEB_STREAM_FRAME_PREFIX.annotations}:${JSON.stringify([obj])}\n`;
}

/**
 * Build a `3:` error frame.
 * @param {string} message
 * @returns {string}
 */
function errorFrame(message) {
  return `${WEB_STREAM_FRAME_PREFIX.error}:${JSON.stringify(String(message))}\n`;
}

/**
 * Build the step-finish `e:` frame.
 * @returns {string}
 */
function stepFinishFrame() {
  return `${WEB_STREAM_FRAME_PREFIX.step_finish}:${JSON.stringify({ finishReason: 'stop' })}\n`;
}

/**
 * Build the stream-done `d:` frame.
 * @returns {string}
 */
function doneFrame() {
  return `${WEB_STREAM_FRAME_PREFIX.finish}:${JSON.stringify({ finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } })}\n`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Translate one RPC chunk into one or more AI SDK numbered frames.
 *
 * Each returned string ends in '\n' and is ready to be written directly to an
 * HTTP/SSE response or a UDS socket.
 *
 * Mapping:
 *   markdown_text      → 0:"<text>"\n
 *   task_update        → 2:[{type:"task_update", ...fields}]\n
 *   plan_update        → 2:[{type:"plan_update",  ...fields}]\n
 *   suggested_response → 8:[{type:"suggested_response", ...fields}]\n
 *   tool_use           → 2:[{type:"tool_use", ...fields}]\n
 *   agent_end          → e:{finishReason:stop}\n  +  d:{...}\n
 *   error              → 3:"<message>"\n
 *   <unknown>          → 2:[{...chunk}]\n  (defensive pass-through)
 *
 * @param {{ type: string, [key: string]: any }} chunk
 * @returns {string[]}
 */
export function rpcChunkToAiSdkFrames(chunk) {
  if (!chunk || typeof chunk.type !== 'string') {
    // Defensive: unknown/malformed — pass through as data frame.
    return [dataFrame(chunk ?? {})];
  }

  switch (chunk.type) {
    case 'markdown_text': {
      // chunk.text may be undefined when content key is used (StreamingProxy
      // uses `content`).  Support both keys defensively.
      const text = typeof chunk.text === 'string'
        ? chunk.text
        : typeof chunk.content === 'string'
          ? chunk.content
          : '';
      return [textFrame(text)];
    }

    case 'task_update': {
      const { type, ...rest } = chunk;
      return [dataFrame({ type: 'task_update', ...rest })];
    }

    case 'plan_update': {
      const { type, ...rest } = chunk;
      return [dataFrame({ type: 'plan_update', ...rest })];
    }

    case 'suggested_response': {
      const { type, ...rest } = chunk;
      return [annotationFrame({ type: 'suggested_response', ...rest })];
    }

    case 'tool_use': {
      const { type, ...rest } = chunk;
      return [dataFrame({ type: 'tool_use', ...rest })];
    }

    case 'agent_end': {
      // Two frames: step-finish then stream-done.
      return [stepFinishFrame(), doneFrame()];
    }

    case 'error': {
      const message = chunk.message ?? chunk.error ?? 'unknown error';
      return [errorFrame(String(message))];
    }

    default: {
      // Defensive pass-through: unknown chunk types become data frames so the
      // client can inspect them without breaking the stream.
      return [dataFrame(chunk)];
    }
  }
}

/**
 * Translate a stream lifecycle event into zero or more AI SDK frames.
 *
 * Lifecycle events are high-level signals about the stream itself (not RPC
 * chunks from the AI model).
 *
 *   start → [] (no frame — client wires up its own listeners)
 *   end   → [e:\n, d:\n] (step-finish + done)
 *   error → [3:"<message>"\n]
 *
 * @param {{ type: 'start'|'end'|'error', message?: string }} event
 * @returns {string[]}
 */
export function lifecycleEventToFrames(event) {
  if (!event || typeof event.type !== 'string') return [];

  switch (event.type) {
    case 'start':
      return [];

    case 'end':
      return [stepFinishFrame(), doneFrame()];

    case 'error': {
      const message = event.message ?? 'stream error';
      return [errorFrame(String(message))];
    }

    default:
      return [];
  }
}
