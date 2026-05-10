/**
 * @file slack-stream-handle.test.js
 *
 * Tests for SlackStreamHandle — native streaming path and fallback path.
 * All Slack API calls are mocked; no live network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackStreamHandle } from './slack-stream-handle.js';
import { SlackFormatter } from './slack-formatter.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function mockClient() {
  return {
    chat: {
      startStream:  vi.fn().mockResolvedValue({ ok: true, channel: 'C123', ts: '9999.111' }),
      appendStream: vi.fn().mockResolvedValue({ ok: true }),
      stopStream:   vi.fn().mockResolvedValue({ ok: true }),
      postMessage:  vi.fn().mockResolvedValue({ ok: true, ts: '1234.567' }),
      update:       vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

const formatter = new SlackFormatter();

function makeNative(clientOverride, extra = {}) {
  return new SlackStreamHandle({
    client: clientOverride ?? mockClient(),
    channel: 'C123',
    thread_ts: '1111.222',
    formatter,
    useNativeStreaming: true,
    ...extra,
  });
}

function makeFallback(clientOverride, extra = {}) {
  return new SlackStreamHandle({
    client: clientOverride ?? mockClient(),
    channel: 'C123',
    thread_ts: '1111.222',
    formatter,
    useNativeStreaming: false,
    ...extra,
  });
}

// ─── Native path ──────────────────────────────────────────────────────────────

describe('SlackStreamHandle — native: start()', () => {
  it('calls chat.startStream with channel and thread_ts', async () => {
    const client = mockClient();
    const handle = makeNative(client);
    await handle.start();
    expect(client.chat.startStream).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', thread_ts: '1111.222' })
    );
  });

  it('stores channel + ts returned by chat.startStream', async () => {
    const client = mockClient();
    const handle = makeNative(client);
    await handle.start();
    expect(handle._streamChannel).toBe('C123');
    expect(handle._streamTs).toBe('9999.111');
  });

  it('passes recipient_user_id when recipient is supplied', async () => {
    const client = mockClient();
    const handle = makeNative(client);
    await handle.start({ recipient: 'U999' });
    expect(client.chat.startStream).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_user_id: 'U999' })
    );
  });

  it('propagates error when ok:false', async () => {
    const client = mockClient();
    client.chat.startStream.mockResolvedValue({ ok: false, error: 'not_in_channel' });
    const handle = makeNative(client);
    await expect(handle.start()).rejects.toThrow('not_in_channel');
  });

  it('propagates thrown error from chat.startStream', async () => {
    const client = mockClient();
    client.chat.startStream.mockRejectedValue(new Error('network failure'));
    const handle = makeNative(client);
    await expect(handle.start()).rejects.toThrow('network failure');
  });
});

describe('SlackStreamHandle — native: append()', () => {
  it('markdown_text: calls appendStream with markdown_text chunk (formatter applied)', async () => {
    const client = mockClient();
    const handle = makeNative(client);
    await handle.start();
    await handle.append({ type: 'markdown_text', content: '**hi**' });
    expect(client.chat.appendStream).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C123',
      ts: '9999.111',
      thread_ts: '1111.222',
      markdown_text: '*hi*',
    }));
  });

  it('task_update: calls appendStream with task_update chunk', async () => {
    const client = mockClient();
    const handle = makeNative(client);
    await handle.start();
    const task = { id: 't1', title: 'my task', status: 'in_progress' };
    await handle.append({ type: 'task_update', task });
    expect(client.chat.appendStream).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C123',
      ts: '9999.111',
      thread_ts: '1111.222',
      chunks: [{ type: 'task_update', task_update: task }],
    }));
  });

  it('plan_update: calls appendStream with plan_update chunk', async () => {
    const client = mockClient();
    const handle = makeNative(client);
    await handle.start();
    const plan = { steps: ['a', 'b'] };
    await handle.append({ type: 'plan_update', plan });
    expect(client.chat.appendStream).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C123',
      ts: '9999.111',
      thread_ts: '1111.222',
      chunks: [{ type: 'plan_update', plan_update: plan }],
    }));
  });

  it('blocks: calls appendStream with blocks chunk', async () => {
    const client = mockClient();
    const handle = makeNative(client);
    await handle.start();
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }];
    await handle.append({ type: 'blocks', blocks });
    expect(client.chat.appendStream).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C123',
      ts: '9999.111',
      thread_ts: '1111.222',
      chunks: [{ type: 'blocks', blocks }],
    }));
  });

  it('unknown chunk type: logs warn, makes no API call', async () => {
    const warns = [];
    const logger = { warn: (...a) => warns.push(a) };
    const client = mockClient();
    const handle = makeNative(client, { logger });
    await handle.start();
    await handle.append({ type: 'unknown_thing', data: 'x' });
    expect(client.chat.appendStream).not.toHaveBeenCalled();
    expect(warns.length).toBeGreaterThan(0);
  });

  it('appendStream API error is caught and logged — does not throw', async () => {
    const warns = [];
    const logger = { warn: (...a) => warns.push(a) };
    const client = mockClient();
    client.chat.appendStream.mockRejectedValue(new Error('rate_limited'));
    const handle = makeNative(client, { logger });
    await handle.start();
    await expect(handle.append({ type: 'markdown_text', content: 'hello' })).resolves.toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
  });
});

describe('SlackStreamHandle — native: stop()', () => {
  it('calls chat.stopStream with channel + ts', async () => {
    const client = mockClient();
    const handle = makeNative(client);
    await handle.start();
    await handle.stop();
    expect(client.chat.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', ts: '9999.111' })
    );
  });

  it('passes blocks to stopStream when provided', async () => {
    const client = mockClient();
    const handle = makeNative(client);
    await handle.start();
    const footer = [{ type: 'section', text: { type: 'mrkdwn', text: 'footer' } }];
    await handle.stop({ blocks: footer });
    expect(client.chat.stopStream).toHaveBeenCalledWith(
      expect.objectContaining({ blocks: footer })
    );
  });

  it('is idempotent — second stop() is a no-op', async () => {
    const client = mockClient();
    const handle = makeNative(client);
    await handle.start();
    await handle.stop();
    await handle.stop();
    expect(client.chat.stopStream).toHaveBeenCalledTimes(1);
  });

  it('stopStream API error is caught and logged — does not throw', async () => {
    const warns = [];
    const logger = { warn: (...a) => warns.push(a) };
    const client = mockClient();
    client.chat.stopStream.mockRejectedValue(new Error('channel_not_found'));
    const handle = makeNative(client, { logger });
    await handle.start();
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
  });
});

// ─── Fallback path ────────────────────────────────────────────────────────────

describe('SlackStreamHandle — fallback: start()', () => {
  it('calls chat.postMessage with channel and thread_ts', async () => {
    const client = mockClient();
    const handle = makeFallback(client);
    await handle.start();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C123', thread_ts: '1111.222' })
    );
  });

  it('stores ts returned by chat.postMessage', async () => {
    const client = mockClient();
    const handle = makeFallback(client);
    await handle.start();
    expect(handle._ts).toBe('1234.567');
  });

  it('propagates error when postMessage ok:false', async () => {
    const client = mockClient();
    client.chat.postMessage.mockResolvedValue({ ok: false, error: 'no_permission' });
    const handle = makeFallback(client);
    await expect(handle.start()).rejects.toThrow('no_permission');
  });
});

describe('SlackStreamHandle — fallback: append()', () => {
  it('markdown_text accumulates buffer and calls chat.update', async () => {
    const client = mockClient();
    const handle = makeFallback(client);
    await handle.start();
    await handle.append({ type: 'markdown_text', content: 'hello ' });
    await handle.append({ type: 'markdown_text', content: 'world' });
    // Last call should have full text
    const lastCall = client.chat.update.mock.calls.at(-1)[0];
    expect(lastCall.text).toBe('hello world');
    expect(lastCall.channel).toBe('C123');
    expect(lastCall.ts).toBe('1234.567');
  });

  it('blocks chunk is queued, NOT immediately sent via update', async () => {
    const client = mockClient();
    const handle = makeFallback(client);
    await handle.start();
    const initialUpdateCount = client.chat.update.mock.calls.length;
    await handle.append({ type: 'blocks', blocks: [{ type: 'section' }] });
    // No extra update call triggered by blocks append
    expect(client.chat.update.mock.calls.length).toBe(initialUpdateCount);
  });

  it('chat.update error is caught and logged — does not throw', async () => {
    const warns = [];
    const logger = { warn: (...a) => warns.push(a) };
    const client = mockClient();
    client.chat.update.mockRejectedValue(new Error('message_not_found'));
    const handle = makeFallback(client, { logger });
    await handle.start();
    await expect(handle.append({ type: 'markdown_text', content: 'hi' })).resolves.toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
  });

  it('unknown chunk type logs warn, makes no API call', async () => {
    const warns = [];
    const logger = { warn: (...a) => warns.push(a) };
    const client = mockClient();
    const handle = makeFallback(client, { logger });
    await handle.start();
    await handle.append({ type: 'task_update', task: {} });
    // No update call (task_update not renderable in fallback)
    expect(client.chat.update).not.toHaveBeenCalled();
    expect(warns.length).toBeGreaterThan(0);
  });
});

describe('SlackStreamHandle — fallback: stop()', () => {
  it('sends final update with accumulated text', async () => {
    const client = mockClient();
    const handle = makeFallback(client);
    await handle.start();
    await handle.append({ type: 'markdown_text', content: 'final text' });
    await handle.stop();
    const lastCall = client.chat.update.mock.calls.at(-1)[0];
    expect(lastCall.text).toBe('final text');
  });

  it('sends queued blocks in the final stop() update', async () => {
    const client = mockClient();
    const handle = makeFallback(client);
    await handle.start();
    const queuedBlocks = [{ type: 'divider' }];
    await handle.append({ type: 'blocks', blocks: queuedBlocks });
    await handle.stop();
    const lastCall = client.chat.update.mock.calls.at(-1)[0];
    expect(lastCall.blocks).toEqual(expect.arrayContaining([{ type: 'divider' }]));
  });

  it('merges queued blocks with caller-supplied blocks in stop()', async () => {
    const client = mockClient();
    const handle = makeFallback(client);
    await handle.start();
    await handle.append({ type: 'blocks', blocks: [{ type: 'divider' }] });
    const footer = [{ type: 'section', text: { type: 'mrkdwn', text: 'footer' } }];
    await handle.stop({ blocks: footer });
    const lastCall = client.chat.update.mock.calls.at(-1)[0];
    expect(lastCall.blocks.length).toBe(2);
  });

  it('is idempotent — second stop() is a no-op', async () => {
    const client = mockClient();
    const handle = makeFallback(client);
    await handle.start();
    await handle.stop();
    const countAfterFirst = client.chat.update.mock.calls.length;
    await handle.stop();
    expect(client.chat.update.mock.calls.length).toBe(countAfterFirst);
  });
});

describe('SlackStreamHandle — SUPPORTED_CHUNK_TYPES static property', () => {
  it('lists the four expected chunk types', () => {
    expect(SlackStreamHandle.SUPPORTED_CHUNK_TYPES).toEqual(
      expect.arrayContaining(['markdown_text', 'task_update', 'plan_update', 'blocks'])
    );
    expect(SlackStreamHandle.SUPPORTED_CHUNK_TYPES).toHaveLength(4);
  });
});
