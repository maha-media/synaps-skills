/**
 * @file bridge/core/scp-http-server.js
 *
 * Minimal HTTP server for the SCP control plane web surface.
 * Only started when [platform] mode = "scp" AND [web] enabled = true.
 *
 * Routes:
 *   GET /health                  → 200 {status:'ok', mode, ts}
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
 * @property {object}   config    - NormalizedConfig (needs .platform, .web)
 * @property {object}   vncProxy  - VncProxy instance (middleware() + upgrade())
 * @property {object}   [logger]  - Logger with .info/.warn/.error; defaults to console.
 */

/**
 * Minimal HTTP server for the SCP control plane.
 *
 * Lifecycle: instantiate → start() → (handle requests) → stop()
 *
 * All requests are handled synchronously in the request listener; no
 * express dependency. Uses only Node built-in `http`.
 */
export class ScpHttpServer {
  /**
   * @param {ScpHttpServerOptions} opts
   */
  constructor({ config, vncProxy, logger = console }) {
    if (!config) throw new TypeError('ScpHttpServer: opts.config is required');
    if (!vncProxy) throw new TypeError('ScpHttpServer: opts.vncProxy is required');

    this._config   = config;
    this._vncProxy = vncProxy;
    this._logger   = logger;

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

    // ── request handler ───────────────────────────────────────────────────────
    const server = http.createServer((req, res) => {
      const url = req.url || '/';

      // ── /health ─────────────────────────────────────────────────────────────
      if (url === '/health' || url.startsWith('/health?')) {
        const body = JSON.stringify({ status: 'ok', mode, ts: new Date().toISOString() });
        res.writeHead(200, {
          'Content-Type':  'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }

      // ── /vnc/* → VncProxy middleware ─────────────────────────────────────
      if (url.startsWith('/vnc/')) {
        vncMiddleware(req, res, () => {
          // next() called means VncProxy didn't handle it → 404
          _send404(res);
        });
        return;
      }

      // ── catch-all 404 ────────────────────────────────────────────────────
      _send404(res);
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
 * Send a 404 JSON response.
 *
 * @param {import('node:http').ServerResponse} res
 */
function _send404(res) {
  if (res.headersSent) return;
  const body = JSON.stringify({ error: 'not_found' });
  res.writeHead(404, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
