/**
 * @file bridge/core/vnc-proxy.js
 *
 * Reverse-proxy a Workspace's KasmVNC (port 6901) to the SCP HTTP server.
 *
 * URL shape:  GET /vnc/:workspace_id            → upgrade to WS, proxy to container:6901
 *             GET /vnc/:workspace_id/<path>     → HTTP proxy
 *
 * Auth (Phase 1, weak): trusts `x-synaps-user-id` header from same-host
 * proxy. Real auth comes in Phase 3 (pria session cookie). For Phase 1
 * we just verify the workspace exists and belongs to the claimed user.
 *
 * No I/O at import. No top-level await.
 */

import http from 'node:http';
import net from 'node:net';

// ─── VncProxy ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} VncProxyOptions
 * @property {object} repo                 - WorkspaceRepo (must have .byId(id) → Promise<object|null>)
 * @property {object} [logger]             - Logger with .info/.warn/.error; defaults to console.
 * @property {Function} [httpRequestFn]    - Injectable http.request replacement (for tests).
 */

/**
 * Reverse-proxy for KasmVNC workspaces.
 *
 * Handles:
 *  - HTTP:  GET /vnc/:workspace_id[/...] → piped to workspace.vnc_url
 *  - WS:    upgrade /vnc/:workspace_id[/...] → raw socket bridge
 *
 * Phase 1 auth: checks `x-synaps-user-id` header matches workspace.synaps_user_id.
 */
export class VncProxy {
  /**
   * @param {VncProxyOptions} opts
   */
  constructor({ repo, logger = console, httpRequestFn = http.request }) {
    if (!repo) throw new TypeError('VncProxy: opts.repo is required');
    this._repo           = repo;
    this._logger         = logger;
    this._httpRequestFn  = httpRequestFn;
  }

  // ── static helpers ──────────────────────────────────────────────────────────

  /**
   * Parse '/vnc/<workspace_id>[/rest/of/path][?qs]' into its components.
   *
   * @param {string} urlPath  - The full request URL path (and optional query string).
   * @returns {{ workspaceId: string, restPath: string } | null}
   */
  static parsePath(urlPath) {
    if (typeof urlPath !== 'string') return null;
    // Strip query string for the regex, preserve it in restPath
    const qIdx    = urlPath.indexOf('?');
    const pathPart = qIdx >= 0 ? urlPath.slice(0, qIdx) : urlPath;
    const qs       = qIdx >= 0 ? urlPath.slice(qIdx)    : '';

    const match = pathPart.match(/^\/vnc\/([^/]+)(\/.*)?$/);
    if (!match) return null;

    const workspaceId = match[1];
    if (!workspaceId) return null;

    const restPath = (match[2] || '/') + qs;
    return { workspaceId, restPath };
  }

  // ── middleware ──────────────────────────────────────────────────────────────

