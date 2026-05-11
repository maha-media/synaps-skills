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
 * Cred broker (both modes, Phase 4):
 *   Built at start() time based on config.creds.enabled.  When disabled (the
 *   default), a NoopCredBroker is used transparently.  The broker is threaded
 *   through to ControlSocket and (in SCP mode) to scpDeps so downstream
 *   consumers can call cred_broker_use without holding the secret.
 *   Cache is cleared on stop() via credBroker.clear().
 *
 * Spec reference: PLATFORM.SPEC.md §3.1, §5, §6, §8, §12.5
 */

import { EventEmitter }          from 'node:events';
import { execFileSync }          from 'node:child_process';
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
import { CredBroker, NoopCredBroker } from './core/cred-broker.js';
import { InfisicalClient }       from './core/cred-broker/infisical-client.js';
import { NoOpIdentityRouter }    from './core/identity-router.js';
import { HeartbeatEmitter }      from './core/heartbeat-emitter.js';
import { Reaper }                from './core/reaper.js';
import { makeHeartbeatRepo, makeScheduledTaskRepo } from './core/db/index.js';
import { HookRepo }                from './core/db/repositories/hook-repo.js';
import { makeHookModel }           from './core/db/models/synaps-hook.js';
import { HookBus, NoopHookBus }  from './core/hook-bus.js';
import { InboxNotifier, NoopInboxNotifier } from './core/inbox-notifier.js';
import { Scheduler, NoopScheduler } from './core/scheduler.js';
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
 * Build the appropriate CredBroker based on config.
 *
 * - `config.creds.enabled = false` → NoopCredBroker
 * - `config.creds.broker = 'noop'` → NoopCredBroker
 * - `config.creds.broker = 'infisical'` → InfisicalClient + CredBroker
 * - Otherwise → warn + NoopCredBroker
 *
 * Exported so tests can exercise the factory branches directly.
 *
 * @param {import('./config.js').NormalizedConfig} config
 * @param {{info,warn,error,debug}} logger
 * @returns {CredBroker|NoopCredBroker}
 */
export function defaultCredBrokerFactory(config, logger) {
  if (!config.creds?.enabled) {
    return new NoopCredBroker();
  }
  if (config.creds.broker === 'noop') {
    return new NoopCredBroker();
  }
  if (config.creds.broker !== 'infisical') {
    logger.warn(
      `BridgeDaemon: cred broker "${config.creds.broker}" is not supported in v0 — only "infisical" is implemented; falling back to NoopCredBroker`,
    );
    return new NoopCredBroker();
  }

  const infisicalClient = new InfisicalClient({
    baseUrl:             config.creds.infisical_url,
    tokenFile:           config.creds.infisical_token_file,
    auditAttributeUser:  config.creds.audit_attribute_user,
    logger,
  });

  return new CredBroker({
    infisicalClient,
    cacheTtlSecs: config.creds.cache_ttl_secs,
    logger,
  });
}

/**
 * Build HeartbeatEmitter + Reaper when supervisor is enabled and mongoose is
 * available.  Returns null in all other cases (silent no-op).
 *
 * Exported so tests can exercise the factory branches directly.
 *
 * @param {import('./config.js').NormalizedConfig} config
 * @param {{info,warn,error,debug}} logger
 * @param {Function|null} getMongooseFn  - async () => mongoose instance
 * @param {object} [extras]
 * @param {object}   [extras.workspaceManager] - forwarded to Reaper if provided
 * @param {Function} [extras.rpcKiller]        - forwarded to Reaper if provided
 * @param {object}   [extras.inboxNotifier]    - forwarded to Reaper (Phase 6)
 * @param {Function} [extras.inboxDirFor]      - forwarded to Reaper (Phase 6)
 * @returns {Promise<{repo, emitter, reaper}|null>}
 */
export async function defaultHeartbeatFactory(config, logger, getMongooseFn, { workspaceManager, rpcKiller, inboxNotifier, inboxDirFor } = {}) {
  if (!config.supervisor?.enabled) return null;

  const mongoose = await getMongooseFn?.();
  if (!mongoose) {
    logger.warn('supervisor enabled but mongoose unavailable; heartbeats disabled');
    return null;
  }

  const repo = makeHeartbeatRepo(mongoose);

  const emitter = new HeartbeatEmitter({
    repo,
    component:  'bridge',
    id:         'main',
    intervalMs: config.supervisor.heartbeat_interval_ms,
    logger,
  });

  const reaper = new Reaper({
    repo,
    intervalMs: config.supervisor.reaper_interval_ms,
    thresholds: {
      workspaceMs: config.supervisor.workspace_stale_ms,
      rpcMs:       config.supervisor.rpc_stale_ms,
      scpMs:       config.supervisor.scp_stale_ms,
    },
    workspaceManager: workspaceManager ?? null,
    rpcKiller:        rpcKiller        ?? null,
    inboxNotifier:    inboxNotifier    ?? null,
    inboxDirFor:      inboxDirFor      ?? null,
    logger,
  });

  return { repo, emitter, reaper };
}

/**
 * Convenience factory: makeHookRepo(mongooseInstance) → HookRepo.
 * Created inline since db/index.js may not yet export it (Wave A2 in parallel).
 *
 * @param {import('mongoose').Mongoose} mongooseInstance
 * @returns {HookRepo}
 */
