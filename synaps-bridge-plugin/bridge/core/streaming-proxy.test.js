/**
 * @file streaming-proxy.test.js
 *
 * Uses vi.useFakeTimers() for all debounce tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { StreamingProxy, FLUSH_CHARS, FLUSH_INTERVAL_MS } from './streaming-proxy.js';
import { SubagentTracker } from './subagent-tracker.js';
import { ToolProgress } from './tool-progress.js';

// ─── mock factory helpers ─────────────────────────────────────────────────────

/** Minimal mock StreamHandle that records append/stop calls. */
function makeMockStreamHandle() {
  return {
    appendCalls: [],
    stopCalls: [],
    startCalls: [],
    async start(opts) {
      this.startCalls.push(opts);
    },
    async append(chunk) {
      this.appendCalls.push(chunk);
    },
    async stop(opts) {
      this.stopCalls.push(opts ?? {});
    },
  };
}

/** Capabilities with all flags true. */
const capRich = {
  streaming: true,
  richStreamChunks: true,
  buttons: false,
  files: false,
  reactions: false,
  threading: false,
  auxBlocks: false,
  aiAppMode: false,
};

/** Capabilities with richStreamChunks=false, auxBlocks=true. */
const capAux = { ...capRich, richStreamChunks: false, auxBlocks: true };

/** Capabilities with both false. */
const capInline = { ...capRich, richStreamChunks: false, auxBlocks: false };

/** Minimal mock ToolProgressRenderer. */
function makeMockToolRenderer() {
  return {
    renderCalls: [],
    render(args) {
      this.renderCalls.push(args);
      return `[tool:${args.toolName}]`;
    },
  };
}

/** Minimal mock SubagentRenderer. */
function makeMockSubagentRenderer() {
  return {
    renderCalls: [],
    render(state) {
      this.renderCalls.push(state);
      return `[subagent:${state.agent_name}]`;
    },
  };
}

// ─── shared setup ─────────────────────────────────────────────────────────────

