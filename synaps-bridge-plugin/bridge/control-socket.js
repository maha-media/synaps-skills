/**
 * @file bridge/control-socket.js
 *
 * Unix stream socket server for daemon ↔ slash-command IPC.
 *
 * DEVIATION FROM SPEC: The spec text in §5.6 says "Unix datagram socket".
 * This implementation uses a Unix *stream* socket (SOCK_STREAM) instead.
 * Rationale: Node's `node:net` `createServer` only supports stream sockets on
 * Unix domain paths.  Datagram UDS requires `createSocket('unix_dgram')` from
 * a native addon or raw dgram, and its request/response exchange semantics are
 * awkward (no connection state).  Stream sockets give us clean per-request
 * framing: one JSON request line in, one JSON response line out, then the
 * connection is closed.  The CLI client (Task 13) connects, writes a line,
 * reads a line, and disconnects — identical UX to the datagram model the spec
 * describes.
 *
 * Phase 3 additions
 * ─────────────────
 * • `identityRouter` (optional) — injected via constructor.  Required for the
 *   new `link_code_issue`, `link_code_redeem`, and `identity_resolve_web` ops.
 * • `chat_stream_start` — long-lived streaming op.  Unlike other ops which
 *   return a single JSON line and close, this op keeps the socket open and
 *   emits one `{ kind:'chunk', chunk:{...} }` JSON line per RPC chunk, then
 *   closes with `{ kind:'done' }` or `{ kind:'error', message }`.
 *
 * No I/O in constructor.  All side effects are in start() / stop().
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CredsValidationError,
  CredsUnavailableError,
  CredBrokerDisabledError,
} from './core/cred-broker.js';
import {
  InfisicalNotFoundError,
  InfisicalAuthError,
  InfisicalUpstreamError,
} from './core/cred-broker/infisical-client.js';
import { SchedulerDisabledError } from './core/scheduler.js';

/** Default socket path. */
export const DEFAULT_SOCKET_PATH = path.join(
  os.homedir(),
  '.synaps-cli',
  'bridge',
  'control.sock',
);

// ─── ControlSocket ────────────────────────────────────────────────────────────