function _makeHookRepo(mongooseInstance) {
  const HookModel = makeHookModel(mongooseInstance);
  return new HookRepo({ model: HookModel });
}

/**
 * Build the appropriate Scheduler based on config.
 *
 * - `config.scheduler.enabled = false` or missing mongoose/dispatcher → NoopScheduler.
 * - Otherwise → real Scheduler with agenda.
 *
 * Note: agenda is a CJS module imported inside scheduler.js via createRequire.
 * This factory only resolves a live Scheduler when enabled AND both mongoose and
 * dispatcher are present.
 *
 * Exported so tests can exercise the factory branches directly.
 *
 * @param {import('./config.js').NormalizedConfig} config
 * @param {{info,warn,error,debug}} logger
 * @param {Function|null} getMongooseFn  - () => mongoose instance
 * @param {Function|null} getDispatcher  - () => dispatcher fn
 * @returns {Promise<Scheduler|NoopScheduler>}
 */
export async function defaultSchedulerFactory(config, logger, getMongooseFn, getDispatcher) {
  if (!config.scheduler?.enabled) {
    return new NoopScheduler();
  }

  const mongoose = await getMongooseFn?.();
  if (!mongoose) {
    logger.warn('scheduler enabled but mongoose unavailable; using NoopScheduler');
    return new NoopScheduler();
  }

  const dispatcher = typeof getDispatcher === 'function' ? getDispatcher() : null;
  if (!dispatcher) {
    logger.warn('scheduler enabled but no dispatcher available; using NoopScheduler');
    return new NoopScheduler();
  }

  const repo = makeScheduledTaskRepo(mongoose);

  // Lazy-import agenda at runtime — only when config.scheduler.enabled.
  // Scheduler.js handles the CJS compat layer via createRequire.
  return new Scheduler({
    repo,
    dispatcher,
    processEverySecs: config.scheduler.process_every_secs,
    maxConcurrency:   config.scheduler.max_concurrency,
    logger,
  });
}

/**
 * Build the appropriate HookBus based on config.
 *
 * - `config.hooks.enabled = false` or missing mongoose → NoopHookBus.
 * - Otherwise → real HookBus wired to HookRepo.
 *
 * Exported so tests can exercise the factory branches directly.
 *
 * @param {import('./config.js').NormalizedConfig} config
 * @param {{info,warn,error,debug}} logger
 * @param {Function|null} getMongooseFn  - () => mongoose instance
 * @returns {Promise<HookBus|NoopHookBus>}
 */
export async function defaultHookBusFactory(config, logger, getMongooseFn) {
  if (!config.hooks?.enabled) {
    return new NoopHookBus();
  }

  const mongoose = await getMongooseFn?.();
  if (!mongoose) {
    logger.warn('hooks enabled but mongoose unavailable; using NoopHookBus');
    return new NoopHookBus();
  }

  const repo = _makeHookRepo(mongoose);

  return new HookBus({
    repo,
    timeoutMs: config.hooks.timeout_ms,
    logger,
  });
}

/**
 * Build the appropriate InboxNotifier based on config.
 *
 * - `config.inbox.enabled = false` → NoopInboxNotifier.
 * - `config.inbox.enabled = true` but `getInboxDirFor` is null → NoopInboxNotifier + warn.
 * - Otherwise → DynamicInboxNotifier: a shim that calls getInboxDirFor(workspaceId)
 *   at notification time and delegates to a per-workspace InboxNotifier.
 *   The Reaper also receives the bare `inboxDirFor` ref so it can scope its calls.
 *
 * Exported so tests can exercise the factory branches directly.
 *
 * @param {import('./config.js').NormalizedConfig} config
 * @param {{info,warn,error,debug}} logger
 * @param {Function|null} getInboxDirFor  - (workspaceId) => string path
 * @returns {InboxNotifier|NoopInboxNotifier}
 */
export function defaultInboxNotifierFactory(config, logger, getInboxDirFor) {
  if (!config.inbox?.enabled) {
    return new NoopInboxNotifier();
  }

  if (!getInboxDirFor) {
    logger.warn('inbox.enabled=true but no getInboxDirFor provided; using NoopInboxNotifier');
    return new NoopInboxNotifier();
  }

  // Return a dynamic notifier that creates a per-workspace InboxNotifier at call time.
  // This avoids the need for a fixed inboxDir at daemon startup.
  return {
    /** @type {true} */
    _dynamic: true,
    async notifyWorkspaceReaped({ workspaceId, synapsUserId, reason, details } = {}) {
      const inboxDir = getInboxDirFor(workspaceId);
      if (!inboxDir) {
        logger.warn('InboxNotifier: no inboxDir for workspaceId', { workspaceId });
        return { written: false, reason: 'no_inbox_dir' };
      }
      const notifier = new InboxNotifier({ inboxDir, logger });
      return notifier.notifyWorkspaceReaped({ workspaceId, synapsUserId, reason, details });
    },
  };
}