  /**
   * Express-style middleware: handles GET /vnc/* HTTP requests.
   *
   * @returns {Function} (req, res, next) handler
   */
  middleware() {
    return async (req, res, next) => {
      const parsed = VncProxy.parsePath(req.url);
      if (!parsed) {
        next();
        return;
      }

      const { workspaceId, restPath } = parsed;

      // ── auth: require x-synaps-user-id header ──────────────────────────────
      const claimedUserId = req.headers['x-synaps-user-id'];
      if (!claimedUserId) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', message: 'x-synaps-user-id header required' }));
        return;
      }

      // ── look up workspace ──────────────────────────────────────────────────
      let workspace;
      try {
        workspace = await this._repo.byId(workspaceId);
      } catch (err) {
        this._logger.error(`[VncProxy] repo.byId(${workspaceId}) error: ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_gateway', message: 'workspace lookup failed' }));
        return;
      }

      if (!workspace) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found', message: `workspace ${workspaceId} not found` }));
        return;
      }

      // ── ownership check ────────────────────────────────────────────────────
      if (String(workspace.synaps_user_id) !== String(claimedUserId)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden', message: 'workspace does not belong to claimed user' }));
        return;
      }

      // ── proxy the request ──────────────────────────────────────────────────
      const vncUrl = workspace.vnc_url;
      if (!vncUrl) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_gateway', message: 'workspace vnc_url not set' }));
        return;
      }

      let upstreamUrl;
      try {
        // workspace.vnc_url is e.g. "http://172.17.0.5:6901" or "172.17.0.5:6901"
        const base = vncUrl.startsWith('http') ? vncUrl : `http://${vncUrl}`;
        upstreamUrl = new URL(restPath, base);
      } catch (err) {
        this._logger.error(`[VncProxy] invalid vnc_url "${vncUrl}": ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_gateway', message: 'invalid vnc_url' }));
        return;
      }

      const options = {
        hostname: upstreamUrl.hostname,
        port:     upstreamUrl.port || 6901,
        path:     upstreamUrl.pathname + upstreamUrl.search,
        method:   req.method,
        headers:  { ...req.headers, host: upstreamUrl.host },
      };

      const upstreamReq = this._httpRequestFn(options, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      });

      upstreamReq.on('error', (err) => {
        this._logger.warn(`[VncProxy] upstream error for workspace ${workspaceId}: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_gateway', message: err.message }));
        }
      });

      req.pipe(upstreamReq);
    };
  }

  // ── upgrade ─────────────────────────────────────────────────────────────────

  /**
   * HTTP upgrade handler for WebSocket connections to /vnc/*.
   * Bridges raw sockets to the workspace's KasmVNC WebSocket endpoint.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket}           socket
   * @param {Buffer}                              head
   */
  async upgrade(req, socket, head) {
    const parsed = VncProxy.parsePath(req.url);
    if (!parsed) {
      socket.destroy();
      return;
    }

    const { workspaceId, restPath } = parsed;

    // ── auth ─────────────────────────────────────────────────────────────────
    const claimedUserId = req.headers['x-synaps-user-id'];
    if (!claimedUserId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nUnauthorized');
      socket.destroy();
      return;
    }

    // ── workspace lookup ──────────────────────────────────────────────────────
    let workspace;
    try {
      workspace = await this._repo.byId(workspaceId);
    } catch (err) {
      this._logger.error(`[VncProxy] upgrade repo.byId(${workspaceId}) error: ${err.message}`);
      socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nBad Gateway');
      socket.destroy();
      return;
    }

    if (!workspace) {
      socket.write('HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nNot Found');
      socket.destroy();
      return;
    }

    // ── ownership ─────────────────────────────────────────────────────────────
    if (String(workspace.synaps_user_id) !== String(claimedUserId)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nForbidden');
      socket.destroy();
      return;
    }

    const vncUrl = workspace.vnc_url;
    if (!vncUrl) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nno vnc_url');
      socket.destroy();
      return;
    }

    let upstreamHost;
    let upstreamPort;
    let upstreamPath;
    try {
      const base = vncUrl.startsWith('http') ? vncUrl : `http://${vncUrl}`;
      const u    = new URL(restPath, base);
      upstreamHost = u.hostname;
      upstreamPort = parseInt(u.port || '6901', 10);
      upstreamPath = u.pathname + u.search;
    } catch (err) {
      this._logger.error(`[VncProxy] upgrade invalid vnc_url "${vncUrl}": ${err.message}`);
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
      return;
    }

    // Open a raw TCP connection to the upstream KasmVNC and forward the
    // original HTTP upgrade request verbatim, then bridge the two sockets.
    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      // Re-send the original request line + headers so KasmVNC processes the
      // WebSocket handshake itself.
      let rawRequest = `${req.method} ${upstreamPath} HTTP/${req.httpVersion}\r\n`;
      for (const [key, val] of Object.entries(req.headers)) {
        rawRequest += `${key}: ${val}\r\n`;
      }
      rawRequest += '\r\n';
      upstream.write(rawRequest);
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on('error', (err) => {
      this._logger.warn(`[VncProxy] WS upstream error workspace ${workspaceId}: ${err.message}`);
      socket.destroy();
    });

    socket.on('error', () => upstream.destroy());
  }
}
