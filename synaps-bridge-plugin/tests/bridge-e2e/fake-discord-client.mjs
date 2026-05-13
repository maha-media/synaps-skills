/**
 * @file fake-discord-client.mjs
 *
 * Fake discord.js Client for Discord adapter integration tests.
 *
 * Mirrors the discord.js Client API surface used by bridge/sources/discord/index.js:
 *   client.on(event, handler)
 *   client.login(token)   → resolves, fires 'ready'
 *   client.destroy()      → no-op
 *   client.user           → { id, tag }
 *   client.options        → { intents: { bitfield } }
 *
 * simulateMessage(overrides) fires the messageCreate handler with a fake Message.
 * The last built message is stored on fakeClient.lastMessage for test assertions.
 */

import { vi } from 'vitest';

export class FakeDiscordClient {
  constructor() {
    /** @type {Map<string, Function>} */
    this._handlers = new Map();

    this.user = { id: 'bot123', tag: 'TestBot#0001' };

    // bitfield includes MessageContent intent (1 << 15)
    this.options = { intents: { bitfield: 1 << 15 } };

    /** @type {object|null} Last message object built by simulateMessage */
    this.lastMessage = null;
  }

  on(event, handler) {
    this._handlers.set(event, handler);
  }

  async login(_token) {
    const ready = this._handlers.get('ready');
    if (ready) ready(this);
  }

  async destroy() { /* no-op */ }

  /**
   * Build a fake Message and fire the messageCreate handler.
   * Stores the built message on this.lastMessage.
   *
   * @param {object} [overrides]
   * @returns {Promise<void>}
   */
  async simulateMessage(overrides = {}) {
    const defaultChannel = {
      id: 'ch789',
      type: 0,  // GUILD_TEXT
      send: vi.fn().mockResolvedValue({
        edit: vi.fn().mockResolvedValue(undefined),
        id: 'msg1',
      }),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      parentId: null,
    };

    const channel = overrides.channel
      ? { ...defaultChannel, ...overrides.channel }
      : defaultChannel;

    const message = {
      author: { id: 'user456', bot: false },
      content: 'hello',
      mentions: { has: vi.fn().mockReturnValue(true) },  // bot mentioned by default
      attachments: new Map(),
      guild: { id: 'guild1' },
      guildId: 'guild1',
      ...overrides,
      channel,
    };

    this.lastMessage = message;

    const handler = this._handlers.get('messageCreate');
    if (!handler) throw new Error('FakeDiscordClient: no messageCreate handler registered');
    await handler(message);
  }
}

/**
 * Returns a discordClientFactory (async fn → FakeDiscordClient) and the client itself.
 * @returns {{ factory: Function, fakeClient: FakeDiscordClient }}
 */
export function makeDiscordClientFactory() {
  const fakeClient = new FakeDiscordClient();
  const factory = async () => fakeClient;
  return { factory, fakeClient };
}
