/**
 * @file tests/scp-phase-3/03-web-stream-bridge-integration.test.mjs
 *
 * Acceptance tests for the AI SDK frame translation in web-stream-bridge.js.
 *
 * These are pure unit tests — no I/O, no Mongo, no sockets.  They drive
 * rpcChunkToAiSdkFrames() and lifecycleEventToFrames() with known inputs and
 * assert exact output strings, exercising the full chunk-type mapping defined
 * in the Phase 3 spec §7.1.
 *
 * Scenarios (~8 tests)
 * ─────────────────────
 * 1. Full sequence: 3×markdown_text + task_update + plan_update +
 *    suggested_response + agent_end → exact frame-string output
 * 2. Special chars (newlines, double-quotes) in markdown_text survive
 *    JSON round-trip
 * 3. Unicode (emoji, CJK) in markdown_text
 * 4. Empty markdown_text produces 0:""\n
 * 5. Error chunk → 3:"msg"\n
 * 6. Unknown chunk type → 2:[{...}]\n defensive pass-through
 * 7. lifecycleEventToFrames end → [e:\n, d:\n]
 * 8. lifecycleEventToFrames error → [3:"…"\n]
 *
 * Constraints
 * ───────────
 * • ESM only (.mjs)
 * • Pure — no I/O
 * • No top-level await
 */

import { describe, it, expect } from 'vitest';
import {
  rpcChunkToAiSdkFrames,
  lifecycleEventToFrames,
  WEB_STREAM_FRAME_PREFIX,
} from '../../bridge/core/web-stream-bridge.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Join an array of per-chunk frame arrays into a flat string.
 * Mirrors what a streaming write loop does.
 */
function renderSequence(chunks) {
  return chunks.flatMap((c) => rpcChunkToAiSdkFrames(c)).join('');
}

/**
 * Parse a `0:` text frame — extract the JSON-stringified payload after the
 * first colon and decode it.
 *
 * @param {string} frame  e.g. `0:"hello world"\n`
 * @returns {string}
 */
function decodeTextFrame(frame) {
  const colonIdx = frame.indexOf(':');
  const jsonPart = frame.slice(colonIdx + 1).trimEnd(); // drop the \n
  return JSON.parse(jsonPart);
}

/**
 * Parse a `2:` or `8:` data/annotation frame — return the first element of
 * the decoded array.
 *
 * @param {string} frame  e.g. `2:[{"type":"task_update",...}]\n`
 * @returns {object}
 */
function decodeDataFrame(frame) {
  const colonIdx = frame.indexOf(':');
  const jsonPart = frame.slice(colonIdx + 1).trimEnd();
  return JSON.parse(jsonPart)[0];
}

// ─── Test 1: Full sequence ────────────────────────────────────────────────────

describe('rpcChunkToAiSdkFrames — full sequence', () => {
  it('produces exact frame strings for a typical chat turn', () => {
    const chunks = [
      { type: 'markdown_text',      text: 'Hello' },
      { type: 'markdown_text',      text: ' world' },
      { type: 'markdown_text',      text: '!' },
      { type: 'task_update',        taskId: 't1', status: 'complete', label: 'Research' },
      { type: 'plan_update',        planId: 'p1', steps: ['a', 'b'] },
      { type: 'suggested_response', text: 'Try this' },
      { type: 'agent_end' },
    ];

    const output = renderSequence(chunks);

    // Build expected string.
    const stepFinishJson = JSON.stringify({ finishReason: 'stop' });
    const doneJson       = JSON.stringify({ finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } });

    const expected =
      `0:${JSON.stringify('Hello')}\n` +
      `0:${JSON.stringify(' world')}\n` +
      `0:${JSON.stringify('!')}\n` +
      `2:${JSON.stringify([{ type: 'task_update', taskId: 't1', status: 'complete', label: 'Research' }])}\n` +
      `2:${JSON.stringify([{ type: 'plan_update',  planId: 'p1', steps: ['a', 'b'] }])}\n` +
      `8:${JSON.stringify([{ type: 'suggested_response', text: 'Try this' }])}\n` +
      `e:${stepFinishJson}\n` +
      `d:${doneJson}\n`;

    expect(output).toBe(expected);
  });
});

// ─── Test 2: Special chars (newlines, quotes) ─────────────────────────────────

