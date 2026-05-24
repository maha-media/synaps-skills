/**
 * @file index.test.js
 *
 * Smoke tests for the DiscordAdapter.  No real discord.js Client is created —
 * the Client is injected via `discordClientFactory`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { DiscordAdapter } from './index.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeClient() {
  const handlers = new Map();
  return {
    handlers,
    user: { id: 'bot123', tag: 'TestBot#0001', username: 'TestBot' },
    options: { intents: 1 << 15 }, // MESSAGE_CONTENT intent enabled
    on: vi.fn((name, fn) => handlers.set(name, fn)),
    login: vi.fn().mockResolvedValue('ok'),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRouter() {
  const rpc = new EventEmitter();
  rpc.prompt = vi.fn().mockResolvedValue({ ok: true });
  rpc.setModel = vi.fn().mockResolvedValue({ ok: true });
  rpc.shutdown = vi.fn().mockResolvedValue(undefined);
  return {
    rpc,
    getOrCreateSession: vi.fn().mockResolvedValue(rpc),
    recordActivity: vi.fn().mockResolvedValue(undefined),
  };
}

function buildAdapter(overrides = {}) {
  const client = makeClient();
  const router = makeRouter();
  const factory = vi.fn().mockResolvedValue(client);
  const adapter = new DiscordAdapter({
    sessionRouter: router,
    auth: { botToken: 'discord-test-token' },
    discordClientFactory: factory,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    ...overrides,
  });
  return { adapter, client, router, factory };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('DiscordAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets source to "discord"', () => {
    const { adapter } = buildAdapter();
    expect(adapter.source).toBe('discord');
  });

  it('uses DISCORD_CAPABILITIES by default', () => {
    const { adapter } = buildAdapter();
    expect(adapter.capabilities.threading).toBe(true);
    expect(adapter.capabilities.files).toBe(true);
    expect(adapter.capabilities.streaming).toBe(false);
  });

  it('default discordClientFactory throws (must be injected)', async () => {
    const adapter = new DiscordAdapter({
      sessionRouter: makeRouter(),
      auth: { botToken: 'x' },
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    await expect(adapter.start()).rejects.toThrow(/discord\.js Client not available/);
  });

  it('start() builds a client and calls login with the bot token', async () => {
    const { adapter, client, factory } = buildAdapter();
    await adapter.start();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(client.login).toHaveBeenCalledWith('discord-test-token');
    expect(client.on).toHaveBeenCalledWith('ready', expect.any(Function));
    expect(client.on).toHaveBeenCalledWith('messageCreate', expect.any(Function));
  });

  it('stop() calls client.destroy()', async () => {
    const { adapter, client } = buildAdapter();
    await adapter.start();
    await adapter.stop();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it('stop() is a no-op when never started', async () => {
    const { adapter, client } = buildAdapter();
    await adapter.stop();
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it('ignores messages from bots (bot-loop prevention)', async () => {
    const { adapter, client, router } = buildAdapter();
    await adapter.start();
    const handler = client.handlers.get('messageCreate');
    expect(typeof handler).toBe('function');

    await handler({
      author: { bot: true, id: 'someBot' },
      channel: { id: 'C1', type: 1, send: vi.fn() },
      content: 'hello',
      mentions: { has: () => true },
      attachments: [],
    });

    expect(router.getOrCreateSession).not.toHaveBeenCalled();
  });

  it('ready handler warns when MessageContent intent is missing', async () => {
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const client = makeClient();
    client.options.intents = 0;
    const factory = vi.fn().mockResolvedValue(client);
    const adapter = new DiscordAdapter({
      sessionRouter: makeRouter(),
      auth: { botToken: 'x' },
      discordClientFactory: factory,
      logger,
    });
    await adapter.start();
    const readyHandler = client.handlers.get('ready');
    readyHandler();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('MessageContent intent'),
    );
  });
});
