/**
 * @file index.test.js
 *
 * Tests for SlackAdapter and bootSlackAdapter.
 * No live Bolt connections; the Bolt App is fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SlackAdapter, bootSlackAdapter } from './index.js';
import { SLACK_CAPABILITIES } from './slack-capabilities.js';

// ─── mock factory helpers ─────────────────────────────────────────────────────

/**
 * Build a mock Bolt App that records registered handlers.
 */
function mockBoltApp() {
  const handlers = { events: new Map(), actions: new Map(), messages: [] };
  const app = {
    handlers,
    event: vi.fn((name, fn) => handlers.events.set(name, fn)),
    action: vi.fn((name, fn) => handlers.actions.set(name, fn)),
    message: vi.fn((fn) => handlers.messages.push(fn)),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    client: {
      chat: {
        startStream:  vi.fn().mockResolvedValue({ ok: true, stream_id: 'stream_1' }),
        appendStream: vi.fn().mockResolvedValue({ ok: true }),
        stopStream:   vi.fn().mockResolvedValue({ ok: true }),
        postMessage:  vi.fn().mockResolvedValue({ ok: true, ts: '1234.567' }),
        update:       vi.fn().mockResolvedValue({ ok: true }),
      },
      assistant: {
        threads: {
          setStatus: vi.fn().mockResolvedValue({ ok: true }),
        },
      },
    },
  };
  return app;
}

/**
 * Build a mock WebClient (passed as `client` to handlers).
 */
function mockClient(extraAssistant = true) {
  const c = {
    chat: {
      startStream:  vi.fn().mockResolvedValue({ ok: true, stream_id: 'stream_1' }),
      appendStream: vi.fn().mockResolvedValue({ ok: true }),
      stopStream:   vi.fn().mockResolvedValue({ ok: true }),
      postMessage:  vi.fn().mockResolvedValue({ ok: true, ts: '1234.567' }),
      update:       vi.fn().mockResolvedValue({ ok: true }),
    },
  };
  if (extraAssistant) {
    c.assistant = {
      threads: {
        setStatus: vi.fn().mockResolvedValue({ ok: true }),
        setSuggestedPrompts: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
  }
  return c;
}

/**
 * Build a mock SessionRouter with an embedded mock SynapsRpc.
 */
function mockSessionRouter() {
  const rpc = new EventEmitter();
  rpc.prompt = vi.fn().mockResolvedValue({ ok: true });
  rpc.setModel = vi.fn().mockResolvedValue({ ok: true });
  rpc.shutdown = vi.fn().mockResolvedValue(undefined);

  const router = {
    rpc,
    getOrCreateSession: vi.fn().mockResolvedValue(rpc),
    recordActivity: vi.fn().mockResolvedValue(undefined),
  };
  return router;
}

/**
 * Build a fully-wired SlackAdapter whose Bolt App is a mock.
 * Returns { adapter, app, router, boltFactory }.
 */
function buildAdapter(overrides = {}) {
  const app = mockBoltApp();
  const router = mockSessionRouter();
  const boltFactory = vi.fn().mockReturnValue(app);

  const adapter = new SlackAdapter({
    boltAppFactory: boltFactory,
    sessionRouter: router,
    auth: { botToken: 'xoxb-test-token', appToken: 'xapp-test-token' },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    ...overrides,
  });

  return { adapter, app, router, boltFactory };
}

// ─── SlackAdapter — start / registration ─────────────────────────────────────

describe('SlackAdapter — start()', () => {
  it('calls boltAppFactory with token, appToken, socketMode:true', async () => {
    const { adapter, boltFactory } = buildAdapter();
    await adapter.start();
    expect(boltFactory).toHaveBeenCalledWith({
      token: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      socketMode: true,
    });
  });

  it('calls app.start()', async () => {
    const { adapter, app } = buildAdapter();
    await adapter.start();
    expect(app.start).toHaveBeenCalled();
  });

  it('registers handler for assistant_thread_started', async () => {
    const { adapter, app } = buildAdapter();
    await adapter.start();
    expect(app.handlers.events.has('assistant_thread_started')).toBe(true);
  });

  it('registers handler for assistant_thread_context_changed', async () => {
    const { adapter, app } = buildAdapter();
    await adapter.start();
    expect(app.handlers.events.has('assistant_thread_context_changed')).toBe(true);
  });

  it('registers handler for app_mention', async () => {
    const { adapter, app } = buildAdapter();
    await adapter.start();
    expect(app.handlers.events.has('app_mention')).toBe(true);
  });

  it('registers handler for message (DM)', async () => {
    const { adapter, app } = buildAdapter();
    await adapter.start();
    expect(app.handlers.events.has('message')).toBe(true);
  });
});

// ─── SlackAdapter — stop ──────────────────────────────────────────────────────

describe('SlackAdapter — stop()', () => {
  it('calls app.stop()', async () => {
    const { adapter, app } = buildAdapter();
    await adapter.start();
    await adapter.stop();
    expect(app.stop).toHaveBeenCalled();
  });
});

// ─── app_mention ──────────────────────────────────────────────────────────────

describe('SlackAdapter — _onAppMention', () => {
  async function invokeAppMention(adapter, app, eventOverrides = {}) {
    await adapter.start();
    const handler = app.handlers.events.get('app_mention');
    const event = {
      channel: 'C123',
      ts: '1620000000.000100',
      thread_ts: null,
      text: '<@U0BOTID> Hello world',
      user: 'U999',
      files: [],
      ...eventOverrides,
    };
    const client = mockClient();
    await handler({ event, client, ack: vi.fn() });
    return { event, client };
  }

  it('strips the leading <@BOTID> mention before routing', async () => {
    const { adapter, app, router } = buildAdapter();
    await invokeAppMention(adapter, app, {
      text: '<@U0BOTID>   Hello world',
    });
    // rpc.prompt should be called with the stripped text
    expect(router.rpc.prompt).toHaveBeenCalledWith('Hello world', []);
  });

  it('routes to router.getOrCreateSession with source:slack, conversation, and thread', async () => {
    const { adapter, app, router } = buildAdapter();
    await invokeAppMention(adapter, app, {
      channel: 'C456',
      ts: '1620000001.000100',
      thread_ts: '1620000000.000100',
      text: '<@BOT> hi',
    });
    expect(router.getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'slack',
        conversation: 'C456',
        thread: '1620000000.000100', // thread_ts takes priority
      }),
    );
  });

  it('uses ts as thread when thread_ts is absent', async () => {
    const { adapter, app, router } = buildAdapter();
    await invokeAppMention(adapter, app, {
      channel: 'C789',
      ts: '1620999999.000200',
      thread_ts: null,
      text: '<@BOT> msg',
    });
    expect(router.getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ thread: '1620999999.000200' }),
    );
  });
});

