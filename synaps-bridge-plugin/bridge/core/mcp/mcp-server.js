/**
 * @file bridge/core/mcp/mcp-server.js
 *
 * McpServer — JSON-RPC 2.0 dispatcher for every /mcp/v1 request.
 *
 * McpServer.handle({ token, body }) is the single entry-point called by the
 * HTTP layer. It is a pure dispatcher: no HTTP primitives, fully injectable
 * dependencies, returns plain data objects.
 *
 * Per MCP HTTP spec:
 *   - JSON-RPC errors are returned with HTTP 200 (error is in the envelope).
 *   - 401 for missing / invalid auth (WWW-Authenticate header is added by the
 *     HTTP layer; we just return statusCode: 401).
 *   - 400 for a structurally invalid JSON-RPC envelope.
 *   - 202 + null body for notifications (no `id` field, or methods/…).
 *
 * Phase 9 Wave B additions:
 *   - Track 2: streamDeltas opt — when true AND wantsSSE, onDelta callback is
 *     wired through to toolRegistry.callTool so per-token frames stream live.
 *   - Track 4: aclResolver opt — per-tool ACL check after approvalGate.
 *     Deny-wins; aclResolver.check() throwing fails-open (logs warn, proceeds).
 *   - Track 6: metrics opt — counters + histogram recorded on every dispatch.
 */

import {
  McpToolNotFoundError,
  McpToolInvalidArgsError,
  McpToolTimeoutError,
} from './mcp-tool-registry.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export const MCP_ERROR_CODES = Object.freeze({
  PARSE_ERROR:       -32700,
  INVALID_REQUEST:   -32600,
  METHOD_NOT_FOUND:  -32601,
  INVALID_PARAMS:    -32602,
  INTERNAL_ERROR:    -32603,
  // application-defined
  AUTH_REQUIRED:     -32001,
  TOOL_TIMEOUT:      -32002,
  APPROVAL_REQUIRED: -32003,
  RATE_LIMITED:      -32029,
});

const DEFAULT_INSTRUCTIONS =
  `Synaps Control Plane MCP gateway. Use the synaps_chat tool to send prompts ` +
  `to your Synaps agent workspace. The agent has access to your tools, memory, ` +
  `and credentials. Visit your pria admin console to configure tool approval policies.`;

const NO_OP_AUDIT = Object.freeze({ record: async () => {} });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a JSON-RPC 2.0 success response.
 * @param {string|number|null|undefined} id
 * @param {*} result
 */
