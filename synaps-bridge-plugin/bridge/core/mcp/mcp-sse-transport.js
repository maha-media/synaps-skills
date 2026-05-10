/**
 * @file bridge/core/mcp/mcp-sse-transport.js
 *
 * McpSseTransport — pure SSE framing helper for MCP-over-SSE streaming.
 *
 * Handles:
 *   - Writing SSE headers and the initial `retry:` hint
 *   - Sending JSON-RPC notification frames
 *   - Sending a final result or error frame and closing the stream
 *   - Heartbeat keepalive comments (`: keepalive\n\n`) on a timer
 *   - Peer-disconnect detection via `res.on('close', …)`
 *
 * This module is a pure framing helper: NO HTTP server creation, NO Mongo.
 * Wiring into McpServer / scp-http-server is handled by Wave B.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const SSE_HEADERS = Object.freeze({
  'Content-Type':      'text/event-stream',
  'Cache-Control':     'no-cache, no-transform',
  'Connection':        'keep-alive',
  'X-Accel-Buffering': 'no',
});

const RETRY_HINT       = 'retry: 1500\n\n';
const KEEPALIVE_CHUNK  = ': keepalive\n\n';
const DEFAULT_HEARTBEAT_MS = 15_000;

// ─── McpSseTransport ──────────────────────────────────────────────────────────

export class McpSseTransport {
  /**
   * @param {object}         opts
   * @param {object}         opts.res           — Node http.ServerResponse-shaped
   *                                              (writeHead, write, end, on)
   * @param {object}         [opts.logger]      — { debug, info, warn, error }
   * @param {() => number}   [opts.now]         — injectable clock (for testing)
   * @param {number}         [opts.heartbeatMs] — keepalive interval, default 15 000 ms
   */
  constructor({ res, logger, now, heartbeatMs } = {}) {
    if (!res) throw new TypeError('McpSseTransport: opts.res is required');

    this._res          = res;
    this._logger       = logger ?? console;
    this._now          = now ?? (() => Date.now());
    this._heartbeatMs  = heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

    this._started      = false;   // headers sent
    this._closed       = false;   // stream ended / peer gone
    this._heartbeat    = null;    // setInterval handle

    // Hook peer-disconnect so we release the timer even if the caller never
    // calls close() explicitly.
    res.on('close', () => this._teardown());
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Send SSE headers + initial `retry:` hint.  Idempotent.
   */
  start() {
    if (this._started || this._closed) return;
    this._started = true;

    this._res.writeHead(200, SSE_HEADERS);
    this._res.write(RETRY_HINT);

    // Begin heartbeat timer
    this._heartbeat = setInterval(() => {
      if (this._closed) return;
      this._res.write(KEEPALIVE_CHUNK);
    }, this._heartbeatMs);

    // Ensure Node.js doesn't keep the process alive just for the timer.
    if (typeof this._heartbeat.unref === 'function') {
      this._heartbeat.unref();
    }
  }

  /**
   * Send a JSON-RPC 2.0 notification frame (no `id`; method + params).
   * Auto-starts the stream if `start()` has not been called yet.
   *
   * @param {string} method
   * @param {*}      params
   */
  notify(method, params) {
    if (this._closed) return;
    if (!this._started) this.start();

    const frame = JSON.stringify({ jsonrpc: '2.0', method, params });
    this._res.write(`data: ${frame}\n\n`);
  }

  /**
   * Send the final JSON-RPC 2.0 result frame and close the stream.
   * Subsequent calls are no-ops.
   *
   * @param {string|number|null} id
   * @param {*}                  value
   */
  result(id, value) {
    if (this._closed) return;
    if (!this._started) this.start();

    const frame = JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: value });
    this._res.write(`data: ${frame}\n\n`);
    this._finalize();
  }

  /**
   * Send a JSON-RPC 2.0 error frame and close the stream.
   *
   * @param {string|number|null} id
   * @param {{ code: number, message: string, data?: * }} jsonRpcError
   */
  error(id, jsonRpcError) {
    if (this._closed) return;
    if (!this._started) this.start();

    const frame = JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: jsonRpcError });
    this._res.write(`data: ${frame}\n\n`);
    this._finalize();
  }

  /**
   * Force-close the transport.  Stops keepalive.  Idempotent.
   */
  close() {
    this._teardown();
  }

  /**
   * Whether the transport is closed (stream ended or peer disconnected).
   * @returns {boolean}
   */
  get closed() {
    return this._closed;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /** Write final frame, call res.end(), clear timers. */
  _finalize() {
    this._res.end();
    this._teardown();
  }

  /** Mark closed, clear the keepalive interval. */
  _teardown() {
    if (this._closed) return;
    this._closed = true;
    if (this._heartbeat !== null) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }
}