// ─── set-model: directive ─────────────────────────────────────────────────────

describe('SlackAdapter — set-model directive', () => {
  it('calls rpc.setModel before rpc.prompt when directive is present', async () => {
    const { adapter, app, router } = buildAdapter();
    await adapter.start();
    const handler = app.handlers.events.get('app_mention');
    const client = mockClient();
    await handler({
      event: {
        channel: 'C123',
        ts: '100.000',
        thread_ts: null,
        text: '<@BOT> set-model: gpt-4o\nHello AI',
        user: 'U001',
        files: [],
      },
      client,
      ack: vi.fn(),
    });
    expect(router.rpc.setModel).toHaveBeenCalledWith('gpt-4o');
    expect(router.rpc.prompt).toHaveBeenCalledWith('Hello AI', []);
  });

  it('does not call rpc.setModel when no directive is present', async () => {
    const { adapter, app, router } = buildAdapter();
    await adapter.start();
    const handler = app.handlers.events.get('app_mention');
    const client = mockClient();
    await handler({
      event: {
        channel: 'C123',
        ts: '100.001',
        thread_ts: null,
        text: '<@BOT> just a plain message',
        user: 'U001',
        files: [],
      },
      client,
      ack: vi.fn(),
    });
    expect(router.rpc.setModel).not.toHaveBeenCalled();
  });
});

// ─── message (DM) ─────────────────────────────────────────────────────────────

describe('SlackAdapter — _onMessage (DM)', () => {
  async function invokeMessage(adapter, app, eventOverrides = {}) {
    await adapter.start();
    const handler = app.handlers.events.get('message');
    const event = {
      channel: 'D123',
      ts: '1620000000.000100',
      thread_ts: null,
      text: 'Hello bot',
      user: 'U999',
      channel_type: 'im',
      files: [],
      ...eventOverrides,
    };
    const client = mockClient();
    await handler({ event, client, ack: vi.fn() });
    return { event, client };
  }

  it('skips events where bot_id is set (bot-loop prevention)', async () => {
    const { adapter, app, router } = buildAdapter();
    await invokeMessage(adapter, app, { bot_id: 'B0BOTID' });
    expect(router.rpc.prompt).not.toHaveBeenCalled();
  });

  it('skips events with subtype: bot_message', async () => {
    const { adapter, app, router } = buildAdapter();
    await invokeMessage(adapter, app, { subtype: 'bot_message' });
    expect(router.rpc.prompt).not.toHaveBeenCalled();
  });

  it('skips events that are not DMs (channel_type !== im)', async () => {
    const { adapter, app, router } = buildAdapter();
    await invokeMessage(adapter, app, { channel_type: 'channel' });
    expect(router.rpc.prompt).not.toHaveBeenCalled();
  });

  it('routes valid DM to router.getOrCreateSession', async () => {
    const { adapter, app, router } = buildAdapter();
    await invokeMessage(adapter, app, { channel: 'D456', user: 'U777' });
    expect(router.getOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'slack', conversation: 'D456' }),
    );
  });
});

