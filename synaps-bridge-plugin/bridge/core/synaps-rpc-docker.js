/**
 * @file bridge/core/synaps-rpc-docker.js
 *
 * SynapsRpc adapter that runs `synaps rpc` inside a workspace container
 * via `docker exec`, instead of on the host. Public API mirrors SynapsRpc
 * (start, request, shutdown, EventEmitter for stream events) so the
 * SessionRouter doesn't need to know which transport is in play.
 *
 * Lifecycle:
 *   start() → workspaceManager.ensure(synapsUserId) → docker.getContainer(id).exec({...})
 *           → attach stdin/stdout/stderr → parse line-JSON like SynapsRpc
 *   request(method, params) → write line-JSON to exec stdin
 *   shutdown() → write {"method":"shutdown"} → close stdin → wait exit
 *
 * Spec reference: PLATFORM.SPEC.md §3.1, §5, §12.5
 */

import { EventEmitter } from 'node:events';
import { PassThrough }  from 'node:stream';
import { randomUUID }   from 'node:crypto';

// ─── internal helpers ─────────────────────────────────────────────────────────

/**
 * Build the argv for `synaps rpc` inside the container.
 *
 * @param {object} opts
 * @param {string}      opts.binPath
 * @param {string|null} opts.sessionId
 * @param {string|null} opts.systemPrompt
 * @param {string|null} opts.model
 * @param {string|null} opts.profile
 * @param {string[]}    opts.args
 * @returns {string[]}
 */
function buildArgv({ binPath, sessionId, systemPrompt, model, profile, args }) {
  const argv = [binPath, 'rpc'];
  if (sessionId)    argv.push('--continue', sessionId);
  if (systemPrompt) argv.push('--system', systemPrompt);
  if (model)        argv.push('--model', model);
  if (profile)      argv.push('--profile', profile);
  argv.push(...args);
  return argv;
}

/**
 * Line-JSON parser helper.
 * Accepts a mutable state object `{ buf: '' }` and a new chunk,
 * calls `onLine(line)` for each complete newline-delimited line found.
 *
 * @param {{ buf: string }} state  - Mutable line buffer state.
 * @param {Buffer|string}  chunk  - New data from the stream.
 * @param {Function}       onLine - Called with each complete line (sans '\n').
 */
function feedLines(state, chunk, onLine) {
  state.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  let nl;
  while ((nl = state.buf.indexOf('\n')) !== -1) {
    const line = state.buf.slice(0, nl);
    state.buf  = state.buf.slice(nl + 1);
    if (line.length > 0) onLine(line);
  }
}

/**
 * Parse a single JSON line, returning the parsed object or null on error.
 * Calls `onError(err)` if parsing fails.
 *
 * @param {string}   line
 * @param {Function} onError
 * @returns {object|null}
 */
function parseLine(line, onError) {
  try {
    return JSON.parse(line);
  } catch (err) {
    onError(err, line);
    return null;
  }
}

// ─── DockerExecSynapsRpc ──────────────────────────────────────────────────────

/**
 * SynapsRpc-compatible adapter that launches `synaps rpc` via `docker exec`
 * inside the workspace container owned by `synapsUserId`.
 *
 * Emitted events (same as SynapsRpc):
 *   ready            { sessionId, model, protocolVersion }
 *   event            { …frame fields }          (generic stream event)
 *   message_update   { …event fields }
 *   subagent_start   { subagent_id, agent_name, task_preview }
 *   subagent_update  { subagent_id, agent_name, status }
 *   subagent_done    { subagent_id, agent_name, result_preview, duration_secs }
 *   agent_end        { usage }
 *   error            Error
 *   exit             { code: number|null, signal: string|null }
 */
