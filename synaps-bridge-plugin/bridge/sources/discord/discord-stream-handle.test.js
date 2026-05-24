/**
 * @file discord-stream-handle.test.js
 *
 * Tests for DiscordStreamHandle.
 * All Discord API calls are mocked; no live network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordStreamHandle } from './discord-stream-handle.js';
import { DiscordFormatter } from './discord-formatter.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function mockMessage() {
  return { edit: vi.fn().mockResolvedValue(undefined) };
}

function mockChannel(msg) {
  const message = msg ?? mockMessage();
  return {
    _message: message,
    send:        vi.fn().mockResolvedValue(message),
    sendTyping:  vi.fn().mockResolvedValue(undefined),
  };
}

const formatter = new DiscordFormatter();

function makeHandle(channelOverride, extra = {}) {
  const channel = channelOverride ?? mockChannel();
  return new DiscordStreamHandle({ channel, formatter, ...extra });
}

// ─── constructor ──────────────────────────────────────────────────────────────

describe('DiscordStreamHandle — constructor', () => {
  it('is an instance of DiscordStreamHandle', () => {
    const h = makeHandle();
    expect(h).toBeInstanceOf(DiscordStreamHandle);
  });

  it('initialises _stopped to false', () => {
    expect(makeHandle()._stopped).toBe(false);
  });

  it('initialises _buffer to empty string', () => {
    expect(makeHandle()._buffer).toBe('');
  });
});

// ─── start() ──────────────────────────────────────────────────────────────────

describe('DiscordStreamHandle — start()', () => {
  it('sends the ⏳ placeholder via channel.send()', async () => {
    const channel = mockChannel();
    const h = makeHandle(channel);
    await h.start();
    expect(channel.send).toHaveBeenCalledWith('⏳');
  });

  it('stores the returned message object as _message', async () => {
    const msg = mockMessage();
    const channel = mockChannel(msg);
    const h = makeHandle(channel);
    await h.start();
    expect(h._message).toBe(msg);
  });

  it('starts the typing interval (sendTyping called after delay)', async () => {
    vi.useFakeTimers();
    const channel = mockChannel();
    const h = makeHandle(channel);
    await h.start();
    expect(channel.sendTyping).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(channel.sendTyping).toHaveBeenCalledTimes(2);
    clearInterval(h._typingInterval);
    vi.useRealTimers();
  });

  it('propagates errors from channel.send()', async () => {
    const channel = mockChannel();
    channel.send.mockRejectedValue(new Error('Missing Access'));
    const h = makeHandle(channel);
    await expect(h.start()).rejects.toThrow('Missing Access');
  });
});

// ─── append() ─────────────────────────────────────────────────────────────────

describe('DiscordStreamHandle — append(): markdown_text', () => {
  it('accumulates text into _buffer', async () => {
    vi.useFakeTimers();
    const channel = mockChannel();
    const h = makeHandle(channel);
    await h.start();
    await h.append({ type: 'markdown_text', content: 'hello ' });
    await h.append({ type: 'markdown_text', content: 'world' });
    expect(h._buffer).toBe('hello world');
    clearInterval(h._typingInterval);
    clearTimeout(h._debounceTimer);
    vi.useRealTimers();
  });

  it('calls message.edit() after the debounce delay', async () => {
    vi.useFakeTimers();
    const msg = mockMessage();
    const channel = mockChannel(msg);
    const h = makeHandle(channel);
    await h.start();
    await h.append({ type: 'markdown_text', content: 'streaming...' });
    expect(msg.edit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(msg.edit).toHaveBeenCalledWith({ content: 'streaming...' });
    clearInterval(h._typingInterval);
    vi.useRealTimers();
  });

  it('debounces multiple appends — only one edit call', async () => {
    vi.useFakeTimers();
    const msg = mockMessage();
    const channel = mockChannel(msg);
    const h = makeHandle(channel);
    await h.start();
    await h.append({ type: 'markdown_text', content: 'a' });
    await h.append({ type: 'markdown_text', content: 'b' });
    await h.append({ type: 'markdown_text', content: 'c' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(msg.edit).toHaveBeenCalledTimes(1);
    expect(msg.edit).toHaveBeenCalledWith({ content: 'abc' });
    clearInterval(h._typingInterval);
    vi.useRealTimers();
  });
});

describe('DiscordStreamHandle — append(): task_update / plan_update', () => {
  it('task_update is dropped — no edit call, logs warn', async () => {
    vi.useFakeTimers();
    const warns = [];
    const logger = { warn: (...a) => warns.push(a) };
    const msg = mockMessage();
    const channel = mockChannel(msg);
    const h = makeHandle(channel, { logger });
    await h.start();
    await h.append({ type: 'task_update', task: { id: 't1' } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(msg.edit).not.toHaveBeenCalled();
    expect(warns.length).toBeGreaterThan(0);
    clearInterval(h._typingInterval);
    vi.useRealTimers();
  });

  it('plan_update is dropped — no edit call, logs warn', async () => {
    vi.useFakeTimers();
    const warns = [];
    const logger = { warn: (...a) => warns.push(a) };
    const msg = mockMessage();
    const channel = mockChannel(msg);
    const h = makeHandle(channel, { logger });
    await h.start();
    await h.append({ type: 'plan_update', plan: { steps: [] } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(msg.edit).not.toHaveBeenCalled();
    expect(warns.length).toBeGreaterThan(0);
    clearInterval(h._typingInterval);
    vi.useRealTimers();
  });
});

describe('DiscordStreamHandle — append(): blocks', () => {
  it('queues blocks into _pendingBlocks — no immediate edit', async () => {
    vi.useFakeTimers();
    const msg = mockMessage();
    const channel = mockChannel(msg);
    const h = makeHandle(channel);
    await h.start();
    const blocks = [{ type: 'section', text: 'hello' }];
    await h.append({ type: 'blocks', blocks });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(msg.edit).not.toHaveBeenCalled();
    expect(h._pendingBlocks).toEqual(blocks);
    clearInterval(h._typingInterval);
    vi.useRealTimers();
  });
});

describe('DiscordStreamHandle — append(): after stop', () => {
  it('is a no-op when called after stop()', async () => {
    vi.useFakeTimers();
    const msg = mockMessage();
    const channel = mockChannel(msg);
    const h = makeHandle(channel);
    await h.start();
    await h.stop();
    const editCountAfterStop = msg.edit.mock.calls.length;
    await h.append({ type: 'markdown_text', content: 'late chunk' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(msg.edit.mock.calls.length).toBe(editCountAfterStop);
    vi.useRealTimers();
  });
});

describe('DiscordStreamHandle — append(): error swallowing', () => {
  it('does not throw when message.edit rejects during debounce flush', async () => {
    vi.useFakeTimers();
    const warns = [];
    const logger = { warn: (...a) => warns.push(a) };
    const msg = mockMessage();
    msg.edit.mockRejectedValue(new Error('Unknown Message'));
    const channel = mockChannel(msg);
    const h = makeHandle(channel, { logger });
    await h.start();
    await h.append({ type: 'markdown_text', content: 'hi' });
    await vi.advanceTimersByTimeAsync(1_000);
    // Should not throw — error is swallowed
    expect(warns.length).toBeGreaterThan(0);
    clearInterval(h._typingInterval);
    vi.useRealTimers();
  });
});

// ─── stop() ───────────────────────────────────────────────────────────────────

describe('DiscordStreamHandle — stop()', () => {
  it('clears the typing interval', async () => {
    vi.useFakeTimers();
    const channel = mockChannel();
    const h = makeHandle(channel);
    await h.start();
    await h.stop();
    const callsBefore = channel.sendTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(channel.sendTyping.mock.calls.length).toBe(callsBefore);
    vi.useRealTimers();
  });

  it('flushes the buffer via message.edit()', async () => {
    vi.useFakeTimers();
    const msg = mockMessage();
    const channel = mockChannel(msg);
    const h = makeHandle(channel);
    await h.start();
    await h.append({ type: 'markdown_text', content: 'final' });
    await h.stop();
    expect(msg.edit).toHaveBeenCalledWith({ content: 'final' });
    vi.useRealTimers();
  });

  it('is idempotent — second stop() is a no-op', async () => {
    vi.useFakeTimers();
    const msg = mockMessage();
    const channel = mockChannel(msg);
    const h = makeHandle(channel);
    await h.start();
    await h.append({ type: 'markdown_text', content: 'text' });
    await h.stop();
    const editCount = msg.edit.mock.calls.length;
    await h.stop();
    expect(msg.edit.mock.calls.length).toBe(editCount);
    vi.useRealTimers();
  });

  it('cancels the pending debounce timer', async () => {
    vi.useFakeTimers();
    const msg = mockMessage();
    const channel = mockChannel(msg);
    const h = makeHandle(channel);
    await h.start();
    await h.append({ type: 'markdown_text', content: 'hi' });
    // debounce timer is running
    expect(h._debounceTimer).not.toBeNull();
    await h.stop();
    expect(h._debounceTimer).toBeNull();
    vi.useRealTimers();
  });

  it('sets _stopped to true', async () => {
    vi.useFakeTimers();
    const channel = mockChannel();
    const h = makeHandle(channel);
    await h.start();
    await h.stop();
    expect(h._stopped).toBe(true);
    vi.useRealTimers();
  });

  it('stop() edit error is swallowed — does not throw', async () => {
    vi.useFakeTimers();
    const warns = [];
    const logger = { warn: (...a) => warns.push(a) };
    const msg = mockMessage();
    msg.edit.mockRejectedValue(new Error('Unknown Message'));
    const channel = mockChannel(msg);
    const h = makeHandle(channel, { logger });
    await h.start();
    await h.append({ type: 'markdown_text', content: 'text' });
    await expect(h.stop()).resolves.toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
