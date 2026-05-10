/**
 * @file bridge/core/web-stream-bridge.test.js
 *
 * Unit tests for the pure rpcChunkToAiSdkFrames / lifecycleEventToFrames
 * functions.  No I/O.  Every test is synchronous (the functions are pure).
 */

import { describe, it, expect } from 'vitest';
import {
  WEB_STREAM_FRAME_PREFIX,
  rpcChunkToAiSdkFrames,
  lifecycleEventToFrames,
} from './web-stream-bridge.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a single AI SDK frame string into its prefix char and payload.
 * Throws if the frame does not match `<char>:<json>\n`.
 */
function parseFrame(frame) {
  expect(typeof frame).toBe('string');
  expect(frame.endsWith('\n')).toBe(true);

  const colonIdx = frame.indexOf(':');
  expect(colonIdx).toBeGreaterThan(0);

  const prefix  = frame.slice(0, colonIdx);
  const payload = frame.slice(colonIdx + 1, -1); // strip trailing \n
  return { prefix, payload, parsed: JSON.parse(payload) };
}

// ─── WEB_STREAM_FRAME_PREFIX constant ─────────────────────────────────────────

describe('WEB_STREAM_FRAME_PREFIX', () => {
  it('exports the expected prefix chars', () => {
    expect(WEB_STREAM_FRAME_PREFIX.text).toBe('0');
    expect(WEB_STREAM_FRAME_PREFIX.data).toBe('2');
    expect(WEB_STREAM_FRAME_PREFIX.annotations).toBe('8');
    expect(WEB_STREAM_FRAME_PREFIX.error).toBe('3');
    expect(WEB_STREAM_FRAME_PREFIX.step_finish).toBe('e');
    expect(WEB_STREAM_FRAME_PREFIX.finish).toBe('d');
  });

  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(WEB_STREAM_FRAME_PREFIX)).toBe(true);
  });
});

// ─── markdown_text ─────────────────────────────────────────────────────────────

describe('rpcChunkToAiSdkFrames — markdown_text', () => {
  it('returns exactly one frame', () => {
    const frames = rpcChunkToAiSdkFrames({ type: 'markdown_text', text: 'Hello' });
    expect(frames).toHaveLength(1);
  });

  it('frame has prefix "0"', () => {
    const [frame] = rpcChunkToAiSdkFrames({ type: 'markdown_text', text: 'Hi' });
    const { prefix } = parseFrame(frame);
    expect(prefix).toBe('0');
  });

  it('payload is JSON-stringified text (string value)', () => {
    const [frame] = rpcChunkToAiSdkFrames({ type: 'markdown_text', text: 'Hello world' });
    const { parsed } = parseFrame(frame);
    expect(parsed).toBe('Hello world');
  });

  it('correctly escapes embedded double-quotes', () => {
    const [frame] = rpcChunkToAiSdkFrames({ type: 'markdown_text', text: 'say "hi"' });
    const { parsed } = parseFrame(frame);
    expect(parsed).toBe('say "hi"');
    // The raw frame must not contain unescaped quotes in the value portion.
    expect(frame).toContain('\\"hi\\"');
  });

  it('correctly escapes embedded newlines', () => {
    const [frame] = rpcChunkToAiSdkFrames({ type: 'markdown_text', text: 'line1\nline2' });
    const { parsed } = parseFrame(frame);
    expect(parsed).toBe('line1\nline2');
    // The raw frame must have \\n not a literal newline inside the JSON value.
    expect(frame).toContain('\\n');
  });

  it('empty text produces 0:""\n', () => {
    const [frame] = rpcChunkToAiSdkFrames({ type: 'markdown_text', text: '' });
    expect(frame).toBe('0:""\n');
  });

  it('also handles `content` key (StreamingProxy compat)', () => {
    const [frame] = rpcChunkToAiSdkFrames({ type: 'markdown_text', content: 'via content key' });
    const { parsed } = parseFrame(frame);
    expect(parsed).toBe('via content key');
  });

  it('frame ends with \\n', () => {
    const [frame] = rpcChunkToAiSdkFrames({ type: 'markdown_text', text: 'x' });
    expect(frame.endsWith('\n')).toBe(true);
  });
});

// ─── task_update ───────────────────────────────────────────────────────────────

