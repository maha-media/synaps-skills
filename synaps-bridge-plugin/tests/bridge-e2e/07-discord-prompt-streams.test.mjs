/**
 * @file 07-discord-prompt-streams.test.mjs
 *
 * Integration test: Discord @-mention → response via edit-in-place.
 *
 * Wires DiscordAdapter directly with:
 *   - FakeDiscordClient (no real discord.js)
 *   - Fake sessionRouter whose rpc emits text_delta + agent_end
 *
 * Asserts:
 *   1. channel.send('⏳') called — placeholder posted
 *   2. rpc.prompt called with the message text
 *   3. message.edit called with the response text
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordAdapter } from '../../bridge/sources/discord/index.js';
import { makeDiscordClientFactory } from './fake-discord-client.mjs';

// ── fake rpc ──────────────────────────────────────────────────────────────────

/**
 * Minimal rpc stub: EventEmitter + prompt() method.
 * When prompt() is called it emits text_delta events then agent_end,
 * mirroring what SynapsRpc does via its child process.
 */
function makeFakeRpc(responseText = 'Hello, world!') {
  const rpc = new EventEmitter();
  rpc.prompt = vi.fn(async (_text, _attachments) => {
    // Emit in a microtask so listeners registered by proxy.start() are in place.
    await Promise.resolve();
    rpc.emit('message_update', { type: 'text_delta', delta: responseText });
    rpc.emit('agent_end', { usage: {} });
  });
  rpc.setModel = vi.fn(async () => {});
  return rpc;
}

// ── fake sessionRouter ────────────────────────────────────────────────────────

function makeFakeSessionRouter(rpc) {
  return {
    getOrCreateSession: vi.fn(async () => rpc),
    recordActivity:     vi.fn(async () => {}),
    liveSessions:       vi.fn(() => []),
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('07 — Discord prompt streams text', () => {
  let adapter, fakeClient;

  beforeEach(() => {
    ({ fakeClient } = makeDiscordClientFactory());
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.stop().catch(() => {});
      adapter = null;
    }
  });

  it('mention → placeholder sent, rpc.prompt called, message.edit with response', async () => {
    const rpc = makeFakeRpc('Hello, world!');
    const sessionRouter = makeFakeSessionRouter(rpc);

    adapter = new DiscordAdapter({
      discordClientFactory: async () => fakeClient,
      sessionRouter,
      auth: { botToken: 'fake-token' },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await adapter.start();

    // Simulate a guild mention with "hello" content.
    await fakeClient.simulateMessage({ content: 'hello bot' });

    const msg = fakeClient.lastMessage;

    // 1. Placeholder posted.
    expect(msg.channel.send).toHaveBeenCalledWith('⏳');

    // 2. rpc.prompt called with the stripped text.
    expect(rpc.prompt).toHaveBeenCalledTimes(1);
    const [promptedText] = rpc.prompt.mock.calls[0];
    expect(typeof promptedText).toBe('string');

    // 3. message.edit called with the response.
    const sentMsg = await msg.channel.send.mock.results[0].value;
    expect(sentMsg.edit).toHaveBeenCalled();
    const lastEditArg = sentMsg.edit.mock.calls.at(-1)[0];
    const editContent = typeof lastEditArg === 'string'
      ? lastEditArg
      : lastEditArg?.content ?? '';
    expect(editContent).toContain('Hello, world!');
  });
});
