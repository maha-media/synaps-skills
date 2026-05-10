/**
 * @file index.js
 * @module bridge/sources/slack
 *
 * Bolt wiring layer — the main entry point for the Slack adapter.
 *
 * Responsibilities:
 *  - Build and start a Slack Bolt app (Socket Mode) via an injectable factory.
 *  - Register all event handlers for assistant_thread_started,
 *    assistant_thread_context_changed, app_mention, and message (DM).
 *  - Route each user message through the SessionRouter → StreamingProxy →
 *    SynapsRpc pipeline.
 *  - Handle file attachments via the file-store download helper.
 *  - Enforce §0 #6 (logger injection) and §0 #7 (no tokens in logs).
 *
 * No top-level await.  Bolt is lazy-imported inside _buildApp() so tests that
 * inject a boltAppFactory never trigger the real @slack/bolt import.
 */

import { AdapterInstance } from '../../core/abstractions/adapter.js';
import { StreamingProxy } from '../../core/streaming-proxy.js';
import { sessionKey, parseSetModelDirective } from '../../core/helpers.js';
import { SLACK_CAPABILITIES } from './slack-capabilities.js';
import { SlackBotGate } from './slack-bot-gate.js';
import { SlackFormatter } from './slack-formatter.js';
import { SlackStreamHandle } from './slack-stream-handle.js';
import { SlackToolProgressRenderer } from './slack-tool-progress-renderer.js';
import { SlackSubagentRenderer } from './slack-subagent-renderer.js';
import { readSlackAuth, redactTokens } from './auth.js';
import { downloadSlackFile } from './file-store.js';

// ─── SlackAdapter ─────────────────────────────────────────────────────────────