/**
 * Build the appropriate IdentityRouter based on config.
 *
 * - `config.identity.enabled = false` → NoOpIdentityRouter (Phase 2 behaviour preserved).
 * - Otherwise → lazy-import mongoose models + repos, connect, return IdentityRouter.
 *   Falls back to NoOpIdentityRouter if mongo connect fails.
 *
 * Exported so tests can exercise the factory branches directly.
 *
 * @param {object} opts
 * @param {import('./config.js').NormalizedConfig} opts.config
 * @param {object} opts.logger
 * @returns {Promise<import('./core/identity-router.js').IdentityRouter|import('./core/identity-router.js').NoOpIdentityRouter>}
 */
export async function defaultIdentityRouterFactory({ config, logger }) {
  if (!config.identity?.enabled) {
    logger.info('[bridge/index] identity.enabled=false — using NoOpIdentityRouter');
    return new NoOpIdentityRouter({ logger });
  }
  // Lazy-require to avoid pulling mongoose unless enabled.
  const { getMongoose: getMongooseConn } = await import('./core/db/connect.js');
  const {
    getSynapsUserModel,
    getSynapsChannelIdentityModel,
    getSynapsLinkCodeModel,
    UserRepo,
    ChannelIdentityRepo,
    LinkCodeRepo,
  } = await import('./core/db/index.js');
  const { IdentityRouter } = await import('./core/identity-router.js');

  let mongooseInstance;
  try {
    mongooseInstance = await getMongooseConn(config.mongodb.uri);
  } catch (err) {
    logger.warn(`[bridge/index] identity: mongo connect failed (${err.message}) — falling back to NoOpIdentityRouter`);
    return new NoOpIdentityRouter({ logger });
  }

  const userRepo = new UserRepo({ model: getSynapsUserModel(mongooseInstance), logger });
  const channelIdentityRepo = new ChannelIdentityRepo({ model: getSynapsChannelIdentityModel(mongooseInstance), logger });
  const linkCodeRepo = new LinkCodeRepo({ model: getSynapsLinkCodeModel(mongooseInstance), logger });
  return new IdentityRouter({ userRepo, channelIdentityRepo, linkCodeRepo, logger });
}

/**
 * Default SessionRouter factory.
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
 * Phase 9 C3 note: when `useDockerWorkspace = true` a one-shot `synaps
 * tools_list --json` probe is executed synchronously.  On failure the factory
 * falls back to the host-mode SynapsRpc unless `config.rpc.strict = true`,
 * in which case an error is thrown and the daemon refuses to start.
 *
 * @param {import('./config.js').NormalizedConfig} config
 * @param {object} logger
 * @param {{ workspaceManager: WorkspaceManager, synapsUserIdResolver: Function, memoryGateway: MemoryGateway|NoopMemoryGateway }|null} scpDeps
 * @param {object} [opts]
 * @param {Function} [opts.execFileImpl]  - Injectable execFileSync replacement for tests.
 * @returns {SessionRouter}
 */
