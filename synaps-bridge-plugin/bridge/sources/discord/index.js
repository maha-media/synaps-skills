/**
 * @file index.js
 * @module bridge/sources/discord
 *
 * Discord wiring layer — the main entry point for the Discord adapter.
 *
 * Responsibilities:
 *  - Build a discord.js Client (via an injectable factory) and log in.
 *  - Register the `ready` and `messageCreate` event handlers.
 *  - Route each user-originated message (DM, @-mention, or thread reply where
 *    the bot is a participant) through the SessionRouter → StreamingProxy →
 *    SynapsRpc pipeline, mirroring the SlackAdapter pipeline shape.
 *  - Optionally call memoryGateway.recall() before prompting and
 *    memoryGateway.store() on agent_end (Phase 2 memory hooks).
 *  - Enforce §0 #6 (logger injection) and §0 #7 (no tokens in logs).
 *
 * No top-level await.  discord.js is NEVER imported here — the real Client is
 * constructed and injected from `bridge/index.js` via `discordClientFactory`.
 */

import { AdapterInstance } from '../../core/abstractions/adapter.js';
import { StreamingProxy } from '../../core/streaming-proxy.js';
import { sessionKey, parseSetModelDirective } from '../../core/helpers.js';
import { DISCORD_CAPABILITIES } from './discord-capabilities.js';
import { DiscordBotGate } from './discord-bot-gate.js';
import { DiscordFormatter } from './discord-formatter.js';
import { DiscordStreamHandle } from './discord-stream-handle.js';
import { DiscordToolProgressRenderer } from './discord-tool-progress-renderer.js';
import { DiscordSubagentRenderer } from './discord-subagent-renderer.js';
import { readDiscordAuth, redactTokens } from './auth.js';
import { downloadDiscordFile } from './file-store.js';

// ─── channel-type constants (discord.js v14 ChannelType) ──────────────────────

const CHANNEL_TYPE_DM             = 1;
const CHANNEL_TYPE_GROUP_DM       = 3;
const CHANNEL_TYPE_PUBLIC_THREAD  = 11;
const CHANNEL_TYPE_PRIVATE_THREAD = 12;
const CHANNEL_TYPE_ANNOUNCEMENT_THREAD = 10;

// Gateway-intent bit for MESSAGE_CONTENT.
const MESSAGE_CONTENT_INTENT = 1 << 15; // 32768

// ─── default client factory ──────────────────────────────────────────────────

/**
 * Default discord.js Client factory.  Always throws — the real client must be
 * injected from `bridge/index.js` so this module never depends on discord.js
 * directly (keeps the unit tests hermetic).
 *
 * @returns {never}
 */
function defaultDiscordClientFactory() {
  throw new Error(
    'discord.js Client not available — inject discordClientFactory',
  );
}

// ─── DiscordAdapter ──────────────────────────────────────────────────────────