export class ControlSocket extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {string}   [opts.socketPath]         - UDS path (default: DEFAULT_SOCKET_PATH).
   * @param {import('./core/session-router.js').SessionRouter} opts.sessionRouter
   * @param {object}   [opts.identityRouter]     - IdentityRouter / NoOpIdentityRouter (optional).
   * @param {object}   [opts.credBroker]         - CredBroker / NoopCredBroker (optional). Required for
   *                                               the `cred_broker_use` op. Injected by BridgeDaemon.
   * @param {object}   [opts.scheduler]          - Scheduler / NoopScheduler (optional, Phase 6).
   * @param {object}   [opts.hookBus]            - HookBus / NoopHookBus (optional, Phase 6).
   * @param {object}   [opts.hookRepo]           - HookRepo (optional, Phase 6). Used by hook_create/list/remove ops.
   * @param {object}   [opts.scheduledTaskRepo]  - ScheduledTaskRepo (optional, Phase 6). Used directly by
   *                                               scheduled_task_remove for ownership check.
   * @param {object}   [opts.heartbeatRepo]      - HeartbeatRepo (optional, Phase 6). Required for heartbeat_emit.
   * @param {object}   [opts.workspaceRepo]      - WorkspaceRepo (optional, Phase 6). Used for ownership check on heartbeat_emit.
   * @param {object}   [opts.logger]             - Logger (default: console).
   * @param {string}   [opts.version]            - Daemon version string (default: "0.1.0").
   * @param {Function} [opts.nowMs]              - Returns current epoch ms (injectable for tests).
   * @param {object}   [opts._net]               - node:net override (injectable for tests).
   * @param {object}   [opts._fs]                - fs override (injectable for tests).
   */
  constructor({
    socketPath = DEFAULT_SOCKET_PATH,
    sessionRouter,
    identityRouter = null,
    credBroker = null,
    scheduler = null,
    hookBus = null,
    hookRepo = null,
    scheduledTaskRepo = null,
    heartbeatRepo = null,
    workspaceRepo = null,
    logger = console,
    version = '0.1.0',
    nowMs = () => Date.now(),
    _net = net,
    _fs = fs,
  } = {}) {
    super();

    this._socketPath         = socketPath;
    this._router             = sessionRouter;
    this._identityRouter     = identityRouter;
    this._credBroker         = credBroker;
    this._scheduler          = scheduler;
    this._hookBus            = hookBus;
    this._hookRepo           = hookRepo;
    this._scheduledTaskRepo  = scheduledTaskRepo;
    this._heartbeatRepo      = heartbeatRepo;
    this._workspaceRepo      = workspaceRepo;
    this.logger              = logger;
    this._version            = version;
    this._nowMs              = nowMs;
    this._net                = _net;
    this._fs                 = _fs;

    /** @type {net.Server|null} */
    this._server = null;
    /** Epoch ms when start() completed. */
    this._startedAt = 0;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Unlink any stale socket file, start the server, chmod 0o600.
   * @returns {Promise<void>}
   */
  async start() {
    if (this._server) return; // idempotent

    // Unlink stale socket file.
    try {
      this._fs.unlinkSync(this._socketPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger.warn(`ControlSocket: could not unlink stale socket: ${err.message}`);
      }
    }

    this._server = this._net.createServer((socket) => this._handleConnection(socket));

    this._server.on('error', (err) => {
      this.logger.warn(`ControlSocket: server error: ${err.message}`);
      this.emit('error', err);
    });

    // Wait for the server to start listening.
    await new Promise((resolve, reject) => {
      this._server.listen(this._socketPath, () => {
        resolve();
      });
      this._server.once('error', reject);
    });

    // Restrict permissions.
    try {
      this._fs.chmodSync(this._socketPath, 0o600);
    } catch (err) {
      this.logger.warn(`ControlSocket: could not chmod socket: ${err.message}`);
    }

    this._startedAt = this._nowMs();
    this.logger.info?.(`ControlSocket: listening on ${this._socketPath}`);
  }

  /**
   * Close server and unlink socket.  Idempotent.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._server) return;

    const server = this._server;
    this._server = null;

    await new Promise((resolve) => {
      server.close(() => resolve());
    });

    try {
      this._fs.unlinkSync(this._socketPath);
    } catch {
      // best-effort
    }
  }

  // ── connection handler ────────────────────────────────────────────────────

  /**
   * Handle one client connection: read one JSON line, write one JSON line,
   * then destroy the socket.
   *
   * Exception: `chat_stream_start` keeps the connection open and writes
   * multiple JSON lines until the session ends.
   *
   * @param {net.Socket} socket
   */
  _handleConnection(socket) {
    let buf = '';

    socket.setEncoding('utf8');

    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return; // incomplete line — keep buffering

      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);

      this._dispatchRequest(line, socket);
    });

    socket.on('error', (err) => {
      this.logger.warn(`ControlSocket: socket error: ${err.message}`);
    });
  }

  /**
   * Parse and dispatch a request line.
   *
   * For most ops: calls `_handleOp`, writes one JSON response line, ends socket.
   * For `chat_stream_start`: enters streaming mode — writes multiple lines,
   * ends socket on done/error, does NOT call `_respond`.
   *
   * @param {string}     line
   * @param {net.Socket} socket
   */
  async _dispatchRequest(line, socket) {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      await this._respond(socket, { ok: false, error: 'malformed request' });
      return;
    }

    this.emit('request', req);

    // ── streaming op ──────────────────────────────────────────────────────
    if (req.op === 'chat_stream_start') {
      await this._opChatStreamStart(req, socket);
      return;
    }

    // ── standard request/response op ─────────────────────────────────────
    let resp;
    try {
      resp = await this._handleOp(req);
    } catch (err) {
      this.logger.warn(`ControlSocket: unhandled error in op "${req.op}": ${err.message}`);
      resp = { ok: false, error: err.message };
    }

    await this._respond(socket, resp);
  }

  /**
   * Write a JSON response line and destroy the socket.
   *
   * @param {net.Socket} socket
   * @param {object}     payload
   * @returns {Promise<void>}
   */
  _respond(socket, payload) {
    return new Promise((resolve) => {
      const line = JSON.stringify(payload) + '\n';
      socket.end(line, () => resolve());
    });
  }

  // ── op dispatch ───────────────────────────────────────────────────────────

  /**
   * @param {object} req
   * @returns {Promise<object>}
   */
  async _handleOp(req) {
    switch (req.op) {
      case 'threads':             return this._opThreads();
      case 'model':               return this._opModel(req);
      case 'reap':                return this._opReap(req);
      case 'status':              return this._opStatus();
      case 'link_code_issue':     return this._opLinkCodeIssue(req);
      case 'link_code_redeem':    return this._opLinkCodeRedeem(req);
      case 'identity_resolve_web': return this._opIdentityResolveWeb(req);
      case 'cred_broker_use':     return this._opCredBrokerUse(req);
      // Phase 6 ops
      case 'heartbeat_emit':          return this._opHeartbeatEmit(req);
      case 'scheduled_task_create':   return this._opScheduledTaskCreate(req);
      case 'scheduled_task_list':     return this._opScheduledTaskList(req);
      case 'scheduled_task_remove':   return this._opScheduledTaskRemove(req);
      case 'hook_create':             return this._opHookCreate(req);
      case 'hook_list':               return this._opHookList(req);
      case 'hook_remove':             return this._opHookRemove(req);
      default:
        return { ok: false, error: `unknown op: ${req.op}` };
    }
  }

  // ── individual ops ────────────────────────────────────────────────────────

  async _opThreads() {
    const sessions = await this._router.listSessions();
    const threads = sessions.map(({ key, source, conversation, thread, model, sessionId, lastActiveAt, inFlight }) => ({
      key,
      source,
      conversation,
      thread,
      model,
      sessionId,
      lastActiveAt,
      inFlight,
    }));
    return { ok: true, threads };
  }

  async _opModel(req) {
    const { key, model } = req;
    if (!key) return { ok: false, error: 'missing key' };
    if (!model) return { ok: false, error: 'missing model' };

    // Find the live rpc for this key.
    const sessions = this._router.liveSessions();
    const entry = sessions.find((s) => s.key === key);
    if (!entry) return { ok: false, error: 'unknown key' };

    try {
      await entry.rpc.setModel(model);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async _opReap(req) {
    const { key } = req;
    if (!key) return { ok: false, error: 'missing key' };

    const sessions = this._router.liveSessions();
    const entry = sessions.find((s) => s.key === key);
    if (!entry) return { ok: false, error: 'unknown key' };

    // Parse key back into {source, conversation, thread}.
    const parts = key.split(':');
    if (parts.length < 3) return { ok: false, error: `invalid key format: ${key}` };
    const [source, conversation, ...rest] = parts;
    const thread = rest.join(':');

    try {
      await this._router.closeSession({ source, conversation, thread });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  _opStatus() {
    const now = this._nowMs();
    const uptimeSecs = this._startedAt > 0
      ? Math.floor((now - this._startedAt) / 1000)
      : 0;
    const sessions = this._router.liveSessions().length;
    return Promise.resolve({
      ok: true,
      uptime_secs: uptimeSecs,
      sessions,
      version: this._version,
    });
  }

  // ── identity ops ──────────────────────────────────────────────────────────

  /**
   * Issue a 6-char link code for a logged-in pria user.
   *
   * Request: { op:'link_code_issue', pria_user_id, institution_id?, display_name?, ttl_secs? }
   * Response: { ok:true, code, expires_at } | { ok:false, error }
   *
   * @param {object} req
   * @returns {Promise<object>}
   */
  async _opLinkCodeIssue(req) {
    if (!this._identityRouter || this._identityRouter.enabled === false) {
      return { ok: false, error: 'identity disabled' };
    }

    const { pria_user_id, institution_id = null, display_name = null, ttl_secs = 300 } = req;

    if (!pria_user_id) return { ok: false, error: 'missing pria_user_id' };

    try {
      const result = await this._identityRouter.issueLinkCode({
        pria_user_id,
        institution_id,
        display_name,
        ttl_ms: ttl_secs * 1000,
      });
      return { ok: true, code: result.code, expires_at: result.expires_at };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Redeem a link code from a non-web channel (e.g. Slack).
   *
   * Request: { op:'link_code_redeem', code, channel, external_id, external_team_id?, display_name? }
   * Response: { ok:true, synaps_user_id, was_relinked } | { ok:false, error }
   *
   * @param {object} req
   * @returns {Promise<object>}
   */
  async _opLinkCodeRedeem(req) {
    if (!this._identityRouter || this._identityRouter.enabled === false) {
      return { ok: false, error: 'identity disabled' };
    }

    const { code, channel, external_id, external_team_id = '', display_name = null } = req;

    if (!code)        return { ok: false, error: 'missing code' };
    if (!channel)     return { ok: false, error: 'missing channel' };
    if (!external_id) return { ok: false, error: 'missing external_id' };

    try {
      const result = await this._identityRouter.redeemLinkCode({
        code,
        channel,
        external_id,
        external_team_id,
        display_name,
      });

      // result: { ok, synaps_user_id, was_relinked } | { ok:false, reason }
      if (!result.ok) {
        return { ok: false, error: result.reason ?? 'redeem failed' };
      }
      return {
        ok: true,
        synaps_user_id: result.synaps_user_id,
        was_relinked: result.was_relinked,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Resolve a web user to a SynapsUser (creates one if needed).
   *
   * Request: { op:'identity_resolve_web', pria_user_id, institution_id?, display_name? }
   * Response: { ok:true, synaps_user_id, is_new, memory_namespace } | { ok:false, error }
   *
   * @param {object} req
   * @returns {Promise<object>}
   */
  async _opIdentityResolveWeb(req) {
    if (!this._identityRouter || this._identityRouter.enabled === false) {
      return { ok: false, error: 'identity disabled' };
    }

    const { pria_user_id, institution_id = null, display_name = null } = req;

    if (!pria_user_id) return { ok: false, error: 'missing pria_user_id' };

    try {
      const { synapsUser, isNew } = await this._identityRouter.resolveWebUser({
        pria_user_id,
        institution_id,
        display_name,
      });

      return {
        ok: true,
        synaps_user_id: String(synapsUser._id),
        is_new: isNew,
        memory_namespace: synapsUser.memory_namespace,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ── Phase 6 ops ───────────────────────────────────────────────────────────────

  /**
   * heartbeat_emit — Watcher pushes workspace/rpc/agent heartbeats from inside
   * the container to HeartbeatRepo.
   *
   * Request:  { op:'heartbeat_emit', component, id, healthy?, details?, synaps_user_id }
   * Response: { ok:true, ts } | { ok:true, supervisor:'noop' } | { ok:false, code, error }
   *
   * @param {object} req
   * @returns {Promise<object>}
   */
  async _opHeartbeatEmit(req) {
    const { component, id, healthy = true, details = {}, synaps_user_id } = req;

    // Validate component
    const validComponents = new Set(['workspace', 'rpc', 'agent']);
    if (!component || typeof component !== 'string' || !validComponents.has(component)) {
      return {
        ok: false,
        code: 'invalid_request',
        error: `component must be one of: ${[...validComponents].join(', ')}`,
      };
    }

    if (!id || typeof id !== 'string') {
      return { ok: false, code: 'invalid_request', error: 'id must be a non-empty string' };
    }

    if (!synaps_user_id || typeof synaps_user_id !== 'string') {
      return { ok: false, code: 'invalid_request', error: 'synaps_user_id must be a non-empty string' };
    }

    // When heartbeatRepo is null/absent: respond with silent noop (watcher in mixed deployments).
    if (!this._heartbeatRepo) {
      return { ok: true, supervisor: 'noop' };
    }

    // Ownership check for workspace component.
    if (component === 'workspace' && this._workspaceRepo) {
      let workspace;
      try {
        // WorkspaceRepo uses byId() method name.
        const findMethod = this._workspaceRepo.byId?.bind(this._workspaceRepo)
          ?? this._workspaceRepo.findById?.bind(this._workspaceRepo);
        workspace = findMethod ? await findMethod(id) : null;
      } catch (err) {
        this.logger.warn?.('ControlSocket: heartbeat_emit workspace lookup failed', {
          id,
          err: err.message,
        });
        return { ok: false, code: 'internal_error', error: err.message };
      }

      if (workspace) {
        const ownerId = String(workspace.synaps_user_id ?? '');
        if (ownerId !== synaps_user_id) {
          return {
            ok: false,
            code: 'unauthorized',
            error: 'workspace owner mismatch',
          };
        }
      }
      // If workspace not found, we proceed (trust the UDS caller).
    }

    // Record the heartbeat.
    try {
      await this._heartbeatRepo.record({
        component,
        id,
        healthy: typeof healthy === 'boolean' ? healthy : true,
        details: details && typeof details === 'object' ? details : {},
      });
    } catch (err) {
      this.logger.warn?.('ControlSocket: heartbeat_emit record failed', { err: err.message });
      return { ok: false, code: 'internal_error', error: err.message };
    }

    return { ok: true, ts: new Date().toISOString() };
  }

  /**
   * scheduled_task_create — Create a new scheduled task via the Scheduler.
   *
   * Request:  { op:'scheduled_task_create', synaps_user_id, institution_id, name, cron, channel, prompt }
   * Response: { ok:true, id, agenda_job_id, next_run } | { ok:false, code, error }
   *
   * @param {object} req
   * @returns {Promise<object>}
   */
  async _opScheduledTaskCreate(req) {
    const { synaps_user_id, institution_id, name, cron, channel, prompt } = req;

    // Validate required fields.
    if (!synaps_user_id || typeof synaps_user_id !== 'string') {
      return { ok: false, code: 'invalid_request', error: 'synaps_user_id is required' };
    }
    if (!institution_id || typeof institution_id !== 'string') {
      return { ok: false, code: 'invalid_request', error: 'institution_id is required' };
    }
    if (!name || typeof name !== 'string') {
      return { ok: false, code: 'invalid_request', error: 'name is required' };
    }
    if (!cron || typeof cron !== 'string') {
      return { ok: false, code: 'invalid_request', error: 'cron is required' };
    }
    if (!channel || typeof channel !== 'string') {
      return { ok: false, code: 'invalid_request', error: 'channel is required' };
    }
    if (!prompt || typeof prompt !== 'string') {
      return { ok: false, code: 'invalid_request', error: 'prompt is required' };
    }

    // Check if scheduler is disabled (null or NoopScheduler).
    if (!this._scheduler || this._scheduler.constructor?.name === 'NoopScheduler') {
      return { ok: false, code: 'scheduler_disabled', error: 'scheduler is not enabled' };
    }

    try {
      const result = await this._scheduler.create({
        synapsUserId: synaps_user_id,
        institutionId: institution_id,
        name,
        cron,
        channel,
        prompt,
      });
      return { ok: true, id: result.id, agenda_job_id: result.agenda_job_id, next_run: result.next_run };
    } catch (err) {
      if (err instanceof SchedulerDisabledError || err.name === 'SchedulerDisabledError') {
        return { ok: false, code: 'scheduler_disabled', error: err.message };
      }
      if (err.name === 'SchedulerValidationError') {
        return { ok: false, code: 'invalid_request', error: err.message };
      }
      this.logger.warn?.('ControlSocket: scheduled_task_create error', { err: err.message });
      return { ok: false, code: 'internal_error', error: err.message };
    }
  }

  /**
   * scheduled_task_list — List scheduled tasks for a user.
   *
   * Request:  { op:'scheduled_task_list', synaps_user_id }
   * Response: { ok:true, tasks: [...] } | { ok:false, code, error }
   *
   * @param {object} req
   * @returns {Promise<object>}
   */
  async _opScheduledTaskList(req) {
    const { synaps_user_id } = req;

    if (!synaps_user_id || typeof synaps_user_id !== 'string') {
      return { ok: false, code: 'invalid_request', error: 'synaps_user_id is required' };
    }

    // Check if scheduler is disabled.
    if (!this._scheduler || this._scheduler.constructor?.name === 'NoopScheduler') {
      return { ok: false, code: 'scheduler_disabled', error: 'scheduler is not enabled' };
    }

    try {
      const tasks = await this._scheduler.list({ synapsUserId: synaps_user_id });
      return { ok: true, tasks };
    } catch (err) {
      if (err instanceof SchedulerDisabledError || err.name === 'SchedulerDisabledError') {
        return { ok: false, code: 'scheduler_disabled', error: err.message };
      }
      this.logger.warn?.('ControlSocket: scheduled_task_list error', { err: err.message });
      return { ok: false, code: 'internal_error', error: err.message };
    }
  }

  /**
   * scheduled_task_remove — Remove a scheduled task (with ownership check).
   *
   * Request:  { op:'scheduled_task_remove', id, synaps_user_id }
   * Response: { ok:true } | { ok:false, code, error }
   *
   * @param {object} req
   * @returns {Promise<object>}
   */
  async _opScheduledTaskRemove(req) {
    const { id, synaps_user_id } = req;

    if (!id || typeof id !== 'string') {
      return { ok: false, code: 'invalid_request', error: 'id is required' };
    }
    if (!synaps_user_id || typeof synaps_user_id !== 'string') {
      return { ok: false, code: 'invalid_request', error: 'synaps_user_id is required' };
    }

    // Check if scheduler is disabled.
    if (!this._scheduler || this._scheduler.constructor?.name === 'NoopScheduler') {
      return { ok: false, code: 'scheduler_disabled', error: 'scheduler is not enabled' };
    }

    // Look up task to check ownership.
    const repo = this._scheduledTaskRepo;
    if (repo) {
      let task;
      try {
        task = await repo.findById(id);
      } catch (err) {
        this.logger.warn?.('ControlSocket: scheduled_task_remove findById error', { err: err.message });
        return { ok: false, code: 'internal_error', error: err.message };
      }

      if (!task) {
        return { ok: false, code: 'not_found', error: `scheduled task not found: ${id}` };
      }

      // Ownership check.
      const ownerId = String(task.synaps_user_id ?? '');
      if (ownerId !== synaps_user_id) {
        return { ok: false, code: 'unauthorized', error: 'you do not own this scheduled task' };
      }
    }

    try {
      await this._scheduler.remove(id);
      return { ok: true };
    } catch (err) {
      if (err instanceof SchedulerDisabledError || err.name === 'SchedulerDisabledError') {
        return { ok: false, code: 'scheduler_disabled', error: err.message };
      }
      this.logger.warn?.('ControlSocket: scheduled_task_remove error', { err: err.message });
      return { ok: false, code: 'internal_error', error: err.message };
    }
  }

  /**
   * hook_create — Create a new hook in the repo.
   *
   * Request:  { op:'hook_create', scope, event, matcher, action, enabled? }
   * Response: { ok:true, id } | { ok:false, code, error }
   *
   * @param {object} req
   * @returns {Promise<object>}
   */
  async _opHookCreate(req) {
    const { scope, event, matcher = {}, action, enabled = true } = req;

    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
      return { ok: false, code: 'invalid_request', error: 'scope must be an object' };
    }
    if (!event || typeof event !== 'string') {
      return { ok: false, code: 'invalid_request', error: 'event is required' };
    }
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      return { ok: false, code: 'invalid_request', error: 'action must be an object' };
    }

    // Check if hookBus is disabled (null or NoopHookBus).
    if (!this._hookBus || this._hookBus.constructor?.name === 'NoopHookBus') {
      return { ok: false, code: 'hooks_disabled', error: 'hooks feature is not enabled' };
    }

    // hookRepo is required for this op.
    if (!this._hookRepo) {
      return { ok: false, code: 'hooks_disabled', error: 'hook repository is not available' };
    }

    try {
      const doc = await this._hookRepo.create({ scope, event, matcher, action, enabled });
      return { ok: true, id: String(doc._id) };
    } catch (err) {
      this.logger.warn?.('ControlSocket: hook_create error', { err: err.message });
      return { ok: false, code: 'internal_error', error: err.message };
    }
  }

  /**
   * hook_list — List hooks for a scope.
   *
   * SECURITY: action.config.secret is ALWAYS redacted in the response.
   *
   * Request:  { op:'hook_list', scope }
   * Response: { ok:true, hooks: [...] } | { ok:false, code, error }
   *
   * @param {object} req
   * @returns {Promise<object>}
   */
  async _opHookList(req) {
    // Check if hookBus is disabled.
    if (!this._hookBus || this._hookBus.constructor?.name === 'NoopHookBus') {
      return { ok: false, code: 'hooks_disabled', error: 'hooks feature is not enabled' };
    }

    if (!this._hookRepo) {
      return { ok: false, code: 'hooks_disabled', error: 'hook repository is not available' };
    }

    try {
      const hooks = await this._hookRepo.listAll({});

      // Sanitize: redact action.config.secret in every hook.
      const sanitized = hooks.map((hook) => this._sanitizeHook(hook));

      return { ok: true, hooks: sanitized };
    } catch (err) {
      this.logger.warn?.('ControlSocket: hook_list error', { err: err.message });
      return { ok: false, code: 'internal_error', error: err.message };
    }
  }

  /**
   * hook_remove — Remove a hook by its ID.
   *
   * Request:  { op:'hook_remove', id }
   * Response: { ok:true } | { ok:false, code, error }
   *
   * @param {object} req
   * @returns {Promise<object>}
   */
  async _opHookRemove(req) {
    const { id } = req;

    if (!id || typeof id !== 'string') {
      return { ok: false, code: 'invalid_request', error: 'id is required' };
    }

    // Check if hookBus is disabled.
    if (!this._hookBus || this._hookBus.constructor?.name === 'NoopHookBus') {
      return { ok: false, code: 'hooks_disabled', error: 'hooks feature is not enabled' };
    }

    if (!this._hookRepo) {
      return { ok: false, code: 'hooks_disabled', error: 'hook repository is not available' };
    }

    try {
      // Check if hook exists first.
      const existing = await this._hookRepo.findById(id);
      if (!existing) {
        return { ok: false, code: 'not_found', error: `hook not found: ${id}` };
      }

      await this._hookRepo.remove(id);
      return { ok: true };
    } catch (err) {
      this.logger.warn?.('ControlSocket: hook_remove error', { err: err.message });
      return { ok: false, code: 'internal_error', error: err.message };
    }
  }

  /**
   * Sanitize a hook document for wire response: redact action.config.secret.
   *
   * @private
   * @param {object} hook
   * @returns {object}
   */
  _sanitizeHook(hook) {
    if (!hook) return hook;
    const out = { ...hook };
    if (out.action && out.action.config && out.action.config.secret !== undefined) {
      out.action = {
        ...out.action,
        config: {
          ...out.action.config,
          secret: '<redacted>',
        },
      };
    }
    return out;
  }

  // ── cred broker op ────────────────────────────────────────────────────────

  /**
   * Result-proxy credential broker op.
   *
   * The agent supplies a request shape; the broker fetches the token, signs
   * the request server-side, and returns only the HTTP response.  The token
   * never crosses the wire boundary.
   *
   * Request:
   *   {
   *     op:             'cred_broker_use',
   *     synaps_user_id: string,
   *     institution_id: string,
   *     key:            string,
   *     request: {
   *       method:   string,
   *       url:      string,
   *       headers?: object,
   *       body?:    string | null,
   *     }
   *   }
   *
   * Response (success):
   *   { ok:true, status, headers, body, cached, fetched_at }
   *
   * Response (error):
   *   { ok:false, code, error }
   *
   * @param {object} req
   * @returns {Promise<object>}
   */
  async _opCredBrokerUse(req) {
    // ── Defensive: no broker injected ──────────────────────────────────────
    if (!this._credBroker) {
      this.logger.warn('ControlSocket: cred_broker_use called but credBroker is not configured');
      return { ok: false, code: 'creds_disabled', error: 'cred broker not configured' };
    }

    // ── Input validation (wire-level, before calling broker) ───────────────
    const { synaps_user_id, institution_id, key, request } = req;

    if (typeof synaps_user_id !== 'string' || synaps_user_id.length === 0) {
      return { ok: false, code: 'invalid_request', error: 'synaps_user_id must be a non-empty string' };
    }
    if (typeof institution_id !== 'string' || institution_id.length === 0) {
      return { ok: false, code: 'invalid_request', error: 'institution_id must be a non-empty string' };
    }
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, code: 'invalid_request', error: 'key must be a non-empty string' };
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return { ok: false, code: 'invalid_request', error: 'request must be an object' };
    }

    // ── Translate snake_case → camelCase for broker call ───────────────────
    const synapsUserId  = synaps_user_id;
    const institutionId = institution_id;

    // ── Sanitise headers for logging (strip Authorization case-insensitively) ─
    const logHeaders = {};
    for (const [hk, hv] of Object.entries(request.headers ?? {})) {
      if (hk.toLowerCase() !== 'authorization') {
        logHeaders[hk] = hv;
      }
    }

    this.logger.info?.('ControlSocket: cred_broker_use', {
      synapsUserId,
      institutionId,
      key,
      method: request.method,
      url:    request.url,
      // headers: logHeaders is intentionally omitted to keep logs minimal;
      // authorization is already stripped if present.
    });

    // ── Translate body: null → undefined (broker expects optional body) ─────
    const brokerRequest = {
      method:  request.method,
      url:     request.url,
      headers: request.headers,
      body:    request.body === null ? undefined : request.body,
    };

    // ── Delegate to broker ──────────────────────────────────────────────────
    try {
      const result = await this._credBroker.use({
        synapsUserId,
        institutionId,
        key,
        request: brokerRequest,
      });

      this.logger.info?.('ControlSocket: cred_broker_use success', {
        synapsUserId,
        key,
        status:  result.status,
        cached:  result.cached,
      });

      return {
        ok:         true,
        status:     result.status,
        headers:    result.headers,
        body:       result.body,
        cached:     result.cached,
        fetched_at: result.fetchedAt,
      };
    } catch (err) {
      // Error code mapping — token NEVER appears in logs or response.
      let code;
      if (err instanceof CredsValidationError)    code = 'invalid_request';
      else if (err instanceof CredBrokerDisabledError) code = 'creds_disabled';
      else if (err instanceof CredsUnavailableError)   code = 'creds_unavailable';
      else if (err instanceof InfisicalNotFoundError)  code = 'secret_not_found';
      else if (err instanceof InfisicalAuthError)      code = 'broker_auth_failed';
      else if (err instanceof InfisicalUpstreamError)  code = 'broker_upstream';
      else                                             code = 'internal_error';

      this.logger.warn?.('ControlSocket: cred_broker_use error', {
        code,
        errorClass: err.constructor.name,
        synapsUserId,
        key,
        // message is safe — Wave A audited it contains no token
        message: err.message,
      });

      return { ok: false, code, error: err.message };
    }
  }

  // ── streaming op ──────────────────────────────────────────────────────────

  /**
   * Long-lived chat streaming op.
   *
   * Protocol:
   *   Client sends:  { op:'chat_stream_start', synaps_user_id, channel, thread_key, text, model? }
   *   Server emits:  { kind:'chunk', chunk:{...} }\n   (one per RPC chunk)
   *   Server emits:  { kind:'done' }\n                 (on agent_end)
   *   Server emits:  { kind:'error', message }\n       (on error)
   *
   * Order matters: subscribe to rpc events BEFORE sending the user prompt,
   * so we never miss early chunks emitted synchronously or near-synchronously.
   *
   * @param {object}     req
   * @param {net.Socket} socket
   */
  async _opChatStreamStart(req, socket) {
    const { synaps_user_id, channel = 'web', thread_key, text, model = null } = req;

    // ── validation ────────────────────────────────────────────────────────
    if (!synaps_user_id) {
      this._writeStreamLine(socket, { kind: 'error', message: 'missing synaps_user_id' });
      socket.end();
      return;
    }

    if (!text) {
      this._writeStreamLine(socket, { kind: 'error', message: 'missing text' });
      socket.end();
      return;
    }

    // thread_key defaults to web:<synaps_user_id> if not provided.
    const thread = thread_key ?? `web:${synaps_user_id}`;

    // ── get or create session ─────────────────────────────────────────────
    let rpc;
    try {
      rpc = await this._router.getOrCreateSession({
        source:       channel,
        conversation: synaps_user_id,
        thread,
        model,
      });
    } catch (err) {
      this.logger.warn(`ControlSocket: chat_stream_start getOrCreateSession failed: ${err.message}`);
      this._writeStreamLine(socket, { kind: 'error', message: err.message });
      socket.end();
      return;
    }

    // ── subscribe to rpc events BEFORE sending the prompt ────────────────
    let finished = false;

    const onChunk = (chunk) => {
      if (finished || socket.destroyed) return;
      this._writeStreamLine(socket, { kind: 'chunk', chunk });
    };

    const onAgentEnd = () => {
      if (finished) return;
      finished = true;
      cleanup();
      this._writeStreamLine(socket, { kind: 'done' });
      socket.end();
    };

    const onError = (err) => {
      if (finished) return;
      finished = true;
      cleanup();
      const message = (err && err.message) ? err.message : String(err);
      this._writeStreamLine(socket, { kind: 'error', message });
      socket.end();
    };

    // RPC emits `agent_end` when the turn finishes.
    rpc.on('agent_end', onAgentEnd);
    // RPC may emit `error` for unrecoverable failures.
    rpc.on('error', onError);

    // Also subscribe to chunk events — the RPC / StreamingProxy layer emits
    // `chunk` events that carry the individual payload objects.  Adapters that
    // use StreamingProxy don't use this path (they use the streamHandle
    // abstraction), but direct rpc-based web sessions may emit `chunk`.
    rpc.on('chunk', onChunk);

    // Clean up listeners to avoid leaks, especially if client disconnects.
    const cleanup = () => {
      rpc.off('agent_end', onAgentEnd);
      rpc.off('error',     onError);
      rpc.off('chunk',     onChunk);
    };

    // Tolerate client closing the socket mid-stream.
    socket.once('close', () => {
      if (!finished) {
        finished = true;
        cleanup();
      }
    });

    // ── send the user prompt ──────────────────────────────────────────────
    try {
      await rpc.sendUserPrompt(text);
    } catch (err) {
      if (!finished) {
        finished = true;
        cleanup();
        this.logger.warn(`ControlSocket: chat_stream_start sendUserPrompt failed: ${err.message}`);
        this._writeStreamLine(socket, { kind: 'error', message: err.message });
        socket.end();
      }
    }
  }

  /**
   * Write a single JSON-line to the socket without ending it.
   *
   * @param {net.Socket} socket
   * @param {object}     payload
   */
  _writeStreamLine(socket, payload) {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(payload) + '\n');
    }
  }
}