/** Build a StreamingProxy with controllable components. */
function makeProxy({
  capabilities = capRich,
  flushChars = FLUSH_CHARS,
  flushIntervalMs = FLUSH_INTERVAL_MS,
} = {}) {
  const rpc = new EventEmitter();
  const streamHandle = makeMockStreamHandle();
  const toolProgressRenderer = makeMockToolRenderer();
  const subagentRenderer = makeMockSubagentRenderer();
  const subagentTracker = new SubagentTracker();
  const toolProgress = new ToolProgress();
  const logger = { warn: vi.fn(), info: vi.fn() };

  const proxy = new StreamingProxy({
    rpc,
    streamHandle,
    capabilities,
    toolProgressRenderer,
    subagentRenderer,
    subagentTracker,
    toolProgress,
    flushChars,
    flushIntervalMs,
    logger,
  });

  return { proxy, rpc, streamHandle, toolProgressRenderer, subagentRenderer, logger };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('StreamingProxy — debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('text deltas under 80 chars flush after 250 ms timer', async () => {
    const { proxy, rpc, streamHandle } = makeProxy();
    await proxy.start();

    rpc.emit('message_update', { type: 'text_delta', delta: 'hello ' });
    rpc.emit('message_update', { type: 'text_delta', delta: 'world' });

    // Nothing flushed yet
    expect(streamHandle.appendCalls).toHaveLength(0);

    // Advance past the flush interval
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    expect(streamHandle.appendCalls).toHaveLength(1);
    expect(streamHandle.appendCalls[0]).toEqual({
      type: 'markdown_text',
      content: 'hello world',
    });
  });

  it('text deltas accumulating to exactly 80 chars flush immediately', async () => {
    const { proxy, rpc, streamHandle } = makeProxy();
    await proxy.start();

    const chunk = 'a'.repeat(80); // exactly FLUSH_CHARS
    rpc.emit('message_update', { type: 'text_delta', delta: chunk });

    // Flush is synchronous (fire-and-forget promise settles on next microtask)
    await proxy.awaitIdle();

    expect(streamHandle.appendCalls).toHaveLength(1);
    expect(streamHandle.appendCalls[0].content).toBe(chunk);
  });

  it('second delta triggers flush when combined length passes 80 chars', async () => {
    const { proxy, rpc, streamHandle } = makeProxy();
    await proxy.start();

    // First delta: 79 chars — under threshold, timer started
    rpc.emit('message_update', { type: 'text_delta', delta: 'x'.repeat(79) });
    expect(streamHandle.appendCalls).toHaveLength(0);

    // Second delta: adds 2 chars → total 81 ≥ 80 → immediate flush
    rpc.emit('message_update', { type: 'text_delta', delta: 'yy' });
    await proxy.awaitIdle();

    expect(streamHandle.appendCalls).toHaveLength(1);
    expect(streamHandle.appendCalls[0].content).toBe('x'.repeat(79) + 'yy');
  });

  it('timer is cancelled when immediate flush fires on threshold', async () => {
    const { proxy, rpc, streamHandle } = makeProxy();
    await proxy.start();

    // Under threshold — timer scheduled
    rpc.emit('message_update', { type: 'text_delta', delta: 'a'.repeat(70) });

    // Push over threshold — immediate flush, timer cancelled
    rpc.emit('message_update', { type: 'text_delta', delta: 'b'.repeat(15) });
    await proxy.awaitIdle();

    expect(streamHandle.appendCalls).toHaveLength(1);
    const firstContent = streamHandle.appendCalls[0].content;

    // Advance past the interval — should NOT produce a second empty flush
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS + 50);

    // Still only one call (no phantom second flush)
    expect(streamHandle.appendCalls).toHaveLength(1);
    expect(streamHandle.appendCalls[0].content).toBe(firstContent);
  });

  it('stop() flushes remaining buffer then calls streamHandle.stop', async () => {
    const { proxy, rpc, streamHandle } = makeProxy();
    await proxy.start();

    rpc.emit('message_update', { type: 'text_delta', delta: 'partial text' });
    expect(streamHandle.appendCalls).toHaveLength(0);

    await proxy.stop({ blocks: [{ type: 'divider' }] });

    expect(streamHandle.appendCalls).toHaveLength(1);
    expect(streamHandle.appendCalls[0]).toEqual({
      type: 'markdown_text',
      content: 'partial text',
    });
    expect(streamHandle.stopCalls).toHaveLength(1);
    expect(streamHandle.stopCalls[0]).toEqual({ blocks: [{ type: 'divider' }] });
  });

  it('stop() is idempotent — second call is a no-op', async () => {
    const { proxy, rpc, streamHandle } = makeProxy();
    await proxy.start();

    rpc.emit('message_update', { type: 'text_delta', delta: 'hi' });

    await proxy.stop();
    await proxy.stop(); // second call

    expect(streamHandle.stopCalls).toHaveLength(1);
    expect(streamHandle.appendCalls).toHaveLength(1);
  });

  it('toolcall_start mid-debounce force-flushes text first', async () => {
    const { proxy, rpc, streamHandle } = makeProxy({ capabilities: capRich });
    await proxy.start();

    rpc.emit('message_update', { type: 'text_delta', delta: 'some text' });
    // No timer fired yet
    expect(streamHandle.appendCalls).toHaveLength(0);

    // Tool start should force-flush first
    rpc.emit('message_update', { type: 'toolcall_start', tool_id: 'T1', tool_name: 'my_tool' });
    await proxy.awaitIdle();

    // First append = flushed text, second = task_update for tool
    expect(streamHandle.appendCalls.length).toBeGreaterThanOrEqual(1);
    expect(streamHandle.appendCalls[0]).toEqual({
      type: 'markdown_text',
      content: 'some text',
    });
  });

  it('subagent_start mid-debounce force-flushes text first', async () => {
    const { proxy, rpc, streamHandle } = makeProxy({ capabilities: capRich });
    await proxy.start();

    rpc.emit('message_update', { type: 'text_delta', delta: 'buffered' });
    expect(streamHandle.appendCalls).toHaveLength(0);

    rpc.emit('subagent_start', { subagent_id: 'S1', agent_name: 'helper', task_preview: 'task' });
    await proxy.awaitIdle();

    expect(streamHandle.appendCalls[0]).toEqual({
      type: 'markdown_text',
      content: 'buffered',
    });
  });

  it('agent_end mid-debounce force-flushes text first', async () => {
    const { proxy, rpc, streamHandle } = makeProxy({ capabilities: capRich });
    await proxy.start();

    rpc.emit('message_update', { type: 'text_delta', delta: 'answer here' });

    rpc.emit('agent_end', { usage: { input_tokens: 10, output_tokens: 20 } });
    await proxy.awaitIdle();

    expect(streamHandle.appendCalls[0]).toEqual({
      type: 'markdown_text',
      content: 'answer here',
    });
  });
});