export class DiscordAdapter extends AdapterInstance {
  /**
   * @param {object}   opts
   * @param {import('../../core/session-router.js').SessionRouter} opts.sessionRouter
   * @param {{ botToken: string }} opts.auth
   * @param {import('../../core/abstractions/adapter.js').AdapterCapabilities} [opts.capabilities]
   * @param {DiscordBotGate}        [opts.botGate]
   * @param {DiscordFormatter}      [opts.formatter]
   * @param {DiscordSubagentRenderer} [opts.subagentRenderer]
   * @param {DiscordToolProgressRenderer} [opts.toolProgressRenderer]
   * @param {{ download: Function }} [opts.fileStore]
   * @param {import('../../core/memory-gateway.js').MemoryGateway|null} [opts.memoryGateway]
   * @param {import('../../core/identity-router.js').IdentityRouter|null} [opts.identityRouter]
   * @param {Function}              [opts.discordClientFactory]  - `() => Client`; inject for tests.
   * @param {object}                [opts.logger=console]
   */
  constructor({
    sessionRouter,
    auth,
    capabilities = DISCORD_CAPABILITIES,
    botGate = new DiscordBotGate(),
    formatter = new DiscordFormatter(),
    subagentRenderer = new DiscordSubagentRenderer(),
    toolProgressRenderer = new DiscordToolProgressRenderer(),
    fileStore = { download: downloadDiscordFile },
    memoryGateway = null,
    identityRouter = null,
    discordClientFactory = defaultDiscordClientFactory,
    logger = console,
  } = {}) {
    super({ source: 'discord', capabilities, logger });

    /** @type {import('../../core/session-router.js').SessionRouter} */
    this._router = sessionRouter;

    /** @type {{ botToken: string }} */
    this._auth = auth;

    /** @type {DiscordBotGate} */
    this._botGate = botGate;

    /** @type {DiscordFormatter} */
    this._formatter = formatter;

    /** @type {DiscordSubagentRenderer} */
    this._subagentRenderer = subagentRenderer;

    /** @type {DiscordToolProgressRenderer} */
    this._toolProgressRenderer = toolProgressRenderer;

    /** @type {{ download: Function }} */
    this._fileStore = fileStore;

    /** @type {import('../../core/memory-gateway.js').MemoryGateway|null} */
    this._memoryGateway = memoryGateway;

    /** @type {import('../../core/identity-router.js').IdentityRouter|null} */
    this._identityRouter = identityRouter;

    /** @type {Function} */
    this._discordClientFactory = discordClientFactory;

    /** @type {object|null} The live discord.js Client instance. */
    this._client = null;

    /** @type {Set<string>} Thread ids the bot has participated in. */
    this._participatingThreads = new Set();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Construct the Client, register handlers, and log in.
   * @returns {Promise<void>}
   */
  async start() {
    this._client = await this._discordClientFactory();
    this._registerHandlers(this._client);
    await this._client.login(this._auth.botToken);
  }

  /**
   * Tear down the Client connection.  Safe to call when never started.
   * @returns {Promise<void>}
   */
  async stop() {
    if (this._client) {
      try {
        await this._client.destroy();
      } catch (err) {
        try {
          this.logger.warn(
            `[DiscordAdapter] destroy error: ${redactTokens(err.message)}`,
          );
        } catch { /* swallow */ }
      }
    }
  }

  // ── internal: handler registration ────────────────────────────────────────

  /**
   * Register all discord.js event listeners on `client`.
   * @private
   * @param {object} client
   */
  _registerHandlers(client) {
    client.on('ready', () => this._onReady(client));
    client.on('messageCreate', (message) => this._onMessageCreate(message));
  }

  // ── event handlers ────────────────────────────────────────────────────────

  /**
   * Handle the `ready` event — log the bot username and check the
   * MessageContent intent.
   * @private
   * @param {object} client
   */
  _onReady(client) {
    try {
      const tag = client.user?.tag ?? client.user?.username ?? '(unknown)';
      this.logger.info?.(`[DiscordAdapter] logged in as ${tag}`);
    } catch { /* swallow */ }

    // Warn if MessageContent intent is missing — most user messages will be
    // empty strings without it, which would silently break the adapter.
    try {
      const intents = client.options?.intents;
      let bits = null;
      if (intents == null) {
        bits = null;
      } else if (typeof intents === 'number' || typeof intents === 'bigint') {
        bits = Number(intents);
      } else if (typeof intents.bitfield === 'number' || typeof intents?.bitfield === 'bigint') {
        bits = Number(intents.bitfield);
      } else if (typeof intents.valueOf === 'function') {
        const v = intents.valueOf();
        bits = typeof v === 'number' || typeof v === 'bigint' ? Number(v) : null;
      }
      if (bits != null && (bits & MESSAGE_CONTENT_INTENT) === 0) {
        this.logger.warn?.(
          '[DiscordAdapter] MessageContent intent appears to be disabled — message.content will be empty for non-mention/non-DM messages.',
        );
      }
    } catch { /* swallow — intent check is best-effort */ }
  }

  /**
   * Handle a `messageCreate` event.  Filters out bot messages, then routes
   * DMs, @-mentions, and bot-participating thread replies through the
   * main pipeline.
   *
   * @private
   * @param {object} message - discord.js Message-like object.
   */
  async _onMessageCreate(message) {
    try {
      // Bot-loop prevention.
      if (message?.author?.bot) return;
      if (!message || !message.channel) return;

      const client = this._client;
      const channel = message.channel;
      const channelType = channel.type;

      const isDm = channelType === CHANNEL_TYPE_DM || channelType === CHANNEL_TYPE_GROUP_DM;
      const isThread =
        channelType === CHANNEL_TYPE_PUBLIC_THREAD ||
        channelType === CHANNEL_TYPE_PRIVATE_THREAD ||
        channelType === CHANNEL_TYPE_ANNOUNCEMENT_THREAD;
      const isMention = client?.user
        ? Boolean(message.mentions?.has?.(client.user))
        : false;

      // Route decision: DM, @-mention, or reply in a thread the bot has
      // participated in.
      const inParticipatingThread =
        isThread && this._participatingThreads.has(channel.id);

      if (!isDm && !isMention && !inParticipatingThread) return;

      await this._handleUserMessage(message, { isDm, isThread, isMention });
    } catch (err) {
      try {
        this.logger.warn(
          `[DiscordAdapter] messageCreate handler error: ${redactTokens(err.message)}`,
        );
      } catch { /* swallow */ }
    }
  }

  // ── core message flow ─────────────────────────────────────────────────────

  /**
   * Resolve the synaps user info for memory namespacing (Phase-3 identity).
   *
   * @private
   * @param {object} opts
   * @param {string} opts.discordUser
   * @param {string} [opts.discordGuildId]
   * @param {string} [opts.displayName]
   * @returns {Promise<{ synapsUserId: string, memoryNamespace: string, isLinked: boolean, isNew: boolean }>}
   */
  async _resolveSynapsUserInfo({ discordUser, discordGuildId, displayName }) {
    if (!this._identityRouter) {
      return {
        synapsUserId: discordUser,
        memoryNamespace: `u_${discordUser}`,
        isLinked: false,
        isNew: false,
      };
    }
    try {
      const { synapsUser, isNew, isLinked } = await this._identityRouter.resolve({
        channel: 'discord',
        external_id: discordUser,
        external_team_id: discordGuildId || '',
        display_name: displayName || null,
      });
      return {
        synapsUserId: String(synapsUser._id ?? discordUser),
        memoryNamespace: synapsUser.memory_namespace ?? `u_${discordUser}`,
        isLinked,
        isNew,
      };
    } catch (err) {
      this.logger.warn(`[discord] identity resolve failed: ${err.message}`);
      return {
        synapsUserId: discordUser,
        memoryNamespace: `u_${discordUser}`,
        isLinked: false,
        isNew: false,
      };
    }
  }

  /**
   * Strip a leading <@BOTID> mention from text.
   * @private
   */
  _stripBotMention(text, botId) {
    if (!text || !botId) return text ?? '';
    const re = new RegExp(`^\\s*<@!?${botId}>\\s*`);
    return text.replace(re, '');
  }

  /**
   * Route a Discord message through the full pipeline:
   *   link directive → set-model → bot gate → session → file download →
   *   stream → prompt → record turn / activity.
   *
   * @private
   * @param {object} message
   * @param {object} routing
   */
  async _handleUserMessage(message, routing) {
    const client = this._client;
    const channel = message.channel;
    const user = message.author?.id ?? '';
    const guildId = message.guildId ?? message.guild?.id ?? '';

    // Derive conversation / thread keys.
    let conversation;
    let thread;
    if (routing.isThread) {
      conversation = channel.parentId || channel.id;
      thread = channel.id;
    } else {
      conversation = channel.id;
      thread = '';
    }

    // Strip leading @mention so the model doesn't see it.
    const botId = client?.user?.id ?? '';
    const rawText = typeof message.content === 'string' ? message.content : '';
    const text = this._stripBotMention(rawText, botId);

    const attachmentsRaw = message.attachments
      ? (typeof message.attachments.values === 'function'
          ? Array.from(message.attachments.values())
          : Array.isArray(message.attachments) ? message.attachments : [])
      : [];

    // ── 0. /synaps link <CODE> directive ──────────────────────────────────
    const trimmed = text.trim();
    const linkMatch = /^\/synaps\s+link\s+([A-Z0-9]{6})\s*$/i.exec(trimmed);
    const linkUsageMatch = /^\/synaps\s+link\s*$/i.test(trimmed);

    if (linkMatch || linkUsageMatch) {
      if (linkUsageMatch && !linkMatch) {
        try {
          await channel.send(
            'Usage: `/synaps link <6-char code>`. Generate a code from the Synaps web dashboard.',
          );
        } catch { /* swallow */ }
        return;
      }

      const code = linkMatch[1].toUpperCase();

      if (!this._identityRouter || this._identityRouter.enabled === false) {
        try {
          await channel.send('Identity linking is not enabled on this bridge.');
        } catch { /* swallow */ }
        return;
      }

      try {
        const result = await this._identityRouter.redeemLinkCode({
          code,
          channel: 'discord',
          external_id: user,
          external_team_id: guildId,
          display_name: message.author?.username ?? null,
        });
        if (result.ok) {
          await channel.send('✅ Linked Discord to your web account.');
        } else {
          await channel.send('❌ Code expired/unknown/already used.');
        }
      } catch (err) {
        try {
          this.logger.warn(
            `[DiscordAdapter] link code redeem failed: ${redactTokens(err.message)}`,
          );
          await channel.send('❌ Code expired/unknown/already used.');
        } catch { /* swallow */ }
      }
      return;
    }

    // ── 1. set-model directive ────────────────────────────────────────────
    const { model, body } = parseSetModelDirective(text);

    // Empty messages with no attachments — drop.
    if (!body && attachmentsRaw.length === 0) return;

    // ── 2. Bot gate ───────────────────────────────────────────────────────
    const gate = this._botGate.evaluate({
      source: 'discord',
      conversation,
      thread,
      sender: user,
      text: body,
    });
    if (!gate.allowed) return;

    // ── 3. Get or create session ──────────────────────────────────────────
    let rpc;
    try {
      rpc = await this._router.getOrCreateSession({
        source: 'discord',
        conversation,
        thread,
        model: model ?? null,
      });
    } catch (err) {
      try {
        this.logger.warn(
          `[DiscordAdapter] getOrCreateSession failed: ${redactTokens(err.message)}`,
        );
      } catch { /* swallow */ }
      return;
    }

    // ── 4. Apply model directive ──────────────────────────────────────────
    if (model) {
      try {
        await rpc.setModel(model);
      } catch (err) {
        try {
          this.logger.warn(
            `[DiscordAdapter] setModel("${model}") failed: ${redactTokens(err.message)}`,
          );
        } catch { /* swallow */ }
      }
    }

    // ── 5. Download attachments concurrently ──────────────────────────────
    const attachments = [];
    if (attachmentsRaw.length > 0) {
      const results = await Promise.allSettled(
        attachmentsRaw.map((f) =>
          this._fileStore.download({
            fileMeta: f,
            conversation,
            thread: thread || channel.id,
            botToken: this._auth.botToken,
          }),
        ),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          attachments.push(result.value);
        } else {
          try {
            this.logger.warn(
              `[DiscordAdapter] file download failed: ${redactTokens(result.reason?.message ?? String(result.reason))}`,
            );
          } catch { /* swallow */ }
        }
      }
    }

    // Track participation if we're in a thread.
    if (routing.isThread) {
      this._participatingThreads.add(channel.id);
    }

    // ── 6. Build stream infrastructure ────────────────────────────────────
    const streamHandle = new DiscordStreamHandle({
      channel,
      formatter: this._formatter,
      logger: this.logger,
    });

    const proxy = new StreamingProxy({
      rpc,
      streamHandle,
      capabilities: this.capabilities,
      toolProgressRenderer: this._toolProgressRenderer,
      subagentRenderer: this._subagentRenderer,
      logger: this.logger,
    });

    // ── 7. Start the stream ───────────────────────────────────────────────
    try {
      await proxy.start({ recipient: user });
    } catch (err) {
      try {
        this.logger.warn(
          `[DiscordAdapter] proxy.start failed: ${redactTokens(err.message)}`,
        );
      } catch { /* swallow */ }
      return;
    }

    // ── 8. Subscribe aux events ───────────────────────────────────────────
    proxy.on('aux', async ({ kind, payload }) => {
      const embeds = Array.isArray(payload) ? payload : [payload];
      try {
        await channel.send({ embeds });
      } catch (err) {
        try {
          this.logger.warn(
            `[DiscordAdapter] aux send failed (kind=${kind}): ${redactTokens(err.message)}`,
          );
        } catch { /* swallow */ }
      }
    });

    // ── 9. Memory store on agent_end (best-effort) ────────────────────────
    if (this._memoryGateway != null) {
      proxy.once('agent_end', async (payload) => {
        const finalText = payload?.final_text ?? '';
        if (finalText.length === 0) return;
        let memoryKey = user;
        if (this._identityRouter) {
          try {
            const info = await this._resolveSynapsUserInfo({
              discordUser: user,
              discordGuildId: guildId,
              displayName: message.author?.username ?? null,
            });
            memoryKey = info.memoryNamespace;
          } catch { /* fall back */ }
        }
        Promise.resolve(
          this._memoryGateway.store(memoryKey, finalText, {
            source: 'discord',
            conversation,
            thread,
            category: 'conversation',
          }),
        ).catch((err) => {
          try {
            this.logger.warn(
              `[DiscordAdapter] memory store guard hit: ${redactTokens(err.message)}`,
            );
          } catch { /* swallow */ }
        });
      });
    }

    // ── 10. Memory recall (best-effort) ───────────────────────────────────
    let augmentedBody = body;
    if (this._memoryGateway != null && body && body.length > 0) {
      try {
        let memoryKey = user;
        if (this._identityRouter) {
          const info = await this._resolveSynapsUserInfo({
            discordUser: user,
            discordGuildId: guildId,
            displayName: message.author?.username ?? null,
          });
          memoryKey = info.memoryNamespace;
        }
        const summary = await this._memoryGateway.recall(memoryKey, body);
        if (summary && summary.length > 0) {
          augmentedBody = `[memory_recall]\n${summary}\n[/memory_recall]\n\n${body}`;
        }
      } catch (err) {
        try {
          this.logger.warn(
            `[DiscordAdapter] memory recall guard hit: ${redactTokens(err.message)}`,
          );
        } catch { /* swallow */ }
      }
    }

    // ── 11. Send the prompt ───────────────────────────────────────────────
    try {
      await rpc.prompt(augmentedBody, attachments);
    } catch (err) {
      try {
        this.logger.warn(
          `[DiscordAdapter] rpc.prompt failed: ${redactTokens(err.message)}`,
        );
      } catch { /* swallow */ }
    }

    // ── 12. Stop the stream ───────────────────────────────────────────────
    try {
      await proxy.stop();
    } catch (err) {
      try {
        this.logger.warn(
          `[DiscordAdapter] proxy.stop failed: ${redactTokens(err.message)}`,
        );
      } catch { /* swallow */ }
    }

    // ── 13. Record turn in bot gate ───────────────────────────────────────
    this._botGate.recordTurn({ source: 'discord', conversation, thread });

    // ── 14. Record activity in session router ─────────────────────────────
    const key = sessionKey({ source: 'discord', conversation, thread });
    if (typeof this._router.recordActivity === 'function') {
      try {
        await this._router.recordActivity(key);
      } catch { /* best-effort */ }
    }
  }

  // ── test helpers ──────────────────────────────────────────────────────────

  /**
   * Inject a pre-built Client (used by tests that need direct handler access
   * without going through `start()`).
   * @param {object} client
   */
  _setClient(client) {
    this._client = client;
  }
}

// ─── bootDiscordAdapter ──────────────────────────────────────────────────────

/**
 * Convenience boot function: read auth, build the adapter, start it.
 *
 * @param {object}   [opts]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {import('../../core/session-router.js').SessionRouter} opts.sessionRouter
 * @param {Function} [opts.discordClientFactory]
 * @param {object}   [opts.logger=console]
 * @returns {Promise<DiscordAdapter>}
 */
export async function bootDiscordAdapter({
  env = process.env,
  sessionRouter,
  discordClientFactory,
  logger = console,
} = {}) {
  const auth = readDiscordAuth(env);
  const adapter = new DiscordAdapter({
    sessionRouter,
    auth,
    discordClientFactory,
    logger,
  });
  await adapter.start();
  return adapter;
}
