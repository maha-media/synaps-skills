/**
 * @file bridge/index.js
 *
 * BridgeDaemon — top-level orchestrator.
 *
 * This file is the integration boundary: it is allowed to import Slack adapter
 * types (cardinal rule §8 / §11 — "daemon entrypoint level only").  Bridge
 * core modules must not import from bridge/sources.
 *
 * No I/O in constructor.  All side effects are in start() / stop().
 * No top-level await.
 */

import { EventEmitter } from 'node:events';
import { SessionRouter } from './core/session-router.js';
import { SessionStore } from './core/session-store.js';
import { SynapsRpc } from './core/synaps-rpc.js';
import { ControlSocket } from './control-socket.js';
import { readSlackAuth } from './sources/slack/auth.js';
import { SlackAdapter } from './sources/slack/index.js';

// ─── default factories ────────────────────────────────────────────────────────

/**
 * Default SessionRouter factory.
 * Closes over config to wire up the rpcFactory.
 *
 * @param {import('./config.js').NormalizedConfig} config
 * @param {object} logger
 * @returns {SessionRouter}
 */
function defaultSessionRouterFactory(config, logger) {
  const store = new SessionStore({ logger });
  return new SessionRouter({
    store,
    rpcFactory: ({ sessionId = null, model = null } = {}) =>
      new SynapsRpc({
        binPath: config.rpc.binary,
        sessionId,
        model: model ?? config.rpc.default_model,
        profile: config.rpc.default_profile || null,
        logger,
      }),
    idleTtlMs: config.bridge.session_idle_timeout_secs * 1000,
    logger,
  });
}

/**
 * Default SlackAdapter factory.
 *
 * @param {{ auth: object, sessionRouter: SessionRouter, logger: object }} opts
 * @returns {SlackAdapter}
 */
function defaultSlackAdapterFactory({ auth, sessionRouter, logger }) {
  return new SlackAdapter({ sessionRouter, auth, logger });
}

/**
 * Default ControlSocket factory.
 *
 * @param {{ sessionRouter: SessionRouter, logger: object, version: string }} opts
 * @returns {ControlSocket}
 */
function defaultControlSocketFactory({ sessionRouter, logger, version }) {
  return new ControlSocket({ sessionRouter, logger, version });
}

// ─── BridgeDaemon ─────────────────────────────────────────────────────────────

export class BridgeDaemon extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {import('./config.js').NormalizedConfig} opts.config
   * @param {object}   [opts.logger]                   - Logger (default: console).
   * @param {NodeJS.ProcessEnv} [opts.env]             - Environment (default: process.env).
   * @param {Function} [opts.sessionRouterFactory]     - (config, logger) => SessionRouter.
   * @param {Function} [opts.slackAdapterFactory]      - ({ auth, sessionRouter, logger }) => SlackAdapter.
   * @param {Function} [opts.controlSocketFactory]     - ({ sessionRouter, logger, version }) => ControlSocket.
   * @param {Function} [opts.onShutdown]               - Called after stop() completes.
   */
  constructor({
    config,
    logger = console,
    env = process.env,
    sessionRouterFactory = null,
    slackAdapterFactory = null,
    controlSocketFactory = null,
    onShutdown = null,
  } = {}) {
    super();

    this._config = config;
    this.logger = logger;
    this._env = env;
    this._sessionRouterFactory = sessionRouterFactory ?? defaultSessionRouterFactory;
    this._slackAdapterFactory  = slackAdapterFactory  ?? defaultSlackAdapterFactory;
    this._controlSocketFactory = controlSocketFactory ?? defaultControlSocketFactory;
    this._onShutdown = onShutdown;

    /** @type {SessionRouter|null} */
    this._sessionRouter = null;
    /** @type {SlackAdapter|null} */
    this._slackAdapter = null;
    /** @type {ControlSocket|null} */
    this._controlSocket = null;

    this._started = false;
    this._stopped = false;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Build and start all subsystems.
   * @returns {Promise<void>}
   */
  async start() {
    if (this._started) return;
    this._started = true;

    // 1. Session router.
    this._sessionRouter = this._sessionRouterFactory(this._config, this.logger);
    await this._sessionRouter.start();

    // 2. Slack adapter (if enabled).
    if (this._config.sources.slack.enabled) {
      const auth = readSlackAuth(this._env);
      this._slackAdapter = this._slackAdapterFactory({
        auth,
        sessionRouter: this._sessionRouter,
        logger: this.logger,
      });
      await this._slackAdapter.start();
    }

    // 3. Control socket.
    this._controlSocket = this._controlSocketFactory({
      sessionRouter: this._sessionRouter,
      logger: this.logger,
      version: '0.1.0',
    });
    await this._controlSocket.start();

    this.emit('started');
    this.logger.info?.('BridgeDaemon: started');
  }

  /**
   * Tear down all subsystems in reverse order.  Idempotent.
   *
   * @param {object} [opts]
   * @param {string} [opts.signal] - The signal that triggered stop (for logging).
   * @returns {Promise<void>}
   */
  async stop({ signal } = {}) {
    if (this._stopped) return;
    this._stopped = true;

    if (signal) {
      this.logger.info?.(`BridgeDaemon: stopping (signal=${signal})`);
    }

    // Reverse order: control socket → adapter → router.
    if (this._controlSocket) {
      try {
        await this._controlSocket.stop();
      } catch (err) {
        this.logger.warn?.(`BridgeDaemon: control socket stop error: ${err.message}`);
      }
    }

    if (this._slackAdapter) {
      try {
        await this._slackAdapter.stop();
      } catch (err) {
        this.logger.warn?.(`BridgeDaemon: slack adapter stop error: ${err.message}`);
      }
    }

    if (this._sessionRouter) {
      try {
        await this._sessionRouter.stop();
      } catch (err) {
        this.logger.warn?.(`BridgeDaemon: session router stop error: ${err.message}`);
      }
    }

    this.emit('stopped');
    this.logger.info?.('BridgeDaemon: stopped');

    if (typeof this._onShutdown === 'function') {
      this._onShutdown();
    }
  }
}