describe('rpcChunkToAiSdkFrames — special characters in markdown_text', () => {
  it('round-trips newlines and double-quotes through JSON safely', () => {
    const original = 'Line 1\nLine "two"\nLine \'three\'';
    const frames = rpcChunkToAiSdkFrames({ type: 'markdown_text', text: original });

    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame.startsWith('0:')).toBe(true);
    expect(frame.endsWith('\n')).toBe(true);

    const decoded = decodeTextFrame(frame);
    expect(decoded).toBe(original);
  });
});

// ─── Test 3: Unicode (emoji, CJK) ────────────────────────────────────────────

describe('rpcChunkToAiSdkFrames — unicode', () => {
  it('preserves emoji and CJK characters through JSON encoding', () => {
    const original = '你好世界 🌍 こんにちは 🎉';
    const frames = rpcChunkToAiSdkFrames({ type: 'markdown_text', text: original });
    const decoded = decodeTextFrame(frames[0]);
    expect(decoded).toBe(original);
  });
});

// ─── Test 4: Empty markdown_text ──────────────────────────────────────────────

describe('rpcChunkToAiSdkFrames — empty text', () => {
  it('produces 0:"" for an empty markdown_text chunk', () => {
    const frames = rpcChunkToAiSdkFrames({ type: 'markdown_text', text: '' });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe('0:""\n');
  });

  it('falls back to empty string when text key is missing', () => {
    const frames = rpcChunkToAiSdkFrames({ type: 'markdown_text' });
    expect(frames[0]).toBe('0:""\n');
  });
});

// ─── Test 5: Error chunk ──────────────────────────────────────────────────────

describe('rpcChunkToAiSdkFrames — error chunk', () => {
  it('translates error chunk to 3:"message" frame', () => {
    const frames = rpcChunkToAiSdkFrames({ type: 'error', message: 'Something broke' });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe(`3:${JSON.stringify('Something broke')}\n`);
  });

  it('falls back to "unknown error" if message is missing', () => {
    const frames = rpcChunkToAiSdkFrames({ type: 'error' });
    expect(frames[0]).toBe(`3:${JSON.stringify('unknown error')}\n`);
  });
});

// ─── Test 6: Unknown chunk type → defensive pass-through ─────────────────────

describe('rpcChunkToAiSdkFrames — unknown chunk type', () => {
  it('passes unknown types through as 2:[{...}] data frame', () => {
    const chunk = { type: 'future_chunk_type', payload: { foo: 42 } };
    const frames = rpcChunkToAiSdkFrames(chunk);

    expect(frames).toHaveLength(1);
    expect(frames[0].startsWith('2:')).toBe(true);

    const decoded = decodeDataFrame(frames[0]);
    expect(decoded).toEqual(chunk);
  });

  it('handles null chunk without throwing', () => {
    const frames = rpcChunkToAiSdkFrames(null);
    expect(frames).toHaveLength(1);
    expect(frames[0].startsWith('2:')).toBe(true);
  });
});

// ─── Test 7: lifecycleEventToFrames — end ────────────────────────────────────

describe('lifecycleEventToFrames — end event', () => {
  it('end event produces [step-finish frame, done frame]', () => {
    const frames = lifecycleEventToFrames({ type: 'end' });

    expect(frames).toHaveLength(2);
    expect(frames[0].startsWith(`${WEB_STREAM_FRAME_PREFIX.step_finish}:`)).toBe(true);
    expect(frames[1].startsWith(`${WEB_STREAM_FRAME_PREFIX.finish}:`)).toBe(true);

    // step-finish carries finishReason:'stop'
    const sfPayload = JSON.parse(frames[0].slice(2).trimEnd());
    expect(sfPayload.finishReason).toBe('stop');

    // done carries finishReason:'stop' + usage
    const dPayload = JSON.parse(frames[1].slice(2).trimEnd());
    expect(dPayload.finishReason).toBe('stop');
    expect(dPayload.usage).toBeDefined();
  });
});

// ─── Test 8: lifecycleEventToFrames — error ───────────────────────────────────

describe('lifecycleEventToFrames — error event', () => {
  it('error event produces a single 3: error frame', () => {
    const frames = lifecycleEventToFrames({ type: 'error', message: 'stream failed' });

    expect(frames).toHaveLength(1);
    expect(frames[0].startsWith('3:')).toBe(true);

    const msg = JSON.parse(frames[0].slice(2).trimEnd());
    expect(msg).toBe('stream failed');
  });

  it('start event produces no frames', () => {
    const frames = lifecycleEventToFrames({ type: 'start' });
    expect(frames).toHaveLength(0);
  });
});
