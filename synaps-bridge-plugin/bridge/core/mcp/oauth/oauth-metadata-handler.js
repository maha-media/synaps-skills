/**
 * @file bridge/core/mcp/oauth/oauth-metadata-handler.js
 *
 * OAuth 2.0 Discovery / Metadata handler.
 *
 * Serves two RFC-defined well-known documents:
 *
 *   GET /.well-known/oauth-authorization-server
 *     RFC 8414 Authorization Server Metadata.
 *
 *   GET /.well-known/oauth-protected-resource
 *     RFC 9728 Protected Resource Metadata.
 *
 * If the request pathname does not match either path, `handle()` returns
 * false so the caller can fall through to a 404.
 *
 * No I/O beyond HTTP response writing.
 *
 * Spec reference: Phase 9 brief § Track 3 — OAuth 2.1 + PKCE; Wave C C2.
 */

// ── well-known paths ──────────────────────────────────────────────────────────

const PATH_AS   = '/.well-known/oauth-authorization-server';
const PATH_PR   = '/.well-known/oauth-protected-resource';

// ── OauthMetadataHandler ──────────────────────────────────────────────────────

export class OauthMetadataHandler {
  /**
   * @param {object} opts
   * @param {object} opts.config
   *   The resolved [mcp.oauth] config block, plus the daemon `issuer` URL.
   *   Expected shape:
   *     {
   *       issuer:          string,   // e.g. "http://localhost:18080"
   *       authorize_path:  string,   // e.g. "/mcp/v1/authorize"
   *       token_path:      string,   // e.g. "/mcp/v1/token"
   *     }
   * @param {object} [opts.logger]
   *   Optional logger with `.debug?.()`.
   */
  constructor({ config, logger = null }) {
    if (!config) throw new TypeError('OauthMetadataHandler: config is required');

    this._config = config;
    this._logger = logger;

    // Pre-build the JSON bodies once so serialization cost is paid at startup.
    const issuer        = config.issuer;
    const authEndpoint  = `${issuer}${config.authorize_path}`;
    const tokenEndpoint = `${issuer}${config.token_path}`;

    /** @type {string} – serialized RFC 8414 authorization server metadata */
    this._asBody = JSON.stringify({
      issuer,
      authorization_endpoint:                authEndpoint,
      token_endpoint:                        tokenEndpoint,
      response_types_supported:              ['code'],
      grant_types_supported:                 ['authorization_code'],
      code_challenge_methods_supported:      ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });

    /** @type {string} – serialized RFC 9728 protected resource metadata */
    this._prBody = JSON.stringify({
      resource:             issuer,
      authorization_servers: [issuer],
    });
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Handle an incoming request.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse}  res
   * @param {string} pathname  – URL pathname (without query string).
   * @returns {boolean}  true if the request was handled, false to let the
   *                     caller fall through to a 404.
   */
  handle(req, res, pathname) {
    if (pathname === PATH_AS) {
      this._logger?.debug?.('[OauthMetadataHandler] serving oauth-authorization-server metadata');
      _sendJson(res, 200, this._asBody);
      return true;
    }

    if (pathname === PATH_PR) {
      this._logger?.debug?.('[OauthMetadataHandler] serving oauth-protected-resource metadata');
      _sendJson(res, 200, this._prBody);
      return true;
    }

    return false;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Write a pre-serialized JSON body to the response.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {string} rawJson  – Already-serialized JSON string.
 */
function _sendJson(res, statusCode, rawJson) {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(rawJson),
  });
  res.end(rawJson);
}
