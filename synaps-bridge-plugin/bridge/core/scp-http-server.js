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
import { McpSseTransport } from './mcp/mcp-sse-transport.js';
import { hashToken }       from './mcp/mcp-token-resolver.js';

// ─── sentinels ────────────────────────────────────────────────────────────────
const BODY_TOO_LARGE = Symbol('body_too_large');
const BAD_JSON       = Symbol('bad_json');

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
 * @property {object}   [rateLimiter]     - McpRateLimiter instance; when present, passed
 *                                          tokenHash + ip on every /mcp/v1 POST.
 * @property {boolean}  [sseEnabled=false]- When true, SSE upgrade is performed on
 *                                          tools/call responses that carry sse:true.
 * @property {object}   [dcrHandler]      - McpDcrHandler instance; when present,
 *                                          POST /mcp/v1/register is handled.
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
    mcpServer      = null,
    maxBodyBytes   = 262_144,
    rateLimiter    = null,
    sseEnabled     = false,
    dcrHandler     = null,
    metricsRegistry = null,
    metricsConfig  = null,
  }) {
    if (!config)   throw new TypeError('ScpHttpServer: opts.config is required');
    if (!vncProxy) throw new TypeError('ScpHttpServer: opts.vncProxy is required');

    this._config           = config;
    this._vncProxy         = vncProxy;
    this._logger           = logger;
    this._heartbeatRepo    = heartbeatRepo;
    this._bridgeCriticalMs = bridgeCriticalMs;
    this._mcpServer        = mcpServer;
    this._maxBodyBytes     = maxBodyBytes;
    this._rateLimiter      = rateLimiter;
    this._sseEnabled       = Boolean(sseEnabled);
    this._dcrHandler       = dcrHandler;
    this._metricsRegistry  = metricsRegistry;
    this._metricsConfig    = metricsConfig;

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
    const mcpServer        = this._mcpServer;
    const maxBodyBytes     = this._maxBodyBytes;
    const rateLimiter      = this._rateLimiter;
    const sseEnabled       = this._sseEnabled;
    const dcrHandler       = this._dcrHandler;
    const metricsRegistry  = this._metricsRegistry;
    const metricsConfig    = this._metricsConfig;
    const self             = this;

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

        // ── /metrics → Prometheus text (Phase 9 Wave C Track 6) ─────────────
        const metricsPath = metricsConfig?.path ?? '/metrics';
        if (url === metricsPath || url.startsWith(metricsPath + '?')) {
          if (!metricsRegistry || !metricsConfig?.enabled) {
            return _send404(res);
          }
          // Bind guard: only respond to localhost or the configured bind address.
          const remoteAddr = req.socket?.remoteAddress ?? '';
          const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
          const allowedBind     = metricsConfig?.bind ?? '127.0.0.1';
          if (!LOCALHOST_ADDRS.has(remoteAddr) && remoteAddr !== allowedBind) {
            if (!res.headersSent) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
            }
            return;
          }
          const body = metricsRegistry.render();
          if (!res.headersSent) {
            res.writeHead(200, {
              'Content-Type':   'text/plain; version=0.0.4; charset=utf-8',
              'Content-Length': Buffer.byteLength(body),
            });
            res.end(body);
          }
          return;
        }

        // ── /mcp/v1/register → DCR ───────────────────────────────────────────
        if (url === '/mcp/v1/register') {
          if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'method_not_allowed' }));
            return;
          }
          if (!dcrHandler || !dcrHandler.enabled) {
            return _sendJson(res, 404, { error: 'not_found' });
          }
          const dcrBody = await self._readJsonBody(req, maxBodyBytes);
          if (dcrBody === BODY_TOO_LARGE) {
            return _sendJson(res, 413, { error: 'request_entity_too_large' });
          }
          if (dcrBody === BAD_JSON) {
            return _sendJson(res, 400, { error: 'invalid_request', error_description: 'Malformed JSON' });
          }
          const dcrOut = await dcrHandler.register(dcrBody);
          return _sendJson(res, dcrOut.statusCode, dcrOut.body);
        }

        // ── /mcp/v1 → MCP JSON-RPC dispatcher ────────────────────────────────
        if (url === '/mcp/v1') {
          if (req.method === 'GET') {
            res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'method_not_allowed' }));
            return;
          }
          if (req.method === 'POST') {
            if (!mcpServer) {
              return _sendJson(res, 404, { error: 'not_found' });
            }
            const body = await self._readJsonBody(req, maxBodyBytes);
            if (body === BODY_TOO_LARGE) {
              return _sendJson(res, 413, {
                jsonrpc: '2.0', id: null,
                error: { code: -32600, message: `Request body exceeds ${maxBodyBytes} bytes` },
              });
            }
            if (body === BAD_JSON) {
              return _sendJson(res, 400, {
                jsonrpc: '2.0', id: null,
                error: { code: -32700, message: 'Parse error' },
              });
            }
            const token = req.headers['mcp-token'] || null;

            // Compute tokenHash for rate-limiting (SHA-256 of raw bearer).
            const tokenHash = token ? hashToken(token) : null;

            // Normalise IPv6-mapped IPv4 (::ffff:1.2.3.4 → 1.2.3.4).
            const rawIp  = req.socket?.remoteAddress ?? null;
            const ip     = rawIp ? rawIp.replace(/^::ffff:/, '') : null;

            // Accept header for SSE detection.
            const accept = req.headers['accept'] ?? null;

            const out = await mcpServer.handle({ token, body, tokenHash, ip, accept });

            // ── SSE streaming path ────────────────────────────────────────────
            if (out.sse === true && sseEnabled && typeof out.sseDispatcher === 'function') {
              const transport = new McpSseTransport({ res, logger });
              transport.start();
              try {
                await out.sseDispatcher(transport);
              } catch (sseErr) {
                logger.error('[ScpHttpServer] SSE dispatcher error', sseErr);
                const errId = body?.id ?? null;
                transport.error(errId, { code: -32603, message: 'Internal error' });
              } finally {
                transport.close();
              }
              return;
            }

            // ── Rate-limited — set Retry-After header ─────────────────────────
            if (out.statusCode === 429 && out.retryAfterMs != null) {
              const retrySecs = Math.ceil(out.retryAfterMs / 1000);
              if (!res.headersSent) {
                res.setHeader('Retry-After', String(retrySecs));
              }
            }

            if (out.body === null) {
              res.writeHead(out.statusCode);
              return res.end();
            }
            return _sendJson(res, out.statusCode, out.body);
          }
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

  /**
   * Read and parse the request body, enforcing the byte cap.
   *
   * Resolves with:
   *   - Parsed JSON value (object/array/etc.) on success.
   *   - `BODY_TOO_LARGE` sentinel if data exceeds `max` bytes.
   *   - `BAD_JSON` sentinel if the body is not valid JSON.
   *
   * Rejects only on stream errors or a 5-second timeout (turned into 500 by
   * the outer async-IIFE catch).
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {number} max   Maximum allowed bytes.
   * @returns {Promise<*>}
   */
  _readJsonBody(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let done = false;

      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error('ScpHttpServer: body read timeout'));
        }
      }, 5_000);

      req.on('data', (chunk) => {
        if (done) return;
        total += chunk.length;
        if (total > max) {
          done = true;
          clearTimeout(timer);
          // Drain remaining data so the socket stays clean.
          req.resume();
          resolve(BODY_TOO_LARGE);
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(BAD_JSON);
        }
      });

      req.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
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
