/**
 * @file 08-discord-dm-response.test.mjs
 *
 * Integration test: Discord DM → response without needing a mention.
 *
 * channel.type = 1 (DM) bypasses the mention check in _onMessageCreate.
 * Verifies the message still routes through _handleUserMessage and rpc.prompt
 * is called.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordAdapter } from '../../bridge/sources/discord/index.js';
import { makeDiscordClientFactory } from './fake-discord-client.mjs';

// ── fakes ─────────────────────────────────────────────────────────────────────

function makeFakeRpc() {
  const rpc = new EventEmitter();
  rpc.prompt = vi.fn(async (_text) => {
    await Promise.resolve();
    rpc.emit('message_update', { type: 'text_delta', delta: 'ack' });
    rpc.emit('agent_end', { usage: {} });
  });
  rpc.setModel = vi.fn(async () => {});
  return rpc;
}

function makeFakeSessionRouter(rpc) {
  return {
    getOrCreateSession: vi.fn(async () => rpc),
    recordActivity:     vi.fn(async () => {}),
    liveSessions:       vi.fn(() => []),
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('08 — Discord DM response', () => {
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

  it('DM (channel.type=1) routes to _handleUserMessage without mention', async () => {
    const rpc = makeFakeRpc();
    const sessionRouter = makeFakeSessionRouter(rpc);

    adapter = new DiscordAdapter({
      discordClientFactory: async () => fakeClient,
      sessionRouter,
      auth: { botToken: 'fake-token' },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await adapter.start();

    // DM: no guild, mentions.has returns false, but type=1 means it's routed anyway.
    await fakeClient.simulateMessage({
      content: 'hello from DM',
      channel: {
        id: 'dm-channel-001',
        type: 1,  // DM
        parentId: null,
      },
      // Mention returns false — DMs don't need a mention.
      mentions: { has: vi.fn().mockReturnValue(false) },
      guild: null,
      guildId: null,
    });

    // rpc.prompt must have been called — proves _handleUserMessage ran.
    expect(rpc.prompt).toHaveBeenCalledTimes(1);

    // sessionRouter was asked for a session with source 'discord'.
    expect(sessionRouter.getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'discord' }),
    );
  });

  it('bot message is ignored (no prompt called)', async () => {
    const rpc = makeFakeRpc();
    const sessionRouter = makeFakeSessionRouter(rpc);

    adapter = new DiscordAdapter({
      discordClientFactory: async () => fakeClient,
      sessionRouter,
      auth: { botToken: 'fake-token' },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await adapter.start();

    // author.bot = true → adapter ignores immediately.
    await fakeClient.simulateMessage({
      author: { id: 'other-bot', bot: true },
      content: 'I am a bot',
      channel: { id: 'ch1', type: 1, parentId: null },
    });

    expect(rpc.prompt).not.toHaveBeenCalled();
  });
});