export function defaultSessionRouterFactory(config, logger, scpDeps = null, { execFileImpl = execFileSync } = {}) {
  const store = new SessionStore({ logger });
  const isScp = config.platform.mode === 'scp';
  // Even in SCP mode, allow opt-out of Docker workspace orchestration via
  // [rpc] host_mode = true.  Useful for development / smoke without an
  // installed synaps/workspace image.  The MCP wire protocol is unaffected.
  const useDockerWorkspace = isScp && !config.rpc.host_mode;

  // Build both factories up front so the probe fallback can re-assign.
  const dockerRpcFactory = ({ sessionId = null, model = null } = {}) =>
    new DockerExecSynapsRpc({
      workspaceManager: scpDeps.workspaceManager,
      synapsUserId: scpDeps.synapsUserIdResolver(),
      binPath: config.rpc.binary,
      sessionId,
      model: model ?? config.rpc.default_model,
      profile: config.rpc.default_profile || null,
      logger,
    });

  const hostRpcFactory = ({ sessionId = null, model = null } = {}) =>
    new SynapsRpc({
      binPath: config.rpc.binary,
      sessionId,
      model: model ?? config.rpc.default_model,
      profile: config.rpc.default_profile || null,
      logger,
    });

  let rpcFactory = useDockerWorkspace ? dockerRpcFactory : hostRpcFactory;

  // ── Phase 9 C3: one-shot rpcFactory probe ──────────────────────────────────
  if (useDockerWorkspace) {
    try {
      const stdout = execFileImpl(
        config.rpc.binary || 'synaps',
        ['tools_list', '--json'],
        { timeout: 5000, encoding: 'utf8' },
      );
      const tools = JSON.parse(typeof stdout === 'string' ? stdout : stdout.toString());
      if (!Array.isArray(tools)) throw new Error('tools_list did not return JSON array');
      logger.info?.(`[rpc] tools_list probe ok: ${tools.length} tool(s)`);
    } catch (err) {
      const msg = `[rpc] tools_list probe failed: ${err.message}`;
      if (config.rpc.strict) {
        throw new Error(`${msg} — refusing to start (rpc.strict = true)`);
      }
      logger.warn?.(`${msg} — falling back to host_mode for this run (set rpc.strict = true to make this fatal)`);
      rpcFactory = hostRpcFactory;
    }
  }

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
 * @param {{ auth: object, sessionRouter: SessionRouter, memoryGateway: MemoryGateway|NoopMemoryGateway, identityRouter: object, logger: object }} opts
 * @returns {SlackAdapter}
 */
function defaultSlackAdapterFactory({ auth, sessionRouter, memoryGateway, identityRouter, logger }) {
  return new SlackAdapter({ sessionRouter, auth, memoryGateway, identityRouter, logger });
}

/**
 * Default ControlSocket factory.
 *
 * @param {{ sessionRouter: SessionRouter, identityRouter: object, logger: object, version: string }} opts
 * @returns {ControlSocket}
 */
function defaultControlSocketFactory({ sessionRouter, identityRouter, credBroker, hookBus, mcpTokenRepo, mcpToolAclRepo, mcpToolAclResolver, logger, version }) { // eslint-disable-line no-unused-vars
  return new ControlSocket({ sessionRouter, identityRouter, credBroker, hookBus, mcpTokenRepo, mcpToolAclRepo, mcpToolAclResolver, logger, version });
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
   * @param {Function} [opts.identityRouterFactory]    - ({ config, logger }) => Promise<IdentityRouter|NoOpIdentityRouter> — injectable for tests.
   * @param {Function} [opts.credBrokerFactory]        - (config, logger) => CredBroker|NoopCredBroker — injectable for tests.
   * @param {Function} [opts.heartbeatFactory]         - async (config, logger, getMongoose, extras) => {repo,emitter,reaper}|null — injectable for tests.
   * @param {Function} [opts.schedulerFactory]         - async (config, logger, getMongoose, getDispatcher) => Scheduler|NoopScheduler — injectable for tests.
   * @param {Function} [opts.hookBusFactory]           - async (config, logger, getMongoose) => HookBus|NoopHookBus — injectable for tests.
   * @param {Function} [opts.inboxNotifierFactory]     - (config, logger, getInboxDirFor) => InboxNotifier|NoopInboxNotifier — injectable for tests.
   * @param {Function} [opts.inboxDirFor]              - (workspaceId) => string — injected inbox dir resolver; null in most deployments.
   * @param {Function} [opts.mcpServerFactory]         - async (config, logger, db) => McpServer|null — injectable for tests.
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
    identityRouterFactory = null,
    credBrokerFactory = null,
    heartbeatFactory = null,
    schedulerFactory = null,
    hookBusFactory = null,
    inboxNotifierFactory = null,
    inboxDirFor = null,
    mcpServerFactory = null,
    execFileImpl = null,
  } = {}) {
    super();

    this._config = config;
    this.logger = logger;
    this._env = env;
    // execFileImpl: injectable for tests to override the probe's execFileSync call.
    this._execFileImpl = execFileImpl ?? execFileSync;
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

    // Identity router factory (test-injectable).
    this._identityRouterFactory = identityRouterFactory ?? defaultIdentityRouterFactory;

    // Cred broker factory (test-injectable).
    this._credBrokerFactory = credBrokerFactory ?? defaultCredBrokerFactory;

    // Heartbeat factory (test-injectable).
    this._heartbeatFactory = heartbeatFactory ?? defaultHeartbeatFactory;

    // Scheduler / HookBus / InboxNotifier factories (test-injectable).
    this._schedulerFactory     = schedulerFactory     ?? defaultSchedulerFactory;
    this._hookBusFactory       = hookBusFactory       ?? defaultHookBusFactory;
    this._inboxNotifierFactory = inboxNotifierFactory ?? defaultInboxNotifierFactory;
    this._inboxDirFor          = inboxDirFor          ?? null;

    // MCP server factory (test-injectable).
    this._mcpServerFactory = mcpServerFactory ?? null;  // null → build inline when mcp.enabled

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
    this._workspaceRepo    = null;
    /** @type {ScpHttpServer|null} */
    this._scpHttpServer = null;

    // Memory gateway (built in start(), available in both bridge and SCP mode).
    /** @type {MemoryGateway|NoopMemoryGateway|null} */
    this._memoryGateway = null;

    // Cred broker (built in start(), available in both bridge and SCP mode).
    /** @type {CredBroker|NoopCredBroker|null} */
    this._credBroker = null;

    // Supervisor (built in start() when supervisor.enabled = true and mongoose available).
    /** @type {{repo: object, emitter: HeartbeatEmitter, reaper: Reaper}|null} */
    this.supervisor = null;

    // Phase 6 new subsystems.
    /** @type {Scheduler|NoopScheduler|null} */
    this._scheduler = null;
    /** @type {HookBus|NoopHookBus|null} */
    this._hookBus = null;
    /** @type {InboxNotifier|NoopInboxNotifier|object|null} */
    this._inboxNotifier = null;

    // Phase 7 MCP server.
    /** @type {object|null} McpServer or null when disabled */
    this._mcpServer = null;

    /** @type {object|null} McpTokenRepo instance — reused by ControlSocket */
    this._mcpTokenRepo = null;

    // Phase 8 MCP subsystems.
    /** @type {object|null} McpRateLimiter or null when disabled */
    this._mcpRateLimiter = null;
    /** @type {object|null} McpDcrHandler or null when disabled */
    this._mcpDcrHandler = null;

    // Phase 9 Wave C: ACL + Metrics.
    /** @type {object|null} McpToolAclRepo or null when disabled */
    this._mcpToolAclRepo = null;
    /** @type {object|null} McpToolAclResolver or null when disabled */
    this._mcpToolAclResolver = null;
    /** @type {object|null} MetricsRegistry or null when disabled */
    this._metricsRegistry = null;
    /** @type {ReturnType<typeof setInterval>|null} daemon-level metrics poll interval */
    this._metricsInterval = null;

    // Identity router (built in start()).
    /** @type {import('./core/identity-router.js').IdentityRouter|import('./core/identity-router.js').NoOpIdentityRouter|null} */
    this._identityRouter = null;

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

    // 0b. Identity router (always built; NoOp when disabled).
    this._identityRouter = await this._identityRouterFactory({ config: this._config, logger: this.logger });

    // 0c. Cred broker (always built; Noop when disabled).
    this._credBroker = this._credBrokerFactory(this._config, this.logger);
    this.logger.info?.(
      `BridgeDaemon: cred broker initialized (enabled=${this._config.creds?.enabled ?? false}, broker=${this._config.creds?.broker ?? 'noop'})`,
    );

    // ── SCP mode bootstrap ────────────────────────────────────────────────
    if (isScp) {
      // 1. Connect to MongoDB.
      this._mongoose = await this._mongoConnectFactory(this._config.mongodb.uri);

      // 2. Build repo + WorkspaceManager.
      const model = getSynapsWorkspaceModel(this._mongoose);
      const repo  = new WorkspaceRepo({ model, logger: this.logger });
      this._workspaceRepo = repo;  // stored so http server block can access it below

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
        credBroker: this._credBroker,
      };
    }

    // 4a. Supervisor (heartbeat + reaper) — runs in both bridge and scp modes.
    //     Built here (before the HTTP server) so heartbeatRepo is available to /health.
    //     In bridge mode getMongoose() returns null → defaultHeartbeatFactory yields null.
    //     Phase 6: build inboxNotifier first so Reaper gets it.
    this._inboxNotifier = this._inboxNotifierFactory(this._config, this.logger, this._inboxDirFor);

    const _getMongoose = () => this._mongoose;
    this.supervisor = await this._heartbeatFactory(
      this._config,
      this.logger,
      _getMongoose,
      {
        workspaceManager: this._workspaceManager ?? undefined,
        rpcKiller:        undefined,
        inboxNotifier:    this._inboxNotifier,
        inboxDirFor:      this._inboxDirFor,
      },
    );
    if (this.supervisor) {
      this.supervisor.emitter.start();
      this.supervisor.reaper.start();
      this.logger.info?.('supervisor started');
    }

    // ─── MCP ──────────────────────────────────────────────────────────────────
    // Built after supervisor so _mongoose is available; before HTTP server so
    // mcpServer can be passed to ScpHttpServer.

    // ── Phase 9 Wave C: MetricsRegistry (built before MCP block so it can be
    //    injected into McpToolRegistry, McpServer, and ScpHttpServer).
    if (this._config.metrics?.enabled) {
      const { MetricsRegistry } = await import('./core/metrics/metrics-registry.js');
      this._metricsRegistry = new MetricsRegistry();
      this.logger.info?.('[metrics] registry initialised');
    }

    if (isScp && this._config.mcp?.enabled) {
      let builtMcpServer = null;
      let builtRateLimiter = null;
      let builtDcrHandler = null;
      let builtOauthServer = null;
      try {
        if (this._mcpServerFactory) {
          // Test-injectable factory.
          builtMcpServer = await this._mcpServerFactory(this._config, this.logger, this._mongoose);
        } else {
          if (!this._mongoose) {
            throw new Error('mongoose unavailable');
          }
          // Defer import so disabled mode never loads MCP code.
          const { McpServer }           = await import('./core/mcp/mcp-server.js');
          const { McpTokenResolver }    = await import('./core/mcp/mcp-token-resolver.js');
          const { McpToolRegistry }     = await import('./core/mcp/mcp-tool-registry.js');
          const { McpApprovalGate }     = await import('./core/mcp/mcp-approval-gate.js');
          const { McpTokenRepo }        = await import('./core/db/repositories/mcp-token-repo.js');
          const { McpServerRepo }       = await import('./core/db/repositories/mcp-server-repo.js');
          const { McpAuditRepo }        = await import('./core/db/repositories/mcp-audit-repo.js');
          const { getSynapsMcpTokenModel } = await import('./core/db/models/synaps-mcp-token.js');
          const { getSynapsMcpAuditModel } = await import('./core/db/models/synaps-mcp-audit.js');

          // Three repos, three injection shapes:
          //   - McpTokenRepo:  { db: Model }      (Mongoose model)
          //   - McpAuditRepo:  { model: Model }   (Mongoose model)
          //   - McpServerRepo: { db: Connection } (raw connection — read-only adapter
          //                                         over pria's mcpservers collection)
          const tokenModel    = getSynapsMcpTokenModel(this._mongoose);
          const auditModel    = getSynapsMcpAuditModel(this._mongoose);
          const tokenRepo     = new McpTokenRepo({ db: tokenModel });
          const mcpServerRepo = new McpServerRepo({ db: this._mongoose.connection });
          const tokenResolver = new McpTokenResolver({ tokenRepo, logger: this.logger });

          // ── Phase 8 Track 1: Rate limiter ────────────────────────────────
          if (this._config.mcp.rate_limit?.enabled) {
            const { McpRateLimiter } = await import('./core/mcp/mcp-rate-limiter.js');
            builtRateLimiter = new McpRateLimiter({
              perToken: {
                capacity:    this._config.mcp.rate_limit.per_token_capacity,
                refillPerSec: this._config.mcp.rate_limit.per_token_refill,
              },
              perIp: {
                capacity:    this._config.mcp.rate_limit.per_ip_capacity,
                refillPerSec: this._config.mcp.rate_limit.per_ip_refill,
              },
              logger: this.logger,
            });
            this.logger.info?.('[mcp] rate limiter enabled');
          }

          // ── Phase 8 Track 4: DCR handler ─────────────────────────────────
          if (this._config.mcp.dcr?.enabled && this._config.mcp.dcr?.registration_secret) {
            const { McpDcrHandler } = await import('./core/mcp/mcp-dcr.js');
            builtDcrHandler = new McpDcrHandler({
              registrationSecret: this._config.mcp.dcr.registration_secret,
              tokenRepo,
              tokenTtlMs: this._config.mcp.dcr.token_ttl_ms,
              logger: this.logger,
            });
            this.logger.info?.('[mcp] DCR handler enabled');
          }

          // ── Phase 8 Track 2: per-tool surfacing via rpcRouter ─────────────
          let rpcRouter = null;
          if (this._config.mcp.surface_rpc_tools) {
            const { SynapsRpcSessionRouter } = await import('./core/synaps-rpc-session-router.js');
            const { spawn } = await import('node:child_process');
            // Real rpcFactory: spawn `synaps rpc` per probe, write the
            // requested op (translating router's `op:` → binary's `type:`),
            // and resolve with the parsed response frame.  Short-lived per
            // probe; SynapsRpcSessionRouter caches results for 60s by default.
            //
            // Phase 9 Track 5 promotion: requires `synaps` binary ≥ v0.1.6
            // which ships the `tools_list` rpc op (SynapsCLI PR #44).
            const binPath = this._config.rpc.binary || 'synaps';
            const surfacingLogger = this.logger;
            const surfacingRpcFactory = async (_synapsUserId) => ({
              send: async (op) => {
                return await new Promise((resolve) => {
                  const child = spawn(binPath, ['rpc'], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                  });
                  let buf = '';
                  let settled = false;
                  const settle = (v) => {
                    if (settled) return;
                    settled = true;
                    try { child.kill('SIGTERM'); } catch (_e) {}
                    resolve(v);
                  };
                  const timer = setTimeout(() => settle({ ok: false, error: 'probe_timeout' }), 8000);
                  if (typeof timer.unref === 'function') timer.unref();

                  child.on('error', (err) => {
                    surfacingLogger?.warn?.(`[mcp] surface probe spawn error: ${err.message}`);
                    clearTimeout(timer);
                    settle({ ok: false, error: 'spawn_error' });
                  });
                  child.stderr?.on('data', () => {});

                  child.stdout.on('data', (chunk) => {
                    buf += chunk.toString();
                    let idx;
                    while ((idx = buf.indexOf('\n')) !== -1) {
                      const line = buf.slice(0, idx).trim();
                      buf = buf.slice(idx + 1);
                      if (!line) continue;
                      let frame;
                      try { frame = JSON.parse(line); } catch { continue; }
                      if (frame.type === 'ready') {
                        // Translate `op:` (router) → `type:` (binary).
                        try {
                          child.stdin.write(JSON.stringify({ ...op, type: op.op }) + '\n');
                        } catch (_e) {
                          clearTimeout(timer);
                          settle({ ok: false, error: 'stdin_write_failed' });
                        }
                      } else if (frame.type === 'response' && frame.command === op.op) {
                        clearTimeout(timer);
                        settle({ ok: frame.ok === true, tools: frame.tools, error: frame.error });
                      } else if (frame.type === 'error') {
                        clearTimeout(timer);
                        settle({ ok: false, error: frame.message || 'rpc_error' });
                      }
                    }
                  });
                });
              },
            });
            rpcRouter = new SynapsRpcSessionRouter({
              rpcFactory: surfacingRpcFactory,
              logger: this.logger,
            });
            this.logger.info?.('[mcp] surface_rpc_tools enabled (rpcRouter wired — real spawn)');
          }

          // ── Phase 9 Wave C: ACL resolver ─────────────────────────────────
          let aclResolver = null;
          let aclRepo     = null;
          if (this._config.mcp.acl?.enabled) {
            const { getSynapsMcpToolAclModel } = await import('./core/db/models/synaps-mcp-tool-acl.js');
            const { McpToolAclRepo }            = await import('./core/db/repositories/mcp-tool-acl-repo.js');
            const { McpToolAclResolver }        = await import('./core/mcp/mcp-tool-acl-resolver.js');
            const aclModel = getSynapsMcpToolAclModel(this._mongoose);
            aclRepo     = new McpToolAclRepo({ model: aclModel, logger: this.logger });
            aclResolver = new McpToolAclResolver({ repo: aclRepo, logger: this.logger });
            this._mcpToolAclRepo     = aclRepo;
            this._mcpToolAclResolver = aclResolver;
            this.logger.info?.('[mcp] ACL resolver enabled');
          }

          const toolRegistry  = new McpToolRegistry({
            getSessionRouter: () => this._sessionRouter,   // lazy: built after MCP
            rpcRouter,
            surfaceRpcTools: this._config.mcp.surface_rpc_tools,
            chatTimeoutMs:   this._config.mcp.chat_timeout_ms,
            metrics:         this._metricsRegistry ?? null,
            logger:          this.logger,
          });
          const approvalGate  = new McpApprovalGate({
            mcpServerRepo,
            policyName: this._config.mcp.policy_name,
            logger:     this.logger,
          });
          const audit = this._config.mcp.audit
            ? { record: (entry) => new McpAuditRepo({ model: auditModel, logger: this.logger }).record(entry) }
            : { record: async () => {} };

          // Store tokenRepo so ControlSocket can use it for mcp_token_* ops.
          this._mcpTokenRepo = tokenRepo;

          builtMcpServer = new McpServer({
            tokenResolver,
            toolRegistry,
            approvalGate,
            audit,
            rateLimiter: builtRateLimiter,
            sseEnabled:    this._config.mcp.sse?.enabled ?? false,
            streamDeltas:  this._config.mcp.sse?.stream_deltas ?? false,
            aclResolver: aclResolver ?? null,
            metrics:     this._metricsRegistry ?? null,
            logger: this.logger,
          });

          // ── Phase 9 Track 3: OAuth 2.1 + PKCE ────────────────────────────
          if (this._config.mcp.oauth?.enabled) {
            try {
              const { getSynapsOauthCodeModel } = await import('./core/db/models/synaps-oauth-code.js');
              const { OauthCodeRepo }           = await import('./core/mcp/oauth/oauth-code-repo.js');
              const { OauthMetadataHandler }    = await import('./core/mcp/oauth/oauth-metadata-handler.js');
              const { OauthAuthorizeHandler }   = await import('./core/mcp/oauth/oauth-authorize-handler.js');
              const { OauthTokenHandler }       = await import('./core/mcp/oauth/oauth-token-handler.js');
              const { OauthServer }             = await import('./core/mcp/oauth/oauth-server.js');

              const codeModel       = getSynapsOauthCodeModel(this._mongoose);
              const codeRepo        = new OauthCodeRepo({ model: codeModel, logger: this.logger });
              const metadataHandler = new OauthMetadataHandler({ config: this._config.mcp.oauth, logger: this.logger });
              const authorizeHandler = new OauthAuthorizeHandler({
                config:         this._config.mcp.oauth,
                codeRepo,
                tokenRepo,
                identityRouter: this._identityRouter,
                logger:         this.logger,
              });
              const tokenHandler = new OauthTokenHandler({
                config:   this._config.mcp.oauth,
                codeRepo,
                tokenRepo,
                logger:   this.logger,
              });
              builtOauthServer = new OauthServer({
                config:           this._config.mcp.oauth,
                authorizeHandler,
                tokenHandler,
                metadataHandler,
                logger:           this.logger,
              });
              this.logger.info?.('[mcp] OAuth 2.1 server enabled');
            } catch (err) {
              this.logger.warn?.(`[mcp] OAuth init failed — disabling OAuth: ${err.message}`);
              builtOauthServer = null;
            }
          }
        }
        this.logger.info?.('[mcp] enabled');
      } catch (err) {
        this.logger.warn?.(`[mcp] failed to initialise — running without MCP: ${err.message}`);
        builtMcpServer = null;
      }
      this._mcpServer = builtMcpServer;
      this._mcpRateLimiter = builtRateLimiter;
      this._mcpDcrHandler  = builtDcrHandler;
      this._oauthServer    = builtOauthServer;
    }

    // 4b. Optional HTTP server + VNC proxy (SCP mode only).
    //     heartbeatRepo is now available from the supervisor built above.
    if (isScp && this._config.web.enabled) {
      const heartbeatRepo = this.supervisor ? this.supervisor.repo : null;
      let scpServer;
      if (this._scpHttpServerFactory) {
        scpServer = this._scpHttpServerFactory({
          config: this._config,
          repo: this._workspaceRepo,
          heartbeatRepo,
          logger: this.logger,
        });
      } else {
        const vncProxy = new VncProxy({ repo: this._workspaceRepo, logger: this.logger });
        scpServer = new ScpHttpServer({
          config: this._config,
          vncProxy,
          heartbeatRepo,
          bridgeCriticalMs: this._config.supervisor?.bridge_critical_ms,
          mcpServer:       this._mcpServer,
          rateLimiter:     this._mcpRateLimiter ?? null,
          sseEnabled:      this._config.mcp?.sse?.enabled ?? false,
          dcrHandler:      this._mcpDcrHandler ?? null,
          oauthServer:     this._oauthServer ?? null,
          metricsRegistry: this._metricsRegistry ?? null,
          metricsConfig:   this._config.metrics ?? null,
          logger: this.logger,
        });
      }
      this._scpHttpServer = scpServer;
      await this._scpHttpServer.start();
    }

    // 4c. HookBus — built after supervisor + HTTP server, before slackAdapter.
    // Hooks must exist when first events fire.
    this._hookBus = await this._hookBusFactory(this._config, this.logger, _getMongoose);

    // 1. Session router.
    this._sessionRouter = this._sessionRouterFactory(this._config, this.logger, scpDeps, { execFileImpl: this._execFileImpl });
    await this._sessionRouter.start();

    // 2. Slack adapter (if enabled).
    if (this._config.sources.slack.enabled) {
      const auth = readSlackAuth(this._env);
      this._slackAdapter = this._slackAdapterFactory({
        auth,
        sessionRouter: this._sessionRouter,
        memoryGateway: this._memoryGateway,
        identityRouter: this._identityRouter,
        logger: this.logger,
      });
      await this._slackAdapter.start();
    }

    // 3. Control socket (pass hookBus + scheduler when ready).
    this._controlSocket = this._controlSocketFactory({
      sessionRouter: this._sessionRouter,
      identityRouter: this._identityRouter,
      credBroker: this._credBroker,
      hookBus: this._hookBus,
      mcpTokenRepo:        this._mcpTokenRepo,
      mcpToolAclRepo:      this._mcpToolAclRepo      ?? null,
      mcpToolAclResolver:  this._mcpToolAclResolver  ?? null,
      logger: this.logger,
      version: '0.1.0',
    });
    await this._controlSocket.start();

    // 4. Scheduler — built last (needs the dispatch surface to exist).
    const _getDispatcher = () => null; // v0 dispatcher stub — Wave C wires the real one
    this._scheduler = await this._schedulerFactory(this._config, this.logger, _getMongoose, _getDispatcher);

    // ── Phase 9 Wave C: daemon-level metrics gauges ───────────────────────────
    // Start a 5-second poll interval for:
    //   synaps_mongoose_connection_state — 1 when mongoose readyState=1, else 0
    //   synaps_bridge_heartbeat_age_seconds — seconds since last bridge heartbeat
    if (this._metricsRegistry) {
      const mongoGauge     = this._metricsRegistry.gauge('synaps_mongoose_connection_state', {
        help: 'Mongoose connection readyState (1 = connected, 0 = disconnected)',
      });
      const heartbeatGauge = this._metricsRegistry.gauge('synaps_bridge_heartbeat_age_seconds', {
        help: 'Seconds elapsed since the last bridge heartbeat was recorded',
      });
      const handle = setInterval(() => {
        // mongoose connection state
        const readyState = this._mongoose?.connection?.readyState ?? 0;
        mongoGauge.set({}, readyState === 1 ? 1 : 0);
        // bridge heartbeat age
        if (this.supervisor?.bridgeHeartbeatAt) {
          heartbeatGauge.set({}, (Date.now() - this.supervisor.bridgeHeartbeatAt) / 1000);
        } else {
          heartbeatGauge.set({}, 0);
        }
      }, 5_000);
      if (typeof handle.unref === 'function') handle.unref();
      this._metricsInterval = handle;
    }

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

    // Clear metrics poll interval early so no more writes happen during teardown.
    if (this._metricsInterval) {
      clearInterval(this._metricsInterval);
      this._metricsInterval = null;
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

    // Supervisor — emitter first (final shutdown beat), then reaper.
    if (this.supervisor) {
      try { await this.supervisor.emitter.stop(); } catch (e) { this.logger.warn?.(`BridgeDaemon: supervisor emitter stop failed: ${e.message}`); }
      try { this.supervisor.reaper.stop();        } catch (e) { this.logger.warn?.(`BridgeDaemon: supervisor reaper stop failed: ${e.message}`); }
      this.logger.info?.('supervisor stopped');
    }

    // Phase 6 teardown: scheduler → hookBus → inboxNotifier (best-effort each).
    if (this._scheduler && typeof this._scheduler.stop === 'function') {
      try {
        await this._scheduler.stop();
      } catch (err) {
        this.logger.warn?.(`BridgeDaemon: scheduler stop error: ${err.message}`);
      }
    }

    if (this._hookBus && typeof this._hookBus.stop === 'function') {
      try {
        await this._hookBus.stop();
      } catch (err) {
        this.logger.warn?.(`BridgeDaemon: hookBus stop error: ${err.message}`);
      }
    }

    if (this._inboxNotifier && typeof this._inboxNotifier.stop === 'function') {
      try {
        await this._inboxNotifier.stop();
      } catch (err) {
        this.logger.warn?.(`BridgeDaemon: inboxNotifier stop error: ${err.message}`);
      }
    }

    // Cred broker — clear cache after memory gateway.
    if (this._credBroker && typeof this._credBroker.clear === 'function') {
      this._credBroker.clear();
      this.logger.info?.('BridgeDaemon: cred broker shutdown');
    }

    this.emit('stopped');
    this.logger.info?.('BridgeDaemon: stopped');

    if (typeof this._onShutdown === 'function') {
      this._onShutdown();
    }
  }
}
