/**
 * @file bridge/core/scp-http-server.js
 *
 * Minimal HTTP server for the SCP control plane web surface.
 * Only started when [platform] mode = "scp" AND [web] enabled = true.
 *
 * Routes:
 *   GET /health                  → 200 {status:'ok', mode, ts}
 *                                   or graduated component table when heartbeatRepo present
 *   GET /vnc/:workspace_id/...   → VncProxy.middleware
 *   *                            → 404 {error:'not_found'}
 *
 * WebSocket upgrade is dispatched to VncProxy.upgrade for /vnc/*.
 *
 * No I/O at import. start()/stop() lifecycle. Listens on
 * config.web.http_port at config.web.bind.
 */

import http from 'node:http';

// ─── ScpHttpServer ────────────────────────────────────────────────────────────

/**
 * @typedef {object} ScpHttpServerOptions
 * @property {object}   config            - NormalizedConfig (needs .platform, .web)
 * @property {object}   vncProxy          - VncProxy instance (middleware() + upgrade())
 * @property {object}   [logger]          - Logger with .info/.warn/.error; defaults to console.
 * @property {object}   [heartbeatRepo]   - Optional HeartbeatRepo; when absent /health
 *                                          returns the Phase-1 shape unchanged.
 * @property {number}   [bridgeCriticalMs=60_000] - Age threshold (ms) above which the
 *                                          bridge heartbeat is considered critical-stale
 *                                          → 503 down.
 */

/**
 * Minimal HTTP server for the SCP control plane.
 *
 * Lifecycle: instantiate → start() → (handle requests) → stop()
 *
 * The request listener is async-capable: each request is handled inside an
 * async IIFE whose rejections are caught and turned into 500 responses rather
 * than crashing the process.
 */
export class ScpHttpServer {
  /**
   * @param {ScpHttpServerOptions} opts
   */
  constructor({
    config,
    vncProxy,
    logger         = console,
    heartbeatRepo  = null,
    bridgeCriticalMs = 60_000,
  }) {
    if (!config)   throw new TypeError('ScpHttpServer: opts.config is required');
    if (!vncProxy) throw new TypeError('ScpHttpServer: opts.vncProxy is required');

    this._config           = config;
    this._vncProxy         = vncProxy;
    this._logger           = logger;
    this._heartbeatRepo    = heartbeatRepo;
    this._bridgeCriticalMs = bridgeCriticalMs;

    /** @type {import('node:http').Server | null} */
    this._server = null;
  }

  // ── public API ──────────────────────────────────────────────────────────────

  /**
   * Whether the server is currently listening.
   * @returns {boolean}
   */
  get listening() {
    return this._server !== null && this._server.listening;
  }

  /**
   * Start the HTTP server.
   *
   * @returns {Promise<{ port: number }>} The port the server bound to.
   * @throws {Error} If the server is already started.
   */
  async start() {
    if (this._server !== null) {
      throw new Error('ScpHttpServer: already started');
    }

    const { http_port, bind } = this._config.web;
    const mode                = this._config.platform.mode;

    // Build the vncProxy middleware once (returns a new function each call,
    // but the proxy itself is stateless per call so one creation is fine).
    const vncMiddleware = this._vncProxy.middleware();

    // Keep a stable reference to instance properties inside the closure.
    const heartbeatRepo    = this._heartbeatRepo;
    const bridgeCriticalMs = this._bridgeCriticalMs;
    const logger           = this._logger;

    // ── request handler ───────────────────────────────────────────────────────
    const server = http.createServer((req, res) => {
      // Wrap the entire handler in an async IIFE so we can await inside and
      // still catch any unexpected rejection rather than crashing the server.
      (async () => {
        const url = req.url || '/';

        // ── /health ───────────────────────────────────────────────────────────
        if (url === '/health' || url.startsWith('/health?')) {
          const ts = new Date().toISOString();

          // ── backward-compat: no repo → Phase-1 shape ──────────────────────
          if (!heartbeatRepo) {
            _sendJson(res, 200, { status: 'ok', mode, ts });
            return;
          }

          // ── repo present: build component table ───────────────────────────
          let beats;
          try {
            beats = await heartbeatRepo.findAll();
          } catch (err) {
            logger.error('health: heartbeat repo error', err);
            // Shield the failure — return down + empty table rather than 500.
            _sendJson(res, 503, {
              status: 'down',
              mode,
              ts,
              components: [],
              error: 'heartbeat_unavailable',
            });
            return;
          }

          const now = Date.now();
          const components = beats.map((b) => ({
            component: b.component,
            id:        b.id,
            healthy:   b.healthy,
            ts:        b.ts.toISOString(),
            ageMs:     now - b.ts.getTime(),
          }));

          // Status logic:
          // • 503 + 'down'     — no 'bridge' heartbeat, OR bridge ageMs > critical, OR bridge.healthy===false
          // • 200 + 'degraded' — any non-bridge component stale or unhealthy
          // • 200 + 'ok'       — otherwise
          const bridge = components.find((c) => c.component === 'bridge');
          let status;
          let httpStatus;

          if (!bridge || bridge.ageMs > bridgeCriticalMs || !bridge.healthy) {
            status     = 'down';
            httpStatus = 503;
          } else if (
            components.some(
              (c) =>
                c.component !== 'bridge' &&
                (c.ageMs > bridgeCriticalMs || !c.healthy),
            )
          ) {
            status     = 'degraded';
            httpStatus = 200;
          } else {
            status     = 'ok';
            httpStatus = 200;
          }

          _sendJson(res, httpStatus, { status, mode, ts, components });
          return;
        }

        // ── /vnc/* → VncProxy middleware ──────────────────────────────────
        if (url.startsWith('/vnc/')) {
          vncMiddleware(req, res, () => {
            // next() called means VncProxy didn't handle it → 404
            _send404(res);
          });
          return;
        }

        // ── catch-all 404 ────────────────────────────────────────────────
        _send404(res);
      })().catch((err) => {
        // Last-resort handler: async error inside the request IIFE.
        logger.error('[ScpHttpServer] unhandled request error', err);
        if (!res.headersSent) {
          _sendJson(res, 500, { error: 'internal' });
        }
      });
    });

    // ── WebSocket upgrade → VncProxy.upgrade ─────────────────────────────────
    server.on('upgrade', (req, socket, head) => {
      const url = req.url || '/';
      if (url.startsWith('/vnc/')) {
        this._vncProxy.upgrade(req, socket, head);
      } else {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      }
    });

    this._server = server;

    // ── listen ────────────────────────────────────────────────────────────────
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(http_port, bind, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const addr   = /** @type {import('node:net').AddressInfo} */ (server.address());
    const port   = addr.port;
    this._logger.info(`[ScpHttpServer] listening on ${bind}:${port} (mode=${mode})`);

    return { port };
  }

  /**
   * Stop the HTTP server and release the port.
   *
   * Resolves silently if the server was never started or already stopped.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._server) return;

    const server = this._server;
    this._server = null;

    // Close all keep-alive / upgraded connections so server.close() can
    // resolve immediately rather than waiting for them to idle out.
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }

    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this._logger.info('[ScpHttpServer] stopped');
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Send a JSON response with the given HTTP status code and body object.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {object} body
 */
function _sendJson(res, statusCode, body) {
  if (res.headersSent) return;
  const raw = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(raw),
  });
  res.end(raw);
}

/**
 * Send a 404 JSON response.
 *
 * @param {import('node:http').ServerResponse} res
 */
function _send404(res) {
  _sendJson(res, 404, { error: 'not_found' });
}