// ─── file attachments ─────────────────────────────────────────────────────────

describe('SlackAdapter — file attachments', () => {
  function makeFileStore(resolvedFiles) {
    return {
      download: vi.fn().mockImplementation(({ fileMeta }) => {
        const found = resolvedFiles[fileMeta.id];
        if (found instanceof Error) return Promise.reject(found);
        return Promise.resolve(found);
      }),
    };
  }

  it('calls fileStore.download for each attached file', async () => {
    const fileStore = makeFileStore({
      F001: { path: '/tmp/a.pdf', name: 'a.pdf', mime: 'application/pdf' },
      F002: { path: '/tmp/b.png', name: 'b.png', mime: 'image/png' },
    });
    const { adapter, app, router } = buildAdapter({ fileStore });
    await adapter.start();
    const handler = app.handlers.events.get('app_mention');
    const client = mockClient();
    await handler({
      event: {
        channel: 'C123',
        ts: '200.000',
        thread_ts: null,
        text: '<@BOT> see files',
        user: 'U001',
        files: [
          { id: 'F001', name: 'a.pdf', mimetype: 'application/pdf', url_private: 'https://x', size: 100 },
          { id: 'F002', name: 'b.png', mimetype: 'image/png', url_private: 'https://y', size: 200 },
        ],
      },
      client,
      ack: vi.fn(),
    });
    expect(fileStore.download).toHaveBeenCalledTimes(2);
    expect(router.rpc.prompt).toHaveBeenCalledWith(
      'see files',
      expect.arrayContaining([
        expect.objectContaining({ path: '/tmp/a.pdf' }),
        expect.objectContaining({ path: '/tmp/b.png' }),
      ]),
    );
  });

  it('calls rpc.prompt with only the successful attachment when one download fails', async () => {
    const fileStore = makeFileStore({
      F001: { path: '/tmp/ok.pdf', name: 'ok.pdf', mime: 'application/pdf' },
      F002: new Error('download failed'),
    });
    const { adapter, app, router } = buildAdapter({ fileStore });
    await adapter.start();
    const handler = app.handlers.events.get('app_mention');
    const client = mockClient();
    await handler({
      event: {
        channel: 'C123',
        ts: '300.000',
        thread_ts: null,
        text: '<@BOT> check files',
        user: 'U001',
        files: [
          { id: 'F001', name: 'ok.pdf', mimetype: 'application/pdf', url_private: 'https://x', size: 100 },
          { id: 'F002', name: 'bad.pdf', mimetype: 'application/pdf', url_private: 'https://y', size: 200 },
        ],
      },
      client,
      ack: vi.fn(),
    });
    // Should still call prompt with the 1 successful file
    expect(router.rpc.prompt).toHaveBeenCalledWith(
      'check files',
      [expect.objectContaining({ path: '/tmp/ok.pdf' })],
    );
  });
});

// ─── _onAssistantThreadStarted ────────────────────────────────────────────────