export class DockerExecSynapsRpc extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {object}   opts.workspaceManager  - WorkspaceManager instance (required).
   * @param {string}   opts.synapsUserId      - Mongo _id of the SynapsUser (required).
   * @param {string}   [opts.binPath='synaps'] - Path to the synaps binary inside the container.
   * @param {string|null} [opts.sessionId=null]
   * @param {string|null} [opts.systemPrompt=null]
   * @param {string|null} [opts.model=null]
   * @param {string|null} [opts.profile=null]
   * @param {string[]} [opts.args=[]]
   * @param {object}   [opts.logger=console]
   */
  constructor({
    workspaceManager,
    synapsUserId,
    binPath       = 'synaps',
    sessionId     = null,
    systemPrompt  = null,
    model         = null,
    profile       = null,
    args          = [],
    logger        = console,
  } = {}) {
    super();

    if (!workspaceManager) {
      throw new Error('DockerExecSynapsRpc: opts.workspaceManager is required');
    }
    if (!synapsUserId) {
      throw new Error('DockerExecSynapsRpc: opts.synapsUserId is required');
    }

    this._workspaceManager = workspaceManager;
    this._synapsUserId     = synapsUserId;
    this._binPath          = binPath;
    this._sessionId        = sessionId;
    this._systemPrompt     = systemPrompt;
    this._model            = model;
    this._profile          = profile;
    this._args             = args;
    this.logger            = logger;

    /** @type {object|null} dockerode exec instance */
    this._exec = null;

    /** @type {import('stream').Duplex|null} hijacked docker stream */
    this._stream = null;

    /** @type {import('stream').PassThrough} stdout demux target */
    this._stdoutPT = null;

    /** @type {import('stream').PassThrough} stderr demux target */
    this._stderrPT = null;

    /** Line buffer state for stdout */
    this._lineState = { buf: '' };

    /**
     * Pending RPC correlation map.
     * @type {Map<string, { command: string, resolve: Function, reject: Function, timer: NodeJS.Timeout }>}
     */
    this._pending = new Map();

    /** Whether we've sent the shutdown command */
    this._shuttingDown = false;

    /** Whether start() has been called */
    this._started = false;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Ensure the workspace container is running, create a docker exec, attach
   * the streams, and wait for the `ready` event from the child process.
   *
   * @returns {Promise<{ sessionId: string, model: string, protocolVersion: number }>}
   */
  async start() {
    if (this._started) throw new Error('DockerExecSynapsRpc: already started');
    this._started = true;

    // 1. Ensure workspace is running → get doc with container_id.
    let workspace;
    try {
      workspace = await this._workspaceManager.ensure(this._synapsUserId);
    } catch (err) {
      this.emit('error', err);
      throw err;
    }

    const docker = this._workspaceManager.docker ?? this._workspaceManager._docker;

    // 2. Build argv and create exec instance.
    const argv = buildArgv({
      binPath:      this._binPath,
      sessionId:    this._sessionId,
      systemPrompt: this._systemPrompt,
      model:        this._model,
      profile:      this._profile,
      args:         this._args,
    });

    let execInstance;
    try {
      const container = docker.getContainer(workspace.container_id);
      execInstance = await container.exec({
        Cmd:          argv,
        AttachStdin:  true,
        AttachStdout: true,
        AttachStderr: true,
        Tty:          false,
      });
      this._exec = execInstance;
    } catch (err) {
      this.emit('error', err);
      throw err;
    }

    // 3. Start exec (hijack mode → duplex stream).
    let stream;
    try {
      stream = await execInstance.start({ Detach: false, hijack: true, stdin: true });
      this._stream = stream;
    } catch (err) {
      this.emit('error', err);
      throw err;
    }

    // 4. Demux the docker multiplexed stream into stdout / stderr PassThrough streams.
    const stdoutPT = new PassThrough();
    const stderrPT = new PassThrough();
    this._stdoutPT = stdoutPT;
    this._stderrPT = stderrPT;

    docker.modem.demuxStream(stream, stdoutPT, stderrPT);

    // 5. Wire stderr → logger.warn (line-buffered).
    const stderrState = { buf: '' };
    stderrPT.on('data', (chunk) => {
      feedLines(stderrState, chunk, (line) => {
        this.logger.warn?.(`[synaps-rpc-docker stderr] ${line}`);
      });
    });
    stderrPT.on('end', () => {
      if (stderrState.buf.length > 0) {
        this.logger.warn?.(`[synaps-rpc-docker stderr] ${stderrState.buf}`);
        stderrState.buf = '';
      }
    });

    // 6. Wire stdout → line-JSON parser.
    stdoutPT.on('data', (chunk) => {
      feedLines(this._lineState, chunk, (line) => this._processLine(line));
    });
    stdoutPT.on('end', () => {
      // Flush any partial line on EOF.
      if (this._lineState.buf.trim().length > 0) {
        this._processLine(this._lineState.buf);
        this._lineState.buf = '';
      }
    });

    // 7. Stream end → emit exit (exec inspector not available without polling,
    //    so we emit exit when the stream ends / closes).
    stream.on('end',   () => this._onStreamEnd());
    stream.on('close', () => this._onStreamEnd());
    stream.on('error', (err) => this.emit('error', err));

    // 8. Wait for ready.
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.removeListener('ready', onReady);
        this.removeListener('exit', onExit);
        this.removeListener('error', onError);
      };

      const onReady = (payload) => { cleanup(); resolve(payload); };
      const onExit  = ({ code, signal }) => {
        cleanup();
        reject(new Error(`DockerExecSynapsRpc: exec exited before ready (code=${code} signal=${signal})`));
      };
      const onError = (err) => { cleanup(); reject(err); };

      this.once('ready', onReady);
      this.once('exit',  onExit);
      this.once('error', onError);
    });
  }

  /**
   * Send a shutdown frame, close stdin, and wait for the exec stream to end.
   *
   * @returns {Promise<{ code: number|null, signal: string|null }>}
   */
  async shutdown() {
    if (this._shuttingDown) {
      return new Promise((resolve) => this.once('exit', resolve));
    }
    this._shuttingDown = true;

    // Write shutdown frame.
    if (this._stream && !this._stream.destroyed) {
      try {
        this._stream.write(JSON.stringify({ type: 'shutdown' }) + '\n');
      } catch (_) { /* stream may already be closing */ }

      // End (close stdin end of the hijacked stream).
      try {
        this._stream.end();
      } catch (_) { /* best-effort */ }
    }

    // Reject pending commands.
    const reason = new Error('DockerExecSynapsRpc: shutdown initiated');
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      this._pending.delete(id);
    }

    return new Promise((resolve) => {
      // If we're already dead, resolve immediately.
      if (!this._stream || this._stream.destroyed) {
        return resolve({ code: null, signal: null });
      }
      this.once('exit', resolve);
    });
  }

  // ── commands (mirror SynapsRpc public surface) ────────────────────────────

  /**
   * Send a user prompt.
   * @param {string} message
   * @param {Array<{path:string, name?:string, mime?:string}>} attachments
   */
  async prompt(message, attachments = []) {
    const frame = { type: 'prompt', message };
    if (attachments.length > 0) frame.attachments = attachments;
    const response = await this._send(frame);
    if (response.ok === false) {
      throw new Error(response.error ?? 'prompt failed');
    }
    return response;
  }

  /** @param {string} message */
  async followUp(message) {
    return this._send({ type: 'follow_up', message });
  }

  async compact() { return this._send({ type: 'compact' }); }
  async newSession() { return this._send({ type: 'new_session' }); }
  async getMessages() { return this._send({ type: 'get_messages' }); }
  async setModel(model) { return this._send({ type: 'set_model', model }); }
  async getAvailableModels() { return this._send({ type: 'get_available_models' }); }
  async abort() { return this._send({ type: 'abort' }); }
  async getSessionStats() { return this._send({ type: 'get_session_stats' }); }
  async getState() { return this._send({ type: 'get_state' }); }

  // ── internal: send with correlation ──────────────────────────────────────

  /**
   * Write a command frame with a generated id, return a Promise that resolves
   * when the matching `response` arrives or rejects on timeout.
   *
   * @param {object} frame
   * @returns {Promise<object>}
   */
  _send(frame) {
    return new Promise((resolve, reject) => {
      const id      = randomUUID();
      const command = frame.type;
      const timer   = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`docker-rpc timeout: command=${command} id=${id}`));
        }
      }, 60_000);

      this._pending.set(id, { command, resolve, reject, timer });
      this._writeFrame(JSON.stringify({ ...frame, id }) + '\n');
    });
  }

  /**
   * Write a serialised frame to the exec stream's stdin.
   * @param {string} wire
   */
  _writeFrame(wire) {
    if (!this._stream || this._stream.destroyed) return;
    try {
      this._stream.write(wire);
    } catch (err) {
      this.logger.warn?.(`DockerExecSynapsRpc: write failed: ${err.message}`);
    }
  }

  // ── internal: stdout parsing ──────────────────────────────────────────────

  /**
   * Parse and dispatch a single complete line from exec stdout.
   * @param {string} line
   */
  _processLine(line) {
    const frame = parseLine(line, (_err, raw) => {
      this.logger.warn?.(`DockerExecSynapsRpc: dropped malformed JSON line (${raw.length} chars)`);
      this.emit('error', new Error(`Malformed JSON from exec stdout: ${raw.slice(0, 80)}`));
    });
    if (!frame) return;
    this._dispatchFrame(frame);
  }

  /**
   * Route a parsed frame to the appropriate handler.
   * Mirrors SynapsRpc._dispatchFrame exactly.
   *
   * @param {object} frame
   */
  _dispatchFrame(frame) {
    switch (frame.type) {
      case 'ready':
        this._handleReady(frame);
        break;

      case 'response':
        this._handleResponse(frame);
        break;

      case 'error':
        this._handleError(frame);
        break;

      case 'message_update':
        this.emit('message_update', frame.event);
        break;

      case 'subagent_start': {
        const { subagent_id, agent_name, task_preview } = frame;
        this.emit('subagent_start', { subagent_id, agent_name, task_preview });
        break;
      }

      case 'subagent_update': {
        const { subagent_id, agent_name, status } = frame;
        this.emit('subagent_update', { subagent_id, agent_name, status });
        break;
      }

      case 'subagent_done': {
        const { subagent_id, agent_name, result_preview, duration_secs } = frame;
        this.emit('subagent_done', { subagent_id, agent_name, result_preview, duration_secs });
        break;
      }

      case 'agent_end':
        this.emit('agent_end', { usage: frame.usage });
        break;

      default:
        this.logger.warn?.(`DockerExecSynapsRpc: unknown frame type '${frame.type}'`);
    }
  }

  /** @param {object} frame */
  _handleReady(frame) {
    if (frame.protocol_version !== 1) {
      const err = new Error(
        `DockerExecSynapsRpc: unsupported protocol_version ${frame.protocol_version} (expected 1)`
      );
      this.emit('error', err);
      if (this._stream && !this._stream.destroyed) this._stream.destroy();
      return;
    }
    this.emit('ready', {
      sessionId:       frame.session_id,
      model:           frame.model,
      protocolVersion: frame.protocol_version,
    });
  }

  /** @param {object} frame */
  _handleResponse(frame) {
    const entry = this._pending.get(frame.id);
    if (!entry) return; // spurious response
    clearTimeout(entry.timer);
    this._pending.delete(frame.id);
    const { type: _t, id: _id, command: _cmd, ...body } = frame;
    entry.resolve({ command: frame.command, ...body });
  }

  /** @param {object} frame */
  _handleError(frame) {
    const id = frame.id ?? null;
    if (id && this._pending.has(id)) {
      const entry = this._pending.get(id);
      clearTimeout(entry.timer);
      this._pending.delete(id);
      const err = new Error(frame.message);
      err.id = id;
      entry.reject(err);
    } else {
      const err = new Error(frame.message);
      if (id) err.id = id;
      this.emit('error', err);
    }
  }

  // ── internal: stream end ──────────────────────────────────────────────────

  /** Called when the docker exec stream ends or closes. */
  _onStreamEnd() {
    if (this._exitEmitted) return;
    this._exitEmitted = true;

    // Reject remaining pending commands.
    const reason = new Error('DockerExecSynapsRpc: exec stream ended');
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      this._pending.delete(id);
    }

    this.emit('exit', { code: null, signal: null });
  }
}
