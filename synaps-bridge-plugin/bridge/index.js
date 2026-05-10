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
 *
 * SCP mode (platform.mode === 'scp'):
 *   - Connects to MongoDB on start().
 *   - Creates WorkspaceManager (backed by real Docker socket from config).
 *   - Optionally creates VncProxy + ScpHttpServer when web.enabled = true.
 *   - Wires DockerExecSynapsRpc as the rpcFactory for SessionRouter.
 *   - Synaps-user resolution is a Phase-1 stub: uses SCP_DEFAULT_USER_ID env
 *     var (or config fallback).  Full IdentityRouter lands in Phase 3.
 *
 * Bridge mode (default, platform.mode === 'bridge'):
 *   Behaviour is unchanged — host-spawn SynapsRpc, no MongoDB, no Docker.
 *
 * Memory gateway (both modes):
 *   Built at start() time based on config.memory.enabled.  When disabled, a
 *   NoopMemoryGateway is used transparently.  The gateway is exposed to the
 *   Slack adapter via the slackAdapterFactory opts, and to SCP consumers via
 *   scpDeps.memoryGateway.  Teardown happens after mongoose disconnect in
 *   stop() (deepest layer last).
 *
 * Spec reference: PLATFORM.SPEC.md §3.1, §5, §6, §12.5
 */

import { EventEmitter }          from 'node:events';
import { SessionRouter }         from './core/session-router.js';
import { SessionStore }          from './core/session-store.js';
import { SynapsRpc }             from './core/synaps-rpc.js';
import { DockerExecSynapsRpc }   from './core/synaps-rpc-docker.js';
import { ControlSocket }         from './control-socket.js';
import { readSlackAuth }         from './sources/slack/auth.js';
import { SlackAdapter }          from './sources/slack/index.js';
import { getMongoose, WorkspaceRepo, getSynapsWorkspaceModel } from './core/db/index.js';
import { WorkspaceManager }      from './core/workspace-manager.js';
import { VncProxy }              from './core/vnc-proxy.js';
import { ScpHttpServer }         from './core/scp-http-server.js';
import { MemoryGateway, NoopMemoryGateway } from './core/memory-gateway.js';
import { AxelCliClient }         from './core/memory/axel-cli-client.js';
import Docker                    from 'dockerode';

// ─── default factories ────────────────────────────────────────────────────────

/**
 * Build the appropriate MemoryGateway based on config.
 *
 * - `config.memory.enabled = false` → NoopMemoryGateway (no client needed).
 * - `config.memory.transport !== 'cli'` → warn + NoopMemoryGateway (v0 only
 *   implements CLI transport).
 * - Otherwise → AxelCliClient + MemoryGateway wired from config.
 *
 * Exported so tests can exercise the factory branches directly.
 *
 * @param {import('./config.js').NormalizedConfig} config
 * @param {object} logger
 * @returns {MemoryGateway|NoopMemoryGateway}
 */
export function defaultMemoryGatewayFactory(config, logger) {
  if (!config.memory.enabled) {
    return new NoopMemoryGateway();
  }

  if (config.memory.transport !== 'cli') {
    logger.warn?.(
      `BridgeDaemon: memory transport "${config.memory.transport}" is not supported in v0 — only "cli" is implemented; falling back to NoopMemoryGateway`,
    );
    return new NoopMemoryGateway();
  }

  const client = new AxelCliClient({
    cliPath: config.memory.cli_path,
    logger,
  });

  return new MemoryGateway({
    client,
    brainDir:       config.memory.brain_dir,
    recallK:        config.memory.recall_k,
    recallMinScore: config.memory.recall_min_score,
    recallMaxChars: config.memory.recall_max_chars,
    logger,
  });
}

/**
 * Default SessionRouter factory.
 * Closes over config to wire up the rpcFactory.
 *
 * In SCP mode the rpcFactory instantiates DockerExecSynapsRpc; in bridge mode
 * it instantiates the host-spawn SynapsRpc.  The SessionRouter API is
 * identical in both cases.
 *
 * Phase-1 SCP note: SessionRouter passes { sessionId, model } to rpcFactory.
 * It does NOT pass synapsUserId.  For Phase 1 we resolve the user from
 * scpDeps.synapsUserIdResolver() which returns a hardcoded default.
 * Proper per-thread resolution (IdentityRouter) lands in Phase 3.
 *
 * @param {import('./config.js').NormalizedConfig} config
 * @param {object} logger
 * @param {{ workspaceManager: WorkspaceManager, synapsUserIdResolver: Function, memoryGateway: MemoryGateway|NoopMemoryGateway }|null} scpDeps
 * @returns {SessionRouter}
 */