describe('SlackAdapter — _onAssistantThreadStarted', () => {
  it('calls client.assistant.threads.setSuggestedPrompts with channel_id, thread_ts, and prompts', async () => {
    const { adapter, app } = buildAdapter();
    await adapter.start();
    const handler = app.handlers.events.get('assistant_thread_started');
    const client = mockClient(true);
    await handler({
      event: {
        assistant_thread: {
          user_id: 'U001',
          channel_id: 'C123',
          thread_ts: '1620000000.000100',
        },
      },
      client,
      ack: vi.fn(),
    });
    expect(client.assistant.threads.setSuggestedPrompts).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'C123',
        thread_ts: '1620000000.000100',
        prompts: expect.any(Array),
      }),
    );
  });

  it('does NOT call setStatus on thread open (would hang the AI-app UI)', async () => {
    const { adapter, app } = buildAdapter();
    await adapter.start();
    const handler = app.handlers.events.get('assistant_thread_started');
    const client = mockClient(true);
    await handler({
      event: {
        assistant_thread: {
          user_id: 'U001',
          channel_id: 'C123',
          thread_ts: '1620000000.000100',
        },
      },
      client,
      ack: vi.fn(),
    });
    expect(client.assistant.threads.setStatus).not.toHaveBeenCalled();
  });

  it('is silent when client.assistant is undefined (no AI-app methods)', async () => {
    const { adapter, app } = buildAdapter();
    await adapter.start();
    const handler = app.handlers.events.get('assistant_thread_started');
    const client = mockClient(false); // no .assistant property
    // Should not throw
    await expect(
      handler({
        event: {
          assistant_thread: {
            user_id: 'U001',
            channel_id: 'C123',
            thread_ts: '1620000000.000100',
          },
        },
        client,
        ack: vi.fn(),
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── BotGate denial ───────────────────────────────────────────────────────────

describe('SlackAdapter — BotGate', () => {
  it('does not call rpc.prompt when botGate.evaluate returns { allowed: false }', async () => {
    const botGate = {
      evaluate: vi.fn().mockReturnValue({ allowed: false, reason: 'blocked' }),
      recordTurn: vi.fn(),
    };
    const { adapter, app, router } = buildAdapter({ botGate });
    await adapter.start();
    const handler = app.handlers.events.get('app_mention');
    const client = mockClient();
    await handler({
      event: {
        channel: 'C123',
        ts: '400.000',
        thread_ts: null,
        text: '<@BOT> blocked message',
        user: 'U001',
        files: [],
      },
      client,
      ack: vi.fn(),
    });
    expect(router.rpc.prompt).not.toHaveBeenCalled();
  });

  it('calls botGate.recordTurn after a successful prompt', async () => {
    const botGate = {
      evaluate: vi.fn().mockReturnValue({ allowed: true }),
      recordTurn: vi.fn(),
    };
    const { adapter, app } = buildAdapter({ botGate });
    await adapter.start();
    const handler = app.handlers.events.get('app_mention');
    const client = mockClient();
    await handler({
      event: {
        channel: 'C123',
        ts: '500.000',
        thread_ts: null,
        text: '<@BOT> allowed message',
        user: 'U001',
        files: [],
      },
      client,
      ack: vi.fn(),
    });
    expect(botGate.recordTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'slack',
        conversation: 'C123',
      }),
    );
  });
});

// ─── Token redaction in logs ──────────────────────────────────────────────────

describe('SlackAdapter — token redaction in logs', () => {
  it('never logs a raw xoxb- token even when an error includes it', async () => {
    const warnSpy = vi.fn();
    const logger = { warn: warnSpy, info: vi.fn(), error: vi.fn() };

    // Build a router whose getOrCreateSession throws an error containing the token.
    const router = {
      getOrCreateSession: vi.fn().mockRejectedValue(
        new Error('failed with token xoxb-super-secret in message'),
      ),
      recordActivity: vi.fn(),
    };

    const adapter = new SlackAdapter({
      boltAppFactory: vi.fn().mockReturnValue(mockBoltApp()),
      sessionRouter: router,
      auth: { botToken: 'xoxb-super-secret', appToken: 'xapp-test' },
      logger,
    });
    await adapter.start();
    // Manually invoke _handleUserMessage to trigger the error path
    const client = mockClient();
    await adapter._handleUserMessage({
      conversation: 'C123',
      thread: '100.000',
      text: 'hello',
      user: 'U001',
      files: [],
      client,
    });

    for (const call of warnSpy.mock.calls) {
      const msg = call.join(' ');
      expect(msg).not.toContain('xoxb-super-secret');
    }
  });
});

// ─── bootSlackAdapter ─────────────────────────────────────────────────────────

describe('bootSlackAdapter', () => {
  it('happy path: returns a started SlackAdapter', async () => {
    const app = mockBoltApp();
    const router = mockSessionRouter();
    const boltFactory = vi.fn().mockReturnValue(app);
    const env = {
      SLACK_BOT_TOKEN: 'xoxb-boot-test',
      SLACK_APP_TOKEN: 'xapp-boot-test',
    };

    const adapter = await bootSlackAdapter({
      env,
      sessionRouter: router,
      boltAppFactory: boltFactory,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    expect(adapter).toBeInstanceOf(SlackAdapter);
    expect(app.start).toHaveBeenCalled();
  });

  it('throws when SLACK_BOT_TOKEN is missing from env', async () => {
    const router = mockSessionRouter();
    const env = { SLACK_APP_TOKEN: 'xapp-test' };

    await expect(
      bootSlackAdapter({
        env,
        sessionRouter: router,
        boltAppFactory: vi.fn(),
      }),
    ).rejects.toThrow(/SLACK_BOT_TOKEN/);
  });
});

// ─── Memory gateway hooks ─────────────────────────────────────────────────────

import { NoopMemoryGateway } from '../../core/memory-gateway.js';

/**
 * Helper: flush all pending microtasks + one macrotask tick so that
 * fire-and-forget store() promises settle before we assert on them.
 */
async function flushAsync() {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Build a memory-enabled adapter and helpers for driving a full message flow.
 *
 * The router's rpc.prompt mock emits 'agent_end' from the rpc EventEmitter
 * before resolving, which drives the StreamingProxy's internal handler and
 * ultimately fires proxy.emit('agent_end', { final_text }).
 *
 * @param {object} memoryGateway
 * @param {object} [extraOverrides]
 */
function buildMemoryAdapter(memoryGateway, extraOverrides = {}) {
  const app = mockBoltApp();
  const router = mockSessionRouter();
  const boltFactory = vi.fn().mockReturnValue(app);

  // Make rpc.prompt emit agent_end from the rpc emitter before resolving.
  // The StreamingProxy listens on rpc.on('agent_end', ...) and forwards it
  // to proxy.emit('agent_end', { final_text: <accumulated> }) after draining.
  router.rpc.prompt = vi.fn().mockImplementation(async () => {
    // Emit agent_end from rpc so the proxy picks it up via its listener.
    router.rpc.emit('agent_end', { usage: null });
    return { ok: true };
  });

  const adapter = new SlackAdapter({
    boltAppFactory: boltFactory,
    sessionRouter: router,
    auth: { botToken: 'xoxb-test-token', appToken: 'xapp-test-token' },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    memoryGateway,
    ...extraOverrides,
  });

  return { adapter, app, router, boltFactory };
}

/**
 * Invoke the app_mention handler through a started adapter.
 */
async function invokeWithMemory(adapter, app, eventOverrides = {}) {
  await adapter.start();
  const handler = app.handlers.events.get('app_mention');
  const event = {
    channel: 'C123',
    ts: '1620000000.000100',
    thread_ts: null,
    text: '<@U0BOTID> hello',
    user: 'U123',
    files: [],
    ...eventOverrides,
  };
  const client = mockClient();
  await handler({ event, client, ack: vi.fn() });
  return { event, client };
}

describe('SlackAdapter — memory gateway: optional (null)', () => {
  it('adapter works exactly as before when memoryGateway not provided', async () => {
    // Use the standard buildAdapter (no memoryGateway)
    const { adapter, app, router } = buildAdapter();
    await adapter.start();
    const handler = app.handlers.events.get('app_mention');
    const client = mockClient();
    await handler({
      event: {
        channel: 'C123',
        ts: '100.000',
        thread_ts: null,
        text: '<@BOT> hello world',
        user: 'U001',
        files: [],
      },
      client,
      ack: vi.fn(),
    });
    // Original body is unchanged; no memory calls
    expect(router.rpc.prompt).toHaveBeenCalledWith('hello world', []);
  });

  it('memoryGateway null: recall and store are never invoked', async () => {
    const recall = vi.fn();
    const store = vi.fn();
    // Build WITHOUT memoryGateway (null by default)
    const { adapter, app, router } = buildAdapter();
    await adapter.start();
    const handler = app.handlers.events.get('app_mention');
    const client = mockClient();
    await handler({
      event: {
        channel: 'C123',
        ts: '100.100',
        thread_ts: null,
        text: '<@BOT> hello',
        user: 'U001',
        files: [],
      },
      client,
      ack: vi.fn(),
    });
    expect(recall).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(router.rpc.prompt).toHaveBeenCalledWith('hello', []);
  });
});

describe('SlackAdapter — memory gateway: recall', () => {
  it('recall is called with the resolved synapsUserId and message body', async () => {
    const memoryGateway = {
      recall: vi.fn().mockResolvedValue(null),
      store: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { adapter, app } = buildMemoryAdapter(memoryGateway);
    await invokeWithMemory(adapter, app, {
      text: '<@U0BOTID> hello',
      user: 'U123',
    });
    // Phase 2 v0: synapsUserId === slackUserId
    expect(memoryGateway.recall).toHaveBeenCalledWith('U123', 'hello');
  });

  it('recall result is prepended to the prompt body', async () => {
    const memoryGateway = {
      recall: vi.fn().mockResolvedValue('- you said X yesterday\n- you like Y'),
      store: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { adapter, app, router } = buildMemoryAdapter(memoryGateway);
    await invokeWithMemory(adapter, app, {
      text: '<@U0BOTID> hello',
      user: 'U123',
    });
    const [calledBody] = router.rpc.prompt.mock.calls[0];
    expect(calledBody).toMatch(/^\[memory_recall\]\n.*\n\[\/memory_recall\]\n\nhello$/s);
    expect(calledBody).toContain('- you said X yesterday');
    expect(calledBody).toContain('- you like Y');
  });

  it('recall returns null → no augmentation, prompt called with original body', async () => {
    const memoryGateway = {
      recall: vi.fn().mockResolvedValue(null),
      store: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { adapter, app, router } = buildMemoryAdapter(memoryGateway);
    await invokeWithMemory(adapter, app, {
      text: '<@U0BOTID> hello',
      user: 'U123',
    });
    expect(router.rpc.prompt).toHaveBeenCalledWith('hello', []);
  });

  it('recall returns empty string → no augmentation, prompt called with original body', async () => {
    const memoryGateway = {
      recall: vi.fn().mockResolvedValue(''),
      store: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { adapter, app, router } = buildMemoryAdapter(memoryGateway);
    await invokeWithMemory(adapter, app, {
      text: '<@U0BOTID> hello',
      user: 'U123',
    });
    expect(router.rpc.prompt).toHaveBeenCalledWith('hello', []);
  });

  it('recall throws → defensive guard, prompt called with unmodified body', async () => {
    const warnSpy = vi.fn();
    const memoryGateway = {
      recall: vi.fn().mockRejectedValue(new Error('boom')),
      store: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { adapter, app, router } = buildMemoryAdapter(memoryGateway, {
      logger: { warn: warnSpy, info: vi.fn(), error: vi.fn() },
    });
    // Should not throw
    await expect(invokeWithMemory(adapter, app, {
      text: '<@U0BOTID> hello',
      user: 'U123',
    })).resolves.not.toThrow();
    // Prompt still called with original body
    expect(router.rpc.prompt).toHaveBeenCalledWith('hello', []);
    // Guard warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/memory recall guard hit/),
    );
  });
});

describe('SlackAdapter — memory gateway: store on agent_end', () => {
  it('store is called on agent_end with final_text and metadata', async () => {
    const memoryGateway = {
      recall: vi.fn().mockResolvedValue(null),
      store: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { adapter, app, router } = buildMemoryAdapter(memoryGateway);

    // Emit text_delta from rpc before agent_end so final_text is non-empty.
    const originalPrompt = router.rpc.prompt;
    router.rpc.prompt = vi.fn().mockImplementation(async () => {
      router.rpc.emit('message_update', { type: 'text_delta', delta: 'goodbye' });
      router.rpc.emit('agent_end', { usage: null });
      return { ok: true };
    });

    await invokeWithMemory(adapter, app, {
      channel: 'C999',
      ts: '200.000',
      thread_ts: '200.000',
      text: '<@U0BOTID> hi',
      user: 'U123',
    });
    await flushAsync();

    expect(memoryGateway.store).toHaveBeenCalledWith(
      'U123',
      'goodbye',
      expect.objectContaining({
        source: 'slack',
        category: 'conversation',
      }),
    );
  });

  it('store NOT called when agent_end has empty final_text', async () => {
    const memoryGateway = {
      recall: vi.fn().mockResolvedValue(null),
      store: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { adapter, app } = buildMemoryAdapter(memoryGateway);
    // No text_delta emitted → accumulated text is '' → final_text is ''
    await invokeWithMemory(adapter, app, {
      text: '<@U0BOTID> hello',
      user: 'U123',
    });
    await flushAsync();
    expect(memoryGateway.store).not.toHaveBeenCalled();
  });

  it('store error is swallowed — no unhandled rejection', async () => {
    const memoryGateway = {
      recall: vi.fn().mockResolvedValue(null),
      store: vi.fn().mockRejectedValue(new Error('store boom')),
    };
    const { adapter, app, router } = buildMemoryAdapter(memoryGateway);

    router.rpc.prompt = vi.fn().mockImplementation(async () => {
      router.rpc.emit('message_update', { type: 'text_delta', delta: 'response' });
      router.rpc.emit('agent_end', { usage: null });
      return { ok: true };
    });

    // Should not throw or produce an unhandled rejection
    await expect(invokeWithMemory(adapter, app, {
      text: '<@U0BOTID> hi',
      user: 'U123',
    })).resolves.not.toThrow();

    await flushAsync();
    // store was called (and rejected — swallowed)
    expect(memoryGateway.store).toHaveBeenCalled();
  });

  it('store receives conversation and thread from the message context', async () => {
    const memoryGateway = {
      recall: vi.fn().mockResolvedValue(null),
      store: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { adapter, app, router } = buildMemoryAdapter(memoryGateway);

    router.rpc.prompt = vi.fn().mockImplementation(async () => {
      router.rpc.emit('message_update', { type: 'text_delta', delta: 'ack' });
      router.rpc.emit('agent_end', { usage: null });
      return { ok: true };
    });

    await invokeWithMemory(adapter, app, {
      channel: 'C_STORE_TEST',
      ts: '300.000',
      thread_ts: '300.000',
      text: '<@U0BOTID> test store meta',
      user: 'U123',
    });
    await flushAsync();

    expect(memoryGateway.store).toHaveBeenCalledWith(
      'U123',
      'ack',
      {
        source: 'slack',
        conversation: 'C_STORE_TEST',
        thread: '300.000',
        category: 'conversation',
      },
    );
  });
});

describe('SlackAdapter — NoopMemoryGateway integration', () => {
  it('NoopMemoryGateway: recall returns null → no augmentation', async () => {
    const noop = new NoopMemoryGateway();
    const { adapter, app, router } = buildMemoryAdapter(noop);
    await invokeWithMemory(adapter, app, {
      text: '<@U0BOTID> hello',
      user: 'U123',
    });
    // recall returns null → body unchanged
    expect(router.rpc.prompt).toHaveBeenCalledWith('hello', []);
  });

  it('NoopMemoryGateway: store is a no-op — no errors thrown', async () => {
    const noop = new NoopMemoryGateway();
    const { adapter, app, router } = buildMemoryAdapter(noop);

    router.rpc.prompt = vi.fn().mockImplementation(async () => {
      router.rpc.emit('message_update', { type: 'text_delta', delta: 'noop response' });
      router.rpc.emit('agent_end', { usage: null });
      return { ok: true };
    });

    await expect(invokeWithMemory(adapter, app, {
      text: '<@U0BOTID> hello',
      user: 'U123',
    })).resolves.not.toThrow();

    await flushAsync();
    // No error — noop silently returns { ok: true, noop: true }
  });
});

describe('SlackAdapter — _resolveSynapsUserId', () => {
  it('returns the Slack user ID directly (Phase 2 v0 — no IdentityRouter)', () => {
    const { adapter } = buildAdapter();
    expect(adapter._resolveSynapsUserId('U123')).toBe('U123');
    expect(adapter._resolveSynapsUserId('UABC456')).toBe('UABC456');
  });
});

// ─── Phase 3: _resolveSynapsUserInfo + identityRouter ─────────────────────────

function makeIdentityRouter({ resolveResult = null, redeemResult = null, enabled = true } = {}) {
  return {
    enabled,
    resolve: vi.fn().mockResolvedValue(resolveResult ?? {
      synapsUser: { _id: 'deadbeefdeadbeefdeadbeef', memory_namespace: 'u_deadbeefdeadbeefdeadbeef' },
      isNew: false,
      isLinked: true,
    }),
    redeemLinkCode: vi.fn().mockResolvedValue(redeemResult ?? { ok: true, synaps_user_id: 'deadbeefdeadbeefdeadbeef' }),
  };
}

describe('SlackAdapter — _resolveSynapsUserInfo', () => {
  it('returns synapsUserId and memoryNamespace from router on happy path', async () => {
    const identityRouter = makeIdentityRouter();
    const { adapter } = buildAdapter({ identityRouter });
    const result = await adapter._resolveSynapsUserInfo({ slackUser: 'U123', slackTeamId: 'T456', displayName: 'Alice' });
    expect(identityRouter.resolve).toHaveBeenCalledWith({
      channel: 'slack',
      external_id: 'U123',
      external_team_id: 'T456',
      display_name: 'Alice',
    });
    expect(result.synapsUserId).toBe('deadbeefdeadbeefdeadbeef');
    expect(result.memoryNamespace).toBe('u_deadbeefdeadbeefdeadbeef');
    expect(result.isLinked).toBe(true);
  });

  it('falls back to raw slackUser when router.resolve throws', async () => {
    const identityRouter = {
      enabled: true,
      resolve: vi.fn().mockRejectedValue(new Error('db error')),
      redeemLinkCode: vi.fn(),
    };
    const warnSpy = vi.fn();
    const { adapter } = buildAdapter({
      identityRouter,
      logger: { warn: warnSpy, info: vi.fn(), error: vi.fn() },
    });
    const result = await adapter._resolveSynapsUserInfo({ slackUser: 'U999' });
    expect(result.synapsUserId).toBe('U999');
    expect(result.memoryNamespace).toBe('u_U999');
    expect(result.isLinked).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('identity resolve failed'));
  });

  it('returns Phase-2 defensive fallback when no identityRouter is set', async () => {
    const { adapter } = buildAdapter({ identityRouter: null });
    const result = await adapter._resolveSynapsUserInfo({ slackUser: 'U555' });
    expect(result.synapsUserId).toBe('U555');
    expect(result.memoryNamespace).toBe('u_U555');
    expect(result.isLinked).toBe(false);
    expect(result.isNew).toBe(false);
  });
});

describe('SlackAdapter — /synaps link directive', () => {
  async function invokeLinkDirective(adapter, app, text, user = 'U123') {
    await adapter.start();
    const handler = app.handlers.events.get('message');
    const client = mockClient();
    await handler({
      event: {
        channel: 'D123',
        ts: '9000.000',
        thread_ts: null,
        text,
        user,
        channel_type: 'im',
        files: [],
      },
      client,
      ack: vi.fn(),
    });
    return { client };
  }

  it('/synaps link ABC123 — success: calls redeemLinkCode, posts success reply, no LLM stream', async () => {
    const identityRouter = makeIdentityRouter({ redeemResult: { ok: true, synaps_user_id: 'abc' } });
    const { adapter, app, router } = buildAdapter({ identityRouter });
    const { client } = await invokeLinkDirective(adapter, app, '/synaps link ABC123', 'U999');
    expect(identityRouter.redeemLinkCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ABC123', channel: 'slack', external_id: 'U999' }),
    );
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: '✅ Linked Slack to your web account.' }),
    );
    expect(router.rpc.prompt).not.toHaveBeenCalled();
  });

  it('/synaps link ABC123 — bad code: posts failure reply, no LLM stream', async () => {
    const identityRouter = makeIdentityRouter({ redeemResult: { ok: false, reason: 'expired' } });
    const { adapter, app, router } = buildAdapter({ identityRouter });
    const { client } = await invokeLinkDirective(adapter, app, '/synaps link XXXXXX');
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('❌') }),
    );
    expect(router.rpc.prompt).not.toHaveBeenCalled();
  });

  it('/synaps link without code — posts usage hint reply', async () => {
    const identityRouter = makeIdentityRouter();
    const { adapter, app, router } = buildAdapter({ identityRouter });
    const { client } = await invokeLinkDirective(adapter, app, '/synaps link');
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Usage') }),
    );
    expect(router.rpc.prompt).not.toHaveBeenCalled();
  });

  it('/synaps link ABC123 when identityRouter.enabled=false — posts "not enabled" reply', async () => {
    const identityRouter = makeIdentityRouter({ enabled: false });
    const { adapter, app, router } = buildAdapter({ identityRouter });
    const { client } = await invokeLinkDirective(adapter, app, '/synaps link ABC123');
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Identity linking is not enabled on this bridge.' }),
    );
    expect(router.rpc.prompt).not.toHaveBeenCalled();
  });

  it('/synaps link ABC123 when redeemLinkCode throws — posts failure reply, no LLM stream', async () => {
    const identityRouter = {
      enabled: true,
      resolve: vi.fn(),
      redeemLinkCode: vi.fn().mockRejectedValue(new Error('network error')),
    };
    const { adapter, app, router } = buildAdapter({
      identityRouter,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    });
    const { client } = await invokeLinkDirective(adapter, app, '/synaps link ABC123');
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('❌') }),
    );
    expect(router.rpc.prompt).not.toHaveBeenCalled();
  });
});

describe('SlackAdapter — memory namespace from identityRouter', () => {
  it('memory.recall uses memory_namespace from identityRouter, not raw slackUser', async () => {
    const identityRouter = makeIdentityRouter({
      resolveResult: {
        synapsUser: { _id: 'aabbccdd11223344aabbccdd', memory_namespace: 'u_aabbccdd11223344aabbccdd' },
        isNew: false,
        isLinked: true,
      },
    });
    const memoryGateway = {
      recall: vi.fn().mockResolvedValue(null),
      store: vi.fn().mockResolvedValue({ ok: true }),
    };
    const { adapter, app } = buildMemoryAdapter(memoryGateway, { identityRouter });
    await invokeWithMemory(adapter, app, { text: '<@U0BOTID> test namespace', user: 'U123' });
    expect(memoryGateway.recall).toHaveBeenCalledWith('u_aabbccdd11223344aabbccdd', 'test namespace');
  });

  it('memory.recall uses raw slackUser when no identityRouter (Phase-2 compatibility)', async () => {
    const memoryGateway = {
      recall: vi.fn().mockResolvedValue(null),
      store: vi.fn().mockResolvedValue({ ok: true }),
    };
    // buildMemoryAdapter doesn't pass identityRouter → should use raw slackUser
    const { adapter, app } = buildMemoryAdapter(memoryGateway);
    await invokeWithMemory(adapter, app, { text: '<@U0BOTID> hello', user: 'U123' });
    expect(memoryGateway.recall).toHaveBeenCalledWith('U123', 'hello');
  });
});