// ─── capability dispatch ──────────────────────────────────────────────────────

describe('StreamingProxy — richStreamChunks capability', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('subagent_start dispatches task_update chunk via streamHandle.append', async () => {
    const { proxy, rpc, streamHandle } = makeProxy({ capabilities: capRich });
    await proxy.start();

    rpc.emit('subagent_start', {
      subagent_id: 'S1',
      agent_name: 'summariser',
      task_preview: 'boil it down',
    });
    await proxy.awaitIdle();

    const taskUpdate = streamHandle.appendCalls.find((c) => c.type === 'task_update');
    expect(taskUpdate).toBeDefined();
    expect(taskUpdate.task.id).toBe('S1');
    expect(taskUpdate.task.agent_name).toBe('summariser');
    expect(taskUpdate.task.status).toBe('running');
  });
});

describe('StreamingProxy — auxBlocks capability', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('subagent_start emits "aux" event with kind="subagent"', async () => {
    const { proxy, rpc } = makeProxy({ capabilities: capAux });
    await proxy.start();

    const auxEvents = [];
    proxy.on('aux', (e) => auxEvents.push(e));

    rpc.emit('subagent_start', {
      subagent_id: 'S1',
      agent_name: 'worker',
      task_preview: 'work',
    });
    await proxy.awaitIdle();

    expect(auxEvents).toHaveLength(1);
    expect(auxEvents[0].kind).toBe('subagent');
    expect(auxEvents[0].payload).toBe('[subagent:worker]');
  });

  it('tool start emits "aux" event with kind="tool" when auxBlocks=true', async () => {
    const { proxy, rpc } = makeProxy({ capabilities: capAux });
    await proxy.start();

    const auxEvents = [];
    proxy.on('aux', (e) => auxEvents.push(e));

    rpc.emit('message_update', { type: 'toolcall_start', tool_id: 'T1', tool_name: 'my_tool' });
    await proxy.awaitIdle();

    expect(auxEvents).toHaveLength(1);
    expect(auxEvents[0].kind).toBe('tool');
  });
});

describe('StreamingProxy — inline text fallback (no richStreamChunks, no auxBlocks)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('subagent_start injects italic inline text into the buffer', async () => {
    const { proxy, rpc, streamHandle } = makeProxy({ capabilities: capInline });
    await proxy.start();

    rpc.emit('subagent_start', {
      subagent_id: 'S1',
      agent_name: 'cruncher',
      task_preview: 'crunch',
    });
    await proxy.awaitIdle();

    // Advance timer to flush the inline text
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    const textChunks = streamHandle.appendCalls.filter((c) => c.type === 'markdown_text');
    expect(textChunks.length).toBeGreaterThanOrEqual(1);
    const combined = textChunks.map((c) => c.content).join('');
    expect(combined).toContain('cruncher');
    expect(combined).toContain('_[subagent:');
  });

  it('tool inline text is injected when no rich/aux capability', async () => {
    const { proxy, rpc, streamHandle } = makeProxy({ capabilities: capInline });
    await proxy.start();

    rpc.emit('message_update', { type: 'toolcall_start', tool_id: 'T1', tool_name: 'search' });
    await proxy.awaitIdle();

    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);

    const combined = streamHandle.appendCalls.map((c) => c.content ?? '').join('');
    expect(combined).toContain('search');
  });
});

// ─── tool lifecycle ───────────────────────────────────────────────────────────