function okResponse(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/**
 * Build a JSON-RPC 2.0 error response.
 * @param {string|number|null|undefined} id
 * @param {number} code
 * @param {string} message
 * @param {*} [data]
 */
function errResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

// ─── McpServer ────────────────────────────────────────────────────────────────

export class McpServer {
  /**
   * @param {object}   opts
   * @param {object}   opts.tokenResolver   — { resolve(token) → {synaps_user_id, institution_id, token_id} | null }
   * @param {object}   opts.toolRegistry    — { listTools(ctx), callTool({...args}) }
   * @param {object}   opts.approvalGate    — { filterTools(tools, ctx), isToolAllowed(name, ctx) }
   * @param {object}   [opts.audit]         — { record(entry) } — defaults to no-op
   * @param {object}   [opts.rateLimiter]   — { check({tokenHash, ip}) → {allowed, retryAfterMs?, scope?} }
   *                                          When omitted, rate-limiting is skipped.
   * @param {boolean}  [opts.sseEnabled=false] — When true, tools/call with Accept: text/event-stream
   *                                             returns {sse:true, sseDispatcher} instead of a JSON body.
   * @param {object}   [opts.aclResolver=null]  — McpToolAclResolver instance or null (Phase 9 Track 4).
   *                                              When provided, runs after approvalGate and before dispatch.
   *                                              Deny decision returns METHOD_NOT_FOUND. Throws fail-open.
   * @param {boolean}  [opts.streamDeltas=false] — Phase 9 Track 2. When true AND wantsSSE, the
   *                                              onDelta callback is threaded through callTool so
   *                                              per-token synaps/delta frames stream to the client.
   * @param {object}   [opts.metrics=null]       — MetricsRegistry instance or null (Phase 9 Track 6).
   *                                              When provided, counters and histograms are recorded.
   * @param {object}   [opts.logger=console]
   * @param {string}   [opts.serverName='synaps-control-plane']
   * @param {string}   [opts.serverVersion='0.1.0']
   * @param {string}   [opts.instructions]  — text shown to MCP clients post-init
   * @param {Function} [opts.now=Date.now]
   */
  constructor({
    tokenResolver,
    toolRegistry,
    approvalGate,
    audit         = NO_OP_AUDIT,
    rateLimiter   = null,
    sseEnabled    = false,
    aclResolver   = null,
    streamDeltas  = false,
    metrics       = null,
    logger        = console,
    serverName    = 'synaps-control-plane',
    serverVersion = '0.1.0',
    instructions  = DEFAULT_INSTRUCTIONS,
    now           = Date.now,
  } = {}) {
    if (!tokenResolver) throw new TypeError('McpServer: tokenResolver required');
    if (!toolRegistry)  throw new TypeError('McpServer: toolRegistry required');
    if (!approvalGate)  throw new TypeError('McpServer: approvalGate required');

    this._tokenResolver = tokenResolver;
    this._toolRegistry  = toolRegistry;
    this._approvalGate  = approvalGate;
    this._audit         = audit;
    this._rateLimiter   = rateLimiter;
    this._sseEnabled    = Boolean(sseEnabled);
    this._aclResolver   = aclResolver ?? null;
    this._streamDeltas  = Boolean(streamDeltas);
    this._logger        = logger;
    this._serverName    = serverName;
    this._serverVersion = serverVersion;
    this._instructions  = instructions;
    this._now           = now;

    // ── Phase 9 Track 6 — Metric handles (lazily initialised when metrics provided) ──
    this._counters = metrics ? {
      requests:  metrics.counter('synaps_mcp_requests_total', {
        help:       'Total MCP tool requests.',
        labelNames: ['tool', 'outcome'],
      }),
      aclDenials: metrics.counter('synaps_mcp_acl_denials_total', {
        help:       'Total ACL denials.',
        labelNames: ['tool'],
      }),
      sseDeltas: metrics.counter('synaps_mcp_sse_delta_frames_total', {
        help:       'Total SSE synaps/delta frames emitted.',
        labelNames: [],
      }),
    } : null;

    this._histograms = metrics ? {
      duration: metrics.histogram('synaps_mcp_request_duration_seconds', {
        help:       'MCP request duration.',
        labelNames: ['tool'],
      }),
    } : null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Handle a single JSON-RPC request body.
   *
   * @param {object}           req
   * @param {string|undefined} req.token      — raw bearer token from MCP-Token header
   * @param {object|null}      req.body       — already-parsed JSON body (or null for empty)
   * @param {string|undefined} [req.tokenHash] — SHA-256 hex hash of bearer token (for rate-limiting)
   * @param {string|undefined} [req.ip]        — remote IP address (for rate-limiting)
   * @param {string|undefined} [req.accept]    — value of Accept header (for SSE detection)
   * @returns {Promise<{statusCode: number, body: object|null}
   *                  |{statusCode: 200, sse: true, sseDispatcher: Function}>}
   */
  async handle({ token, body, tokenHash, ip, accept }) {
    const startTs = this._now();

    // ── 0. Rate-limit check ───────────────────────────────────────────────────
    //  Runs BEFORE body validation so even malformed requests are counted.
    //  Only applied when a rateLimiter is injected.

    if (this._rateLimiter) {
      const rl = this._rateLimiter.check({ tokenHash: tokenHash ?? null, ip: ip ?? null });
      if (!rl.allowed) {
        return {
          statusCode: 429,
          body: errResponse(
            null,
            MCP_ERROR_CODES.RATE_LIMITED,
            'Too many requests',
            {
              retry_after_ms: rl.retryAfterMs ?? 1000,
              scope:          rl.scope ?? 'unknown',
            },
          ),
          // Callers can read retryAfterMs from body.error.data to set Retry-After header.
          retryAfterMs: rl.retryAfterMs ?? 1000,
        };
      }
    }

    // ── 1. Parse-time validation ──────────────────────────────────────────────

    if (body == null) {
      await this._recordAudit({
        ts: startTs, synaps_user_id: null, institution_id: null,
        method: null, tool_name: null, outcome: 'error',
        duration_ms: this._now() - startTs,
        error_code: MCP_ERROR_CODES.PARSE_ERROR,
        client_info: null,
      });
      return {
        statusCode: 400,
        body: errResponse(null, MCP_ERROR_CODES.PARSE_ERROR, 'Parse error: body is required'),
      };
    }

    if (body.jsonrpc !== '2.0') {
      await this._recordAudit({
        ts: startTs, synaps_user_id: null, institution_id: null,
        method: body.method ?? null, tool_name: null, outcome: 'error',
        duration_ms: this._now() - startTs,
        error_code: MCP_ERROR_CODES.INVALID_REQUEST,
        client_info: null,
      });
      return {
        statusCode: 400,
        body: errResponse(
          body.id,
          MCP_ERROR_CODES.INVALID_REQUEST,
          'Invalid Request: jsonrpc must be "2.0"',
        ),
      };
    }

    if (!body.method || typeof body.method !== 'string') {
      await this._recordAudit({
        ts: startTs, synaps_user_id: null, institution_id: null,
        method: null, tool_name: null, outcome: 'error',
        duration_ms: this._now() - startTs,
        error_code: MCP_ERROR_CODES.INVALID_REQUEST,
        client_info: null,
      });
      return {
        statusCode: 400,
        body: errResponse(
          body.id,
          MCP_ERROR_CODES.INVALID_REQUEST,
          'Invalid Request: method must be a non-empty string',
        ),
      };
    }

    const { method, id, params = {} } = body;

    // ── 2. Notification handling ──────────────────────────────────────────────
    //  a) methods that start with 'notifications/'
    //  b) requests that have no `id` field at all (not even null)

    const isNotification = method.startsWith('notifications/') || !('id' in body);

    if (isNotification) {
      // Fire-and-forget — no response body, no audit needed per spec.
      return { statusCode: 202, body: null };
    }

    // ── 3. Auth ───────────────────────────────────────────────────────────────

    let identity = null; // { synaps_user_id, institution_id, token_id }

    if (method !== 'initialize') {
      identity = await this._tokenResolver.resolve(token);

      if (!identity) {
        await this._recordAudit({
          ts: startTs, synaps_user_id: null, institution_id: null,
          method, tool_name: null, outcome: 'denied',
          duration_ms: this._now() - startTs,
          error_code: MCP_ERROR_CODES.AUTH_REQUIRED,
          client_info: null,
        });
        return {
          statusCode: 401,
          body: errResponse(id, MCP_ERROR_CODES.AUTH_REQUIRED, 'Authentication required'),
        };
      }
    }

    const synaps_user_id  = identity?.synaps_user_id  ?? null;
    const institution_id  = identity?.institution_id  ?? null;
    const ctx = { synaps_user_id, institution_id };

    // client_info present for 'initialize' calls
    const client_info = params?.clientInfo ?? null;

    // ── 4. Method dispatch ────────────────────────────────────────────────────

    let statusCode = 200;
    let responseBody;
    let tool_name   = null;
    let outcome     = 'ok';
    let error_code  = null;
    let acl_outcome; // undefined unless ACL gate ran (Phase 9 Track 4)

    try {
      switch (method) {

        // ── initialize ─────────────────────────────────────────────────────
        case 'initialize': {
          const clientVersion = params?.protocolVersion;
          const protocolVersion =
            clientVersion === MCP_PROTOCOL_VERSION
              ? MCP_PROTOCOL_VERSION
              : MCP_PROTOCOL_VERSION;   // always return our version (client falls back)

          responseBody = okResponse(id, {
            protocolVersion,
            capabilities: {
              tools:   { listChanged: false },
              logging: {},
            },
            serverInfo: {
              name:    this._serverName,
              version: this._serverVersion,
            },
            instructions: this._instructions,
          });
          break;
        }

        // ── ping ───────────────────────────────────────────────────────────
        case 'ping': {
          responseBody = okResponse(id, {});
          break;
        }

        // ── tools/list ─────────────────────────────────────────────────────
        case 'tools/list': {
          let tools;
          try {
            tools = await this._toolRegistry.listTools(ctx);
          } catch (err) {
            this._logger.error('[McpServer] toolRegistry.listTools threw:', err.message);
            outcome    = 'error';
            error_code = MCP_ERROR_CODES.INTERNAL_ERROR;
            responseBody = okResponse(id, null); // placeholder — overwritten below
            responseBody = errResponse(id, MCP_ERROR_CODES.INTERNAL_ERROR, 'Internal error');
            break;
          }

          let filtered;
          try {
            filtered = await this._approvalGate.filterTools(tools, ctx);
          } catch (err) {
            this._logger.error('[McpServer] approvalGate.filterTools threw:', err.message);
            outcome    = 'error';
            error_code = MCP_ERROR_CODES.INTERNAL_ERROR;
            responseBody = errResponse(id, MCP_ERROR_CODES.INTERNAL_ERROR, 'Internal error');
            break;
          }

          responseBody = okResponse(id, { tools: filtered });
          break;
        }

        // ── tools/call ─────────────────────────────────────────────────────
        case 'tools/call': {
          const callName = params?.name;
          const callArgs = params?.arguments;
          tool_name = callName ?? null;

          if (!callName) {
            outcome    = 'error';
            error_code = MCP_ERROR_CODES.INVALID_PARAMS;
            responseBody = errResponse(
              id,
              MCP_ERROR_CODES.INVALID_PARAMS,
              'Invalid params: params.name is required',
            );
            break;
          }

          // Approval gate check
          const allowed = await this._approvalGate.isToolAllowed(callName, ctx);
          if (!allowed) {
            outcome    = 'denied';
            error_code = MCP_ERROR_CODES.APPROVAL_REQUIRED;
            responseBody = errResponse(
              id,
              MCP_ERROR_CODES.APPROVAL_REQUIRED,
              `Tool "${callName}" requires approval`,
            );
            break;
          }

          // ── Phase 9 Track 4 — ACL gate ─────────────────────────────────
          // Runs after approvalGate and before dispatch.
          // Deny-wins; resolver throwing fails-open.
          if (this._aclResolver) {
            try {
              const aclDecision = await this._aclResolver.check({
                synaps_user_id,
                tool_name: callName,
              });
              if (aclDecision && aclDecision.allowed === false) {
                outcome     = 'denied';
                error_code  = MCP_ERROR_CODES.METHOD_NOT_FOUND;
                acl_outcome = 'deny';
                responseBody = errResponse(
                  id,
                  MCP_ERROR_CODES.METHOD_NOT_FOUND,
                  `Tool denied by ACL: ${aclDecision.reason || 'no reason'}`,
                );
                this._counters?.aclDenials?.inc({ tool: callName });
                break;
              }
            } catch (err) {
              this._logger.warn?.(
                '[McpServer] aclResolver.check threw — failing open:',
                err?.message,
              );
            }
          }

          // ── SSE streaming branch ────────────────────────────────────────
          // When the client sends Accept: text/event-stream AND sse is enabled,
          // signal to the HTTP layer that it should stream the response.
          const wantsSSE =
            this._sseEnabled &&
            typeof accept === 'string' &&
            accept.includes('text/event-stream');

          if (wantsSSE) {
            // Capture all per-request state for the async dispatcher closure.
            const capturedId             = id;
            const capturedToolName       = tool_name;
            const capturedArgs           = callArgs;
            const capturedCallName       = callName;
            const capturedSynapsUserId   = synaps_user_id;
            const capturedInstitutionId  = institution_id;
            const capturedClientInfo     = client_info;
            const capturedStartTs        = startTs;
            const recordAudit            = (p) => this._recordAudit(p);
            const counters               = this._counters;
            const histograms             = this._histograms;
            const streamDeltasEnabled    = this._streamDeltas;

            return {
              statusCode:    200,
              sse:           true,
              sseDispatcher: async (transport) => {
                let dispatchOutcome   = 'ok';
                let dispatchErrorCode = null;
                try {
                  const result = await this._toolRegistry.callTool({
                    name:           capturedCallName,
                    arguments:      capturedArgs,
                    synaps_user_id: capturedSynapsUserId,
                    institution_id: capturedInstitutionId,
                    onDelta: streamDeltasEnabled
                      ? (text) => {
                          try {
                            transport.delta(capturedId, text);
                            counters?.sseDeltas?.inc();
                          } catch (_e) {
                            // Ignore write-after-close errors
                          }
                        }
                      : undefined,
                  });
                  // Backward-compat: still emit the legacy notify + result pair
                  transport.notify('synaps/result', result);
                  transport.result(capturedId, result);
                } catch (err) {
                  dispatchOutcome = 'error';
                  if (err?.name === 'McpToolNotFoundError' || err instanceof McpToolNotFoundError) {
                    dispatchErrorCode = MCP_ERROR_CODES.METHOD_NOT_FOUND;
                  } else if (err?.name === 'McpToolInvalidArgsError' || err instanceof McpToolInvalidArgsError) {
                    dispatchErrorCode = MCP_ERROR_CODES.INVALID_PARAMS;
                  } else if (err?.name === 'McpToolTimeoutError' || err instanceof McpToolTimeoutError) {
                    dispatchErrorCode = MCP_ERROR_CODES.TOOL_TIMEOUT;
                  } else {
                    dispatchErrorCode = MCP_ERROR_CODES.INTERNAL_ERROR;
                  }
                  transport.error(capturedId, {
                    code:    dispatchErrorCode,
                    message: err?.message || 'tool error',
                  });
                } finally {
                  const dur = (this._now() - capturedStartTs) / 1000;
                  histograms?.duration?.observe({ tool: capturedToolName }, dur);
                  counters?.requests?.inc({ tool: capturedToolName, outcome: dispatchOutcome });
                  await recordAudit({
                    ts:             capturedStartTs,
                    synaps_user_id: capturedSynapsUserId,
                    institution_id: capturedInstitutionId,
                    method:         'tools/call',
                    tool_name:      capturedToolName,
                    outcome:        dispatchOutcome,
                    duration_ms:    this._now() - capturedStartTs,
                    error_code:     dispatchErrorCode,
                    client_info:    capturedClientInfo,
                  });
                }
              },
            };
          }

          // ── Non-SSE (synchronous) dispatch ─────────────────────────────
          try {
            const result = await this._toolRegistry.callTool({
              name:           callName,
              arguments:      callArgs,
              synaps_user_id,
              institution_id,
            });

            // result is the MCP {content, isError} shape — wrap in JSON-RPC result
            responseBody = okResponse(id, result);
          } catch (err) {
            outcome    = 'error';
            if (err instanceof McpToolNotFoundError) {
              error_code   = MCP_ERROR_CODES.METHOD_NOT_FOUND;
              responseBody = errResponse(id, MCP_ERROR_CODES.METHOD_NOT_FOUND, err.message);
            } else if (err instanceof McpToolInvalidArgsError) {
              error_code   = MCP_ERROR_CODES.INVALID_PARAMS;
              responseBody = errResponse(id, MCP_ERROR_CODES.INVALID_PARAMS, err.message);
            } else if (err instanceof McpToolTimeoutError) {
              error_code   = MCP_ERROR_CODES.TOOL_TIMEOUT;
              responseBody = errResponse(id, MCP_ERROR_CODES.TOOL_TIMEOUT, err.message);
            } else {
              this._logger.error('[McpServer] toolRegistry.callTool threw:', err);
              error_code   = MCP_ERROR_CODES.INTERNAL_ERROR;
              responseBody = errResponse(id, MCP_ERROR_CODES.INTERNAL_ERROR, 'Internal error');
            }
          }
          break;
        }

        // ── unsupported / unknown methods ──────────────────────────────────
        case 'resources/list':
        case 'resources/read':
        case 'prompts/list':
        case 'prompts/get':
        default: {
          outcome    = 'error';
          error_code = MCP_ERROR_CODES.METHOD_NOT_FOUND;
          responseBody = errResponse(
            id,
            MCP_ERROR_CODES.METHOD_NOT_FOUND,
            `Method not found: ${method}`,
          );
          break;
        }
      }
    } catch (unexpectedErr) {
      // Safety net for unexpected bugs in the dispatcher itself.
      this._logger.error('[McpServer] Unexpected dispatcher error:', unexpectedErr.message);
      outcome    = 'error';
      error_code = MCP_ERROR_CODES.INTERNAL_ERROR;
      responseBody = errResponse(id, MCP_ERROR_CODES.INTERNAL_ERROR, 'Internal error');
    }

    // ── 5. Metrics (non-SSE path) — Track 6 ──────────────────────────────────
    // SSE path records metrics inside the dispatcher (finally block above).
    // Non-SSE path records here, alongside audit.
    if (method === 'tools/call' && tool_name) {
      const dur = (this._now() - startTs) / 1000;
      this._histograms?.duration?.observe({ tool: tool_name }, dur);
      this._counters?.requests?.inc({ tool: tool_name, outcome });
    }

    // ── 6. Audit ──────────────────────────────────────────────────────────────

    await this._recordAudit({
      ts:              startTs,
      synaps_user_id,
      institution_id,
      method,
      tool_name,
      outcome,
      duration_ms:     this._now() - startTs,
      error_code,
      client_info,
      acl_outcome,
    });

    return { statusCode, body: responseBody };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Fire-and-forget audit record. Audit failures must never propagate.
   *
   * @param {object}           entry
   * @param {string|undefined} [entry.acl_outcome] — 'deny' when ACL gate fired (Phase 9 Track 4).
   * @private
   */
  async _recordAudit(entry) {
    try {
      await this._audit.record(entry);
    } catch (err) {
      // Swallow — per Wave A2 contract, audit failures do not block responses.
      this._logger.error?.('[McpServer] audit.record threw (swallowed):', err.message);
    }
  }
}