export class SlackAdapter extends AdapterInstance {
  /**
   * @param {object}   opts
   * @param {Function} [opts.boltAppFactory]   - `(opts) => BoltApp` — inject for tests;
   *                                              default lazy-imports @slack/bolt.
   * @param {import('../../core/session-router.js').SessionRouter} opts.sessionRouter
   * @param {{ botToken: string, appToken: string }} opts.auth
   * @param {import('../../core/abstractions/adapter.js').AdapterCapabilities} [opts.capabilities]
   * @param {import('./slack-bot-gate.js').SlackBotGate} [opts.botGate]
   * @param {import('./slack-formatter.js').SlackFormatter} [opts.formatter]
   * @param {{ download: Function }} [opts.fileStore]
   * @param {object} [opts.logger]
   */
  constructor({
    boltAppFactory = null,
    sessionRouter,
    auth,
    capabilities = SLACK_CAPABILITIES,
    botGate = new SlackBotGate({ aiAppMode: true }),
    formatter = new SlackFormatter(),
    fileStore = { download: downloadSlackFile },
    logger = console,
  } = {}) {
    super({ source: 'slack', capabilities, logger });

    /** @type {Function|null} */
    this._boltAppFactory = boltAppFactory;

    /** @type {import('../../core/session-router.js').SessionRouter} */
    this._router = sessionRouter;

    /** @type {{ botToken: string, appToken: string }} */
    this._auth = auth;

    /** @type {import('./slack-bot-gate.js').SlackBotGate} */
    this._botGate = botGate;

    /** @type {import('./slack-formatter.js').SlackFormatter} */
    this._formatter = formatter;

    /** @type {{ download: Function }} */
    this._fileStore = fileStore;

    /** @type {object|null} The live Bolt App instance. */
    this._app = null;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Build the Bolt app, register all handlers, and connect via Socket Mode.
   * @returns {Promise<void>}
   */
  async start() {
    this._app = await this._buildApp();
    this._registerHandlers(this._app);
    await this._app.start();
  }

  /**
   * Gracefully stop the Bolt app.  Does not drain in-flight prompts — that
   * complexity is deferred to a later task.
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._app) {
      try {
        await this._app.stop();
      } catch (err) {
        try {
          this.logger.warn(`[SlackAdapter] stop error: ${redactTokens(err.message)}`);
        } catch { /* swallow */ }
      }
    }
  }

  // ── internal: app construction ────────────────────────────────────────────

  /**
   * Construct the Bolt App, using the injected factory when available or
   * lazily importing @slack/bolt otherwise.
   *
   * @private
   * @returns {Promise<object>} Bolt App instance.
   */
  async _buildApp() {
    if (this._boltAppFactory) {
      return this._boltAppFactory({
        token: this._auth.botToken,
        appToken: this._auth.appToken,
        socketMode: true,
      });
    }

    // Lazy import — only reached in production, never in tests that inject a factory.
    const { App } = await import('@slack/bolt');
    return new App({
      token: this._auth.botToken,
      appToken: this._auth.appToken,
      socketMode: true,
    });
  }

  // ── internal: handler registration ───────────────────────────────────────

  /**
   * Register all Bolt event listeners on `app`.
   *
   * @private
   * @param {object} app - Bolt App instance.
   */
  _registerHandlers(app) {
    // AI-app assistant events
    app.event('assistant_thread_started', (args) =>
      this._onAssistantThreadStarted(args),
    );
    app.event('assistant_thread_context_changed', (args) =>
      this._onAssistantThreadContextChanged(args),
    );

    // app_mention — someone @-mentions the bot in a channel
    app.event('app_mention', (args) => this._onAppMention(args));

    // message — direct messages (im channel type)
    app.event('message', (args) => this._onMessage(args));
  }

  // ── event handlers ────────────────────────────────────────────────────────

  /**
   * Handle assistant_thread_started — set a "thinking…" status.
   *
   * @param {object} args
   * @param {object} args.event
   * @param {object} args.client
   * @param {Function} [args.ack]
   */
  async _onAssistantThreadStarted({ event, client, ack }) {
    if (typeof ack === 'function') await ack();

    const { channel_id, thread_ts } = event?.assistant_thread ?? {};

    // Set status — silently skip if the AI-app methods are not available.
    if (client?.assistant?.threads?.setStatus) {
      try {
        await client.assistant.threads.setStatus({
          channel_id,
          thread_ts,
          status: 'is thinking…',
        });
      } catch (err) {
        try {
          this.logger.warn(
            `[SlackAdapter] setStatus failed: ${redactTokens(err.message)}`,
          );
        } catch { /* swallow */ }
      }
    }
  }

  /**
   * Handle assistant_thread_context_changed — currently a no-op.
   *
   * @param {object} args
   * @param {object} args.event
   * @param {Function} [args.ack]
   */
  async _onAssistantThreadContextChanged({ event, ack }) { // eslint-disable-line no-unused-vars
    if (typeof ack === 'function') await ack();
    // Diagnostic log only — context switching not yet implemented.
    try {
      this.logger.info?.('[SlackAdapter] assistant_thread_context_changed received (no-op)');
    } catch { /* swallow */ }
  }

  /**
   * Handle app_mention events.
   *
   * @param {object} args
   * @param {object} args.event
   * @param {object} args.client
   * @param {Function} [args.ack]
   */
  async _onAppMention({ event, client, ack }) {
    if (typeof ack === 'function') await ack();

    // Strip the leading <@BOTID> mention so the model doesn't see it.
    const rawText = event.text ?? '';
    const text = rawText.replace(/^\s*<@[A-Z0-9]+>\s*/, '');

    await this._handleUserMessage({
      conversation: event.channel,
      thread: event.thread_ts || event.ts,
      text,
      user: event.user,
      files: event.files ?? [],
      client,
    });
  }

  /**
   * Handle message events — DMs and channel messages.
   *
   * Only DM messages (`channel_type: 'im'`) are processed here.  Bot messages
   * are silently dropped to prevent infinite loops.
   *
   * @param {object} args
   * @param {object} args.event
   * @param {object} args.client
   * @param {Function} [args.ack]
   */
  async _onMessage({ event, client, ack }) {
    if (typeof ack === 'function') await ack();

    // Bot-loop prevention: drop any message that originated from a bot.
    if (event.bot_id || event.subtype === 'bot_message') return;

    // Only handle DMs in this handler; channel messages arrive via app_mention.
    if (event.channel_type !== 'im') return;

    await this._handleUserMessage({
      conversation: event.channel,
      thread: event.thread_ts || event.ts,
      text: event.text ?? '',
      user: event.user,
      files: event.files ?? [],
      client,
    });
  }

  // ── core message flow ─────────────────────────────────────────────────────

  /**
   * Route a normalised user message through the full pipeline:
   *   parse directive → bot gate → session → file download → stream → prompt
   *
   * @private
   * @param {object}   opts
   * @param {string}   opts.conversation - Slack channel id.
   * @param {string}   opts.thread       - Thread timestamp (or message ts).
   * @param {string}   opts.text         - Raw message text (mention stripped).
   * @param {string}   opts.user         - Slack user id.
   * @param {Array}    [opts.files]      - Slack file objects attached to the message.
   * @param {object}   opts.client       - Slack WebClient instance.
   * @returns {Promise<void>}
   */
  async _handleUserMessage({ conversation, thread, text, user, files = [], client }) {
    // ── 1. Parse set-model: directive ─────────────────────────────────────
    const { model, body } = parseSetModelDirective(text);

    // ── 2. Bot gate ────────────────────────────────────────────────────────
    const gate = this._botGate.evaluate({
      source: 'slack',
      conversation,
      thread,
      sender: user,
      text: body,
    });
    if (!gate.allowed) return;

    // ── 3. Get or create session ───────────────────────────────────────────
    let rpc;
    try {
      rpc = await this._router.getOrCreateSession({
        source: 'slack',
        conversation,
        thread,
        model: model ?? null,
      });
    } catch (err) {
      try {
        this.logger.warn(
          `[SlackAdapter] getOrCreateSession failed: ${redactTokens(err.message)}`,
        );
      } catch { /* swallow */ }
      return;
    }

    // ── 4. Apply model directive ───────────────────────────────────────────
    if (model) {
      try {
        await rpc.setModel(model);
      } catch (err) {
        try {
          this.logger.warn(
            `[SlackAdapter] setModel("${model}") failed: ${redactTokens(err.message)}`,
          );
        } catch { /* swallow */ }
        // Non-fatal — proceed with current model.
      }
    }

    // ── 5. Download attachments concurrently ───────────────────────────────
    const attachments = [];
    if (files.length > 0) {
      const results = await Promise.allSettled(
        files.map((f) =>
          this._fileStore.download({
            fileMeta: f,
            conversation,
            thread,
            botToken: this._auth.botToken,
          }),
        ),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          attachments.push(result.value);
        } else {
          // Log at warn — one bad file does not abort the whole message.
          try {
            this.logger.warn(
              `[SlackAdapter] file download failed: ${redactTokens(result.reason?.message ?? String(result.reason))}`,
            );
          } catch { /* swallow */ }
        }
      }
    }

    // ── 6. Build stream infrastructure ────────────────────────────────────
    const streamHandle = new SlackStreamHandle({
      client,
      channel: conversation,
      thread_ts: thread,
      formatter: this._formatter,
      useNativeStreaming: this.capabilities.streaming,
      logger: this.logger,
    });

    const proxy = new StreamingProxy({
      rpc,
      streamHandle,
      capabilities: this.capabilities,
      toolProgressRenderer: new SlackToolProgressRenderer(),
      subagentRenderer: new SlackSubagentRenderer(),
      logger: this.logger,
    });

    // ── 7. Start the stream ────────────────────────────────────────────────
    try {
      await proxy.start({ recipient: user });
    } catch (err) {
      try {
        this.logger.warn(
          `[SlackAdapter] proxy.start failed: ${redactTokens(err.message)}`,
        );
      } catch { /* swallow */ }
      return;
    }

    // ── 8. Subscribe aux events ────────────────────────────────────────────
    proxy.on('aux', async ({ kind, payload }) => {
      // payload is a Block Kit block array from SlackSubagentRenderer or
      // SlackToolProgressRenderer.
      const blocks = Array.isArray(payload) ? payload : [payload];
      try {
        await client.chat.postMessage({
          channel: conversation,
          thread_ts: thread,
          blocks,
          text: kind === 'subagent' ? '(subagent update)' : '(tool update)',
        });
      } catch (err) {
        try {
          this.logger.warn(
            `[SlackAdapter] aux postMessage failed (kind=${kind}): ${redactTokens(err.message)}`,
          );
        } catch { /* swallow */ }
      }
    });

    // ── 9. Send the prompt ─────────────────────────────────────────────────
    try {
      await rpc.prompt(body, attachments);
    } catch (err) {
      try {
        this.logger.warn(
          `[SlackAdapter] rpc.prompt failed: ${redactTokens(err.message)}`,
        );
      } catch { /* swallow */ }
    }

    // ── 10. Stop the stream ────────────────────────────────────────────────
    try {
      await proxy.stop();
    } catch (err) {
      try {
        this.logger.warn(
          `[SlackAdapter] proxy.stop failed: ${redactTokens(err.message)}`,
        );
      } catch { /* swallow */ }
    }

    // ── 11. Record turn in bot gate ────────────────────────────────────────
    this._botGate.recordTurn({ source: 'slack', conversation, thread });

    // ── 12. Record activity in session router ──────────────────────────────
    const key = sessionKey({ source: 'slack', conversation, thread });
    if (typeof this._router.recordActivity === 'function') {
      try {
        await this._router.recordActivity(key);
      } catch { /* best-effort */ }
    }
  }

  // ── test helpers ──────────────────────────────────────────────────────────

  /**
   * Inject a pre-built Bolt app (used by tests that need full handler access
   * without going through `start()`).
   *
   * @param {object} app - Mock Bolt app.
   */
  _setApp(app) {
    this._app = app;
  }
}

// ─── bootSlackAdapter ─────────────────────────────────────────────────────────

/**
 * Convenience boot function: read auth, build the adapter, start it.
 *
 * @param {object}   [opts]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {import('../../core/session-router.js').SessionRouter} opts.sessionRouter
 * @param {Function} [opts.boltAppFactory]
 * @param {object}   [opts.logger=console]
 * @returns {Promise<SlackAdapter>} Started adapter instance.
 */
export async function bootSlackAdapter({
  env = process.env,
  sessionRouter,
  boltAppFactory,
  logger = console,
} = {}) {
  const auth = readSlackAuth(env);
  const adapter = new SlackAdapter({
    boltAppFactory,
    sessionRouter,
    auth,
    logger,
  });
  await adapter.start();
  return adapter;
}
