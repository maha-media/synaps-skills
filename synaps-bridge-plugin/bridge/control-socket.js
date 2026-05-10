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
 * No I/O in constructor.  All side effects are in start() / stop().
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
   * @param {string}   [opts.socketPath]      - UDS path (default: DEFAULT_SOCKET_PATH).
   * @param {import('./core/session-router.js').SessionRouter} opts.sessionRouter
   * @param {object}   [opts.logger]          - Logger (default: console).
   * @param {string}   [opts.version]         - Daemon version string (default: "0.1.0").
   * @param {Function} [opts.nowMs]           - Returns current epoch ms (injectable for tests).
   * @param {object}   [opts._net]            - node:net override (injectable for tests).
   * @param {object}   [opts._fs]             - fs override (injectable for tests).
   */
  constructor({
    socketPath = DEFAULT_SOCKET_PATH,
    sessionRouter,
    logger = console,
    version = '0.1.0',
    nowMs = () => Date.now(),
    _net = net,
    _fs = fs,
  } = {}) {
    super();

    this._socketPath = socketPath;
    this._router = sessionRouter;
    this.logger = logger;
    this._version = version;
    this._nowMs = nowMs;
    this._net = _net;
    this._fs = _fs;

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
   * Parse and dispatch a request line; write the response, then destroy.
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
      case 'threads':  return this._opThreads();
      case 'model':    return this._opModel(req);
      case 'reap':     return this._opReap(req);
      case 'status':   return this._opStatus();
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
}