describe('rpcChunkToAiSdkFrames — task_update', () => {
  const chunk = {
    type: 'task_update',
    id: 'tool-abc',
    parent_id: null,
    state: 'in_progress',
    label: 'Running search',
  };

  it('returns exactly one frame', () => {
    expect(rpcChunkToAiSdkFrames(chunk)).toHaveLength(1);
  });

  it('frame has prefix "2"', () => {
    const [frame] = rpcChunkToAiSdkFrames(chunk);
    const { prefix } = parseFrame(frame);
    expect(prefix).toBe('2');
  });

  it('payload is a JSON array containing the data object', () => {
    const [frame] = rpcChunkToAiSdkFrames(chunk);
    const { parsed } = parseFrame(frame);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it('data object has type:"task_update" and original fields', () => {
    const [frame] = rpcChunkToAiSdkFrames(chunk);
    const { parsed } = parseFrame(frame);
    const obj = parsed[0];
    expect(obj.type).toBe('task_update');
    expect(obj.id).toBe('tool-abc');
    expect(obj.state).toBe('in_progress');
    expect(obj.label).toBe('Running search');
  });
});

// ─── plan_update ───────────────────────────────────────────────────────────────

describe('rpcChunkToAiSdkFrames — plan_update', () => {
  const chunk = {
    type: 'plan_update',
    items: [{ id: 1, text: 'Step one' }, { id: 2, text: 'Step two' }],
    revision: 3,
  };

  it('returns exactly one 2: frame', () => {
    const frames = rpcChunkToAiSdkFrames(chunk);
    expect(frames).toHaveLength(1);
    const { prefix } = parseFrame(frames[0]);
    expect(prefix).toBe('2');
  });

  it('data object has type:"plan_update" and items array', () => {
    const [frame] = rpcChunkToAiSdkFrames(chunk);
    const { parsed } = parseFrame(frame);
    const obj = parsed[0];
    expect(obj.type).toBe('plan_update');
    expect(Array.isArray(obj.items)).toBe(true);
    expect(obj.items).toHaveLength(2);
    expect(obj.revision).toBe(3);
  });
});

// ─── suggested_response ────────────────────────────────────────────────────────

describe('rpcChunkToAiSdkFrames — suggested_response', () => {
  const chunk = {
    type: 'suggested_response',
    prompts: ['Tell me more', 'Summarise'],
    source: 'agent',
  };

  it('returns exactly one 8: frame', () => {
    const frames = rpcChunkToAiSdkFrames(chunk);
    expect(frames).toHaveLength(1);
    const { prefix } = parseFrame(frames[0]);
    expect(prefix).toBe('8');
  });

  it('annotation object has type:"suggested_response" and prompts array', () => {
    const [frame] = rpcChunkToAiSdkFrames(chunk);
    const { parsed } = parseFrame(frame);
    expect(Array.isArray(parsed)).toBe(true);
    const obj = parsed[0];
    expect(obj.type).toBe('suggested_response');
    expect(obj.prompts).toEqual(['Tell me more', 'Summarise']);
    expect(obj.source).toBe('agent');
  });
});

// ─── tool_use ──────────────────────────────────────────────────────────────────

describe('rpcChunkToAiSdkFrames — tool_use', () => {
  const chunk = {
    type: 'tool_use',
    tool_id: 'search-42',
    tool_name: 'web_search',
    input: { query: 'Node.js streams' },
  };

  it('returns exactly one 2: frame', () => {
    const frames = rpcChunkToAiSdkFrames(chunk);
    expect(frames).toHaveLength(1);
    const { prefix } = parseFrame(frames[0]);
    expect(prefix).toBe('2');
  });

  it('data object has type:"tool_use" and original fields', () => {
    const [frame] = rpcChunkToAiSdkFrames(chunk);
    const { parsed } = parseFrame(frame);
    const obj = parsed[0];
    expect(obj.type).toBe('tool_use');
    expect(obj.tool_name).toBe('web_search');
    expect(obj.tool_id).toBe('search-42');
  });
});

// ─── agent_end ────────────────────────────────────────────────────────────────

describe('rpcChunkToAiSdkFrames — agent_end', () => {
  it('returns exactly 2 frames', () => {
    const frames = rpcChunkToAiSdkFrames({ type: 'agent_end' });
    expect(frames).toHaveLength(2);
  });

  it('first frame is e: (step-finish)', () => {
    const [f1] = rpcChunkToAiSdkFrames({ type: 'agent_end' });
    const { prefix, parsed } = parseFrame(f1);
    expect(prefix).toBe('e');
    expect(parsed.finishReason).toBe('stop');
  });

  it('second frame is d: (done) with usage', () => {
    const [, f2] = rpcChunkToAiSdkFrames({ type: 'agent_end' });
    const { prefix, parsed } = parseFrame(f2);
    expect(prefix).toBe('d');
    expect(parsed.finishReason).toBe('stop');
    expect(parsed.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('both frames end with \\n', () => {
    const frames = rpcChunkToAiSdkFrames({ type: 'agent_end' });
    for (const f of frames) expect(f.endsWith('\n')).toBe(true);
  });
});

// ─── error ────────────────────────────────────────────────────────────────────

describe('rpcChunkToAiSdkFrames — error', () => {
  it('returns exactly one 3: frame', () => {
    const frames = rpcChunkToAiSdkFrames({ type: 'error', message: 'boom' });
    expect(frames).toHaveLength(1);
    const { prefix } = parseFrame(frames[0]);
    expect(prefix).toBe('3');
  });

  it('payload is JSON-stringified error message', () => {
    const [frame] = rpcChunkToAiSdkFrames({ type: 'error', message: 'something broke' });
    const { parsed } = parseFrame(frame);
    expect(parsed).toBe('something broke');
  });

  it('falls back to chunk.error key if message is absent', () => {
    const [frame] = rpcChunkToAiSdkFrames({ type: 'error', error: 'alt key' });
    const { parsed } = parseFrame(frame);
    expect(parsed).toBe('alt key');
  });

  it('handles error message with embedded quotes', () => {
    const [frame] = rpcChunkToAiSdkFrames({ type: 'error', message: 'failed: "timeout"' });
    const { parsed } = parseFrame(frame);
    expect(parsed).toBe('failed: "timeout"');
  });
});

// ─── unknown chunk type (defensive) ───────────────────────────────────────────

describe('rpcChunkToAiSdkFrames — unknown / defensive', () => {
  it('unknown type produces a 2: data frame', () => {
    const frames = rpcChunkToAiSdkFrames({ type: 'some_future_type', foo: 'bar' });
    expect(frames).toHaveLength(1);
    const { prefix } = parseFrame(frames[0]);
    expect(prefix).toBe('2');
  });

  it('unknown type preserves original chunk fields in the data object', () => {
    const chunk = { type: 'mystery', value: 42, nested: { a: 1 } };
    const [frame] = rpcChunkToAiSdkFrames(chunk);
    const { parsed } = parseFrame(frame);
    const obj = parsed[0];
    expect(obj.type).toBe('mystery');
    expect(obj.value).toBe(42);
    expect(obj.nested).toEqual({ a: 1 });
  });

  it('null chunk produces a 2: data frame without throwing', () => {
    const frames = rpcChunkToAiSdkFrames(null);
    expect(frames).toHaveLength(1);
    const { prefix } = parseFrame(frames[0]);
    expect(prefix).toBe('2');
  });

  it('chunk with no type property produces a 2: data frame', () => {
    const frames = rpcChunkToAiSdkFrames({ foo: 'bar' });
    expect(frames).toHaveLength(1);
    const { prefix } = parseFrame(frames[0]);
    expect(prefix).toBe('2');
  });
});

// ─── lifecycleEventToFrames ───────────────────────────────────────────────────

describe('lifecycleEventToFrames', () => {
  it('"start" event produces no frames', () => {
    const frames = lifecycleEventToFrames({ type: 'start' });
    expect(frames).toEqual([]);
  });

  it('"end" event produces e: + d: frames', () => {
    const frames = lifecycleEventToFrames({ type: 'end' });
    expect(frames).toHaveLength(2);
    const { prefix: p1 } = parseFrame(frames[0]);
    const { prefix: p2 } = parseFrame(frames[1]);
    expect(p1).toBe('e');
    expect(p2).toBe('d');
  });

  it('"end" frames carry correct finishReason and usage', () => {
    const [f1, f2] = lifecycleEventToFrames({ type: 'end' });
    expect(parseFrame(f1).parsed).toEqual({ finishReason: 'stop' });
    expect(parseFrame(f2).parsed).toMatchObject({
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
    });
  });

  it('"error" event produces a 3: frame', () => {
    const frames = lifecycleEventToFrames({ type: 'error', message: 'stream died' });
    expect(frames).toHaveLength(1);
    const { prefix, parsed } = parseFrame(frames[0]);
    expect(prefix).toBe('3');
    expect(parsed).toBe('stream died');
  });

  it('"error" defaults message to "stream error" when absent', () => {
    const [frame] = lifecycleEventToFrames({ type: 'error' });
    const { parsed } = parseFrame(frame);
    expect(parsed).toBe('stream error');
  });

  it('unknown lifecycle type produces no frames', () => {
    expect(lifecycleEventToFrames({ type: 'unknown_future' })).toEqual([]);
  });

  it('null event produces no frames without throwing', () => {
    expect(lifecycleEventToFrames(null)).toEqual([]);
  });
});