function defaultSessionRouterFactory(config, logger, scpDeps = null) {
  const store = new SessionStore({ logger });
  const isScp = config.platform.mode === 'scp';

  const rpcFactory = isScp
    ? ({ sessionId = null, model = null } = {}) =>
        new DockerExecSynapsRpc({
          workspaceManager: scpDeps.workspaceManager,
          synapsUserId: scpDeps.synapsUserIdResolver(),
          binPath: config.rpc.binary,
          sessionId,
          model: model ?? config.rpc.default_model,
          profile: config.rpc.default_profile || null,
          logger,
        })
    : ({ sessionId = null, model = null } = {}) =>
        new SynapsRpc({
          binPath: config.rpc.binary,
          sessionId,
          model: model ?? config.rpc.default_model,
          profile: config.rpc.default_profile || null,
          logger,
        });

  return new SessionRouter({
    store,
    rpcFactory,
    idleTtlMs: config.bridge.session_idle_timeout_secs * 1000,
    logger,
  });
}

/**
 * Default SlackAdapter factory.
 *
 * @param {{ auth: object, sessionRouter: SessionRouter, memoryGateway: MemoryGateway|NoopMemoryGateway, logger: object }} opts
 * @returns {SlackAdapter}
 */
function defaultSlackAdapterFactory({ auth, sessionRouter, memoryGateway, logger }) {
  return new SlackAdapter({ sessionRouter, auth, memoryGateway, logger });
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
   * @param {Function} [opts.sessionRouterFactory]     - (config, logger, scpDeps) => SessionRouter.
   * @param {Function} [opts.slackAdapterFactory]      - ({ auth, sessionRouter, memoryGateway, logger }) => SlackAdapter.
   * @param {Function} [opts.controlSocketFactory]     - ({ sessionRouter, logger, version }) => ControlSocket.
   * @param {Function} [opts.onShutdown]               - Called after stop() completes.
   * @param {Function} [opts.mongoConnectFactory]      - (uri) => Promise<mongoose> — injectable for tests.
   * @param {Function} [opts.workspaceManagerFactory]  - (repo, docker, config) => WorkspaceManager — injectable for tests.
   * @param {Function} [opts.scpHttpServerFactory]     - (opts) => ScpHttpServer — injectable for tests.
   * @param {Function} [opts.memoryGatewayFactory]     - (config, logger) => MemoryGateway|NoopMemoryGateway — injectable for tests.
   */
  constructor({
    config,
    logger = console,
    env = process.env,
    sessionRouterFactory = null,
    slackAdapterFactory = null,
    controlSocketFactory = null,
    onShutdown = null,
    mongoConnectFactory = null,
    workspaceManagerFactory = null,
    scpHttpServerFactory = null,
    memoryGatewayFactory = null,
  } = {}) {
    super();

    this._config = config;
    this.logger = logger;
    this._env = env;
    this._sessionRouterFactory  = sessionRouterFactory  ?? defaultSessionRouterFactory;
    this._slackAdapterFactory   = slackAdapterFactory   ?? defaultSlackAdapterFactory;
    this._controlSocketFactory  = controlSocketFactory  ?? defaultControlSocketFactory;
    this._onShutdown            = onShutdown;

    // SCP DI hooks (test-injectable).
    this._mongoConnectFactory      = mongoConnectFactory      ?? ((uri) => getMongoose(uri));
    this._workspaceManagerFactory  = workspaceManagerFactory  ?? null;  // null → build inline
    this._scpHttpServerFactory     = scpHttpServerFactory     ?? null;  // null → build inline

    // Memory gateway factory (test-injectable).
    this._memoryGatewayFactory = memoryGatewayFactory ?? defaultMemoryGatewayFactory;

    /** @type {SessionRouter|null} */
    this._sessionRouter = null;
    /** @type {SlackAdapter|null} */
    this._slackAdapter = null;
    /** @type {ControlSocket|null} */
    this._controlSocket = null;

    // SCP-only runtime state.
    /** @type {object|null} mongoose instance */
    this._mongoose = null;
    /** @type {WorkspaceManager|null} */
    this._workspaceManager = null;
    /** @type {ScpHttpServer|null} */
    this._scpHttpServer = null;

    // Memory gateway (built in start(), available in both bridge and SCP mode).
    /** @type {MemoryGateway|NoopMemoryGateway|null} */
    this._memoryGateway = null;

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

    const isScp = this._config.platform?.mode === 'scp';
    let scpDeps = null;

    // 0. Memory gateway (always built; Noop when disabled).
    this._memoryGateway = this._memoryGatewayFactory(this._config, this.logger);
    await this._memoryGateway.start();

    // ── SCP mode bootstrap ────────────────────────────────────────────────
    if (isScp) {
      // 1. Connect to MongoDB.
      this._mongoose = await this._mongoConnectFactory(this._config.mongodb.uri);

      // 2. Build repo + WorkspaceManager.
      const model = getSynapsWorkspaceModel(this._mongoose);
      const repo  = new WorkspaceRepo({ model, logger: this.logger });

      if (this._workspaceManagerFactory) {
        this._workspaceManager = this._workspaceManagerFactory(repo, this._config);
      } else {
        const docker = new Docker({ socketPath: this._config.workspace.docker_socket });
        this._workspaceManager = new WorkspaceManager({
          docker,
          repo,
          logger:        this.logger,
          image:         this._config.workspace.image,
          volumeRoot:    this._config.workspace.volume_root,
          defaultLimits: {
            cpu:    this._config.workspace.default_cpu,
            mem_mb: this._config.workspace.default_mem_mb,
            pids:   this._config.workspace.default_pids,
          },
        });
      }

      // 3. Phase-1 user resolver: returns hardcoded default from env / config.
      const defaultUserId =
        this._env.SCP_DEFAULT_USER_ID ??
        '000000000000000000000001';   // fallback ObjectId stub

      /** @type {Function} */
      const synapsUserIdResolver = () => defaultUserId;

      scpDeps = {
        workspaceManager: this._workspaceManager,
        synapsUserIdResolver,
        memoryGateway: this._memoryGateway,
      };

      // 4. Optional HTTP server + VNC proxy.
      if (this._config.web.enabled) {
        let scpServer;
        if (this._scpHttpServerFactory) {
          scpServer = this._scpHttpServerFactory({ config: this._config, repo, logger: this.logger });
        } else {
          const vncProxy = new VncProxy({ repo, logger: this.logger });
          scpServer = new ScpHttpServer({ config: this._config, vncProxy, logger: this.logger });
        }
        this._scpHttpServer = scpServer;
        await this._scpHttpServer.start();
      }
    }

    // 1. Session router.
    this._sessionRouter = this._sessionRouterFactory(this._config, this.logger, scpDeps);
    await this._sessionRouter.start();

    // 2. Slack adapter (if enabled).
    if (this._config.sources.slack.enabled) {
      const auth = readSlackAuth(this._env);
      this._slackAdapter = this._slackAdapterFactory({
        auth,
        sessionRouter: this._sessionRouter,
        memoryGateway: this._memoryGateway,
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
   * Stop order:
   *   control socket → slack adapter → session router →
   *   scp http server → mongoose disconnect → memory gateway
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

    // SCP teardown: ScpHttpServer → Mongoose disconnect.
    if (this._scpHttpServer) {
      try {
        await this._scpHttpServer.stop();
      } catch (err) {
        this.logger.warn?.(`BridgeDaemon: scp http server stop error: ${err.message}`);
      }
    }

    if (this._mongoose) {
      try {
        // Disconnect only if the mongoose instance exposes disconnect().
        if (typeof this._mongoose.disconnect === 'function') {
          await this._mongoose.disconnect();
        }
      } catch (err) {
        this.logger.warn?.(`BridgeDaemon: mongoose disconnect error: ${err.message}`);
      }
    }

    // Memory gateway — stopped last (deepest layer).
    if (this._memoryGateway) {
      try {
        await this._memoryGateway.stop();
      } catch (err) {
        this.logger.warn?.(`BridgeDaemon: memory gateway stop error: ${err.message}`);
      }
    }

    this.emit('stopped');
    this.logger.info?.('BridgeDaemon: stopped');

    if (typeof this._onShutdown === 'function') {
      this._onShutdown();
    }
  }
}