describe('StreamingProxy — tool lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('full tool lifecycle: start → input_delta×3 → input → result', async () => {
    const { proxy, rpc, streamHandle } = makeProxy({ capabilities: capRich });
    await proxy.start();

    rpc.emit('message_update', { type: 'toolcall_start', tool_id: 'T1', tool_name: 'read' });
    await proxy.awaitIdle();

    rpc.emit('message_update', { type: 'toolcall_input_delta', tool_id: 'T1', delta: '{"f' });
    rpc.emit('message_update', { type: 'toolcall_input_delta', tool_id: 'T1', delta: 'ile"' });
    rpc.emit('message_update', { type: 'toolcall_input_delta', tool_id: 'T1', delta: ':"a.txt"}' });
    await proxy.awaitIdle();

    rpc.emit('message_update', { type: 'toolcall_input', tool_id: 'T1', input: { file: 'a.txt' } });
    await proxy.awaitIdle();

    rpc.emit('message_update', { type: 'toolcall_result', tool_id: 'T1', result: 'contents here' });
    await proxy.awaitIdle();

    // There should be task_update chunks for start, input, and result
    const taskUpdates = streamHandle.appendCalls.filter((c) => c.type === 'task_update');
    expect(taskUpdates.length).toBeGreaterThanOrEqual(2);

    // After result, find the final task_update — it should show complete status
    const finalUpdate = taskUpdates[taskUpdates.length - 1];
    expect(finalUpdate.task.status).toBe('complete');
    expect(finalUpdate.task.result).toBe('contents here');
    expect(finalUpdate.task.input).toEqual({ file: 'a.txt' });
  });

  it('inputBuffer accumulates correctly across multiple deltas', async () => {
    const { proxy, rpc } = makeProxy({ capabilities: capRich });
    // Access internal toolProgress for assertion
    const tp = proxy._toolProgress;

    await proxy.start();

    rpc.emit('message_update', { type: 'toolcall_start', tool_id: 'T1', tool_name: 'x' });
    await proxy.awaitIdle();

    rpc.emit('message_update', { type: 'toolcall_input_delta', tool_id: 'T1', delta: 'ab' });
    rpc.emit('message_update', { type: 'toolcall_input_delta', tool_id: 'T1', delta: 'cd' });
    rpc.emit('message_update', { type: 'toolcall_input_delta', tool_id: 'T1', delta: 'ef' });
    await proxy.awaitIdle();

    expect(tp.get('T1').inputBuffer).toBe('abcdef');
  });
});

// ─── query helpers ────────────────────────────────────────────────────────────

describe('StreamingProxy — query helpers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('getBufferedTextChars returns current buffer length', async () => {
    const { proxy, rpc } = makeProxy();
    await proxy.start();

    expect(proxy.getBufferedTextChars()).toBe(0);

    rpc.emit('message_update', { type: 'text_delta', delta: 'hello' }); // 5 chars
    await proxy.awaitIdle();
    expect(proxy.getBufferedTextChars()).toBe(5);

    rpc.emit('message_update', { type: 'text_delta', delta: ' world' }); // +6 = 11
    await proxy.awaitIdle();
    expect(proxy.getBufferedTextChars()).toBe(11);
  });

  it('getMsSinceLastDelta returns 0 when no delta received', async () => {
    const { proxy } = makeProxy();
    await proxy.start();
    expect(proxy.getMsSinceLastDelta()).toBe(0);
  });

  it('getMsSinceLastDelta returns elapsed ms after a delta', async () => {
    const { proxy, rpc } = makeProxy();
    await proxy.start();

    rpc.emit('message_update', { type: 'text_delta', delta: 'hi' });
    await proxy.awaitIdle();

    // Advance 100ms
    await vi.advanceTimersByTimeAsync(100);

    const elapsed = proxy.getMsSinceLastDelta();
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it('getPendingSubagentCount reflects tracker state', async () => {
    const { proxy, rpc } = makeProxy({ capabilities: capRich });
    await proxy.start();

    expect(proxy.getPendingSubagentCount()).toBe(0);

    rpc.emit('subagent_start', { subagent_id: 'S1', agent_name: 'a' });
    rpc.emit('subagent_start', { subagent_id: 'S2', agent_name: 'b' });
    await proxy.awaitIdle();

    expect(proxy.getPendingSubagentCount()).toBe(2);

    rpc.emit('subagent_done', { subagent_id: 'S1', agent_name: 'a', duration_secs: 1 });
    await proxy.awaitIdle();

    expect(proxy.getPendingSubagentCount()).toBe(1);
  });
});
