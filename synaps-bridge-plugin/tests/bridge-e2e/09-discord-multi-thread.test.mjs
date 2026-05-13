/**
 * @file 09-discord-multi-thread.test.mjs
 *
 * Integration test: Two different channels → isolated sessions.
 *
 * Simulates messages from two distinct channels and verifies that
 * sessionRouter.getOrCreateSession receives two different session keys
 * (source:conversation:thread pairs).
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordAdapter } from '../../bridge/sources/discord/index.js';
import { makeDiscordClientFactory } from './fake-discord-client.mjs';
import { sessionKey } from '../../bridge/core/helpers.js';

// ── fakes ─────────────────────────────────────────────────────────────────────

function makeFakeRpc() {
  const rpc = new EventEmitter();
  rpc.prompt = vi.fn(async () => {
    await Promise.resolve();
    rpc.emit('message_update', { type: 'text_delta', delta: 'ack' });
    rpc.emit('agent_end', { usage: {} });
  });
  rpc.setModel = vi.fn(async () => {});
  return rpc;
}

/**
 * A sessionRouter that creates a fresh rpc per unique key — so each session
 * is isolated just like the real SessionRouter.
 */
function makeFakeSessionRouter() {
  const sessions = new Map();
  return {
    _sessions: sessions,
    getOrCreateSession: vi.fn(async ({ source, conversation, thread, model }) => {
      const key = sessionKey({ source, conversation, thread: thread ?? '' });
      if (!sessions.has(key)) {
        sessions.set(key, makeFakeRpc());
      }
      return sessions.get(key);
    }),
    recordActivity: vi.fn(async () => {}),
    liveSessions:   vi.fn(() => []),
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('09 — Discord multi-channel isolation', () => {
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

  it('two different channels produce two distinct session keys', async () => {
    const sessionRouter = makeFakeSessionRouter();

    adapter = new DiscordAdapter({
      discordClientFactory: async () => fakeClient,
      sessionRouter,
      auth: { botToken: 'fake-token' },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await adapter.start();

    // Message from channel A.
    await fakeClient.simulateMessage({
      content: 'hello from channel A',
      channel: { id: 'ch-aaa', type: 0, parentId: null },
      guildId: 'guild1',
    });

    // Message from channel B.
    await fakeClient.simulateMessage({
      content: 'hello from channel B',
      channel: { id: 'ch-bbb', type: 0, parentId: null },
      guildId: 'guild1',
    });

    // Two distinct getOrCreateSession calls.
    expect(sessionRouter.getOrCreateSession).toHaveBeenCalledTimes(2);

    const calls = sessionRouter.getOrCreateSession.mock.calls;
    const keyA = sessionKey({ source: 'discord', conversation: calls[0][0].conversation, thread: calls[0][0].thread ?? '' });
    const keyB = sessionKey({ source: 'discord', conversation: calls[1][0].conversation, thread: calls[1][0].thread ?? '' });

    // Keys are distinct.
    expect(keyA).not.toBe(keyB);

    // Both are scoped to 'discord'.
    expect(keyA).toMatch(/^discord:/);
    expect(keyB).toMatch(/^discord:/);

    // The two sessions stored in the router are different rpc instances.
    const storedSessions = Array.from(sessionRouter._sessions.values());
    expect(storedSessions).toHaveLength(2);
    expect(storedSessions[0]).not.toBe(storedSessions[1]);
  });

  it('same channel twice reuses the same session', async () => {
    const sessionRouter = makeFakeSessionRouter();

    adapter = new DiscordAdapter({
      discordClientFactory: async () => fakeClient,
      sessionRouter,
      auth: { botToken: 'fake-token' },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    await adapter.start();

    await fakeClient.simulateMessage({
      content: 'first message',
      channel: { id: 'ch-same', type: 0, parentId: null },
      guildId: 'guild1',
    });

    await fakeClient.simulateMessage({
      content: 'second message',
      channel: { id: 'ch-same', type: 0, parentId: null },
      guildId: 'guild1',
    });

    expect(sessionRouter.getOrCreateSession).toHaveBeenCalledTimes(2);
    // Still only one session created (same key → reuse).
    expect(sessionRouter._sessions.size).toBe(1);
  });
});
