/**
 * bridge/core/mcp/mcp-tool-registry.js
 *
 * McpToolRegistry — lists Synaps-exposed MCP tools and dispatches
 * tools/call requests to the user's synaps rpc session via SessionRouter.
 *
 * Phase 8 Track 2: when `surfaceRpcTools` is enabled, `list()` merges
 * per-user rpc tool descriptors (fetched via rpcRouter.listTools) with
 * the static `synaps_chat` descriptor.  Unknown-name calls are forwarded
 * to rpcRouter.callTool() when surfacing is on, or return a JSON-RPC
 * -32601 Method-not-found error when surfacing is off.
 */

import {
  ALL_TOOL_DESCRIPTORS,
  SYNAPS_CHAT_TOOL_DESCRIPTOR,
  validateArgs,
} from './mcp-tool-descriptors.js';

// ─── Error types ──────────────────────────────────────────────────────────────

export class McpToolNotFoundError extends Error {
  /**
   * @param {string} toolName
   */
  constructor(toolName) {
    super(`MCP tool not found: ${toolName}`);
    this.name = 'McpToolNotFoundError';
    this.code = -32601; // JSON-RPC method-not-found
    this.toolName = toolName;
  }
}

export class McpToolInvalidArgsError extends Error {
  /**
   * @param {string} toolName
   * @param {string} message
   */
  constructor(toolName, message) {
    super(`Invalid arguments for ${toolName}: ${message}`);
    this.name = 'McpToolInvalidArgsError';
    this.code = -32602; // JSON-RPC invalid-params
    this.toolName = toolName;
  }
}

export class McpToolTimeoutError extends Error {
  /**
   * @param {string} toolName
   * @param {number} timeoutMs
   */
  constructor(toolName, timeoutMs) {
    super(`Tool ${toolName} timed out after ${timeoutMs}ms`);
    this.name = 'McpToolTimeoutError';
    this.code = -32000;
    this.toolName = toolName;
  }
}

// ─── McpToolRegistry ─────────────────────────────────────────────────────────

export class McpToolRegistry {
  /**
   * @param {object}   opts
   * @param {object}   opts.sessionRouter
   *   Has .getOrCreate({ synaps_user_id }) → Promise<SynapsRpc>.
   * @param {object}   [opts.rpcRouter]
   *   Optional. SynapsRpcSessionRouter (or compatible) with:
   *     listTools(synapsUserId) → Promise<Array>
   *     callTool({synapsUserId, name, args}) → Promise<{content, isError}>
   *   Injected for Phase 8 Track 2 per-tool surfacing.
   * @param {boolean}  [opts.surfaceRpcTools=false]
   *   Feature flag. When true and rpcRouter is present, list() merges the
   *   rpc workspace tool list and call() dispatches unknown names to rpcRouter.
   * @param {number}   [opts.chatTimeoutMs=120_000]
   * @param {object}   [opts.logger=console]
   * @param {Function} [opts.now=Date.now]  — for tests
   */
  constructor({
    sessionRouter,
    rpcRouter = null,
    surfaceRpcTools = false,
    chatTimeoutMs = 120_000,
    logger = console,
    now = Date.now,
  }) {
    if (!sessionRouter) throw new TypeError('McpToolRegistry: sessionRouter required');
    this._sessionRouter = sessionRouter;
    this._rpcRouter = rpcRouter;
    this._surfaceRpcTools = Boolean(surfaceRpcTools);
    this._chatTimeoutMs = chatTimeoutMs;
    this._logger = logger;
    this._now = now;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * List all available tools.
   *
   * When `surfaceRpcTools` is enabled and `rpcRouter` is injected, fetches the
   * rpc workspace tool list for the given user and merges it after `synaps_chat`.
   * Caching is handled by the rpcRouter itself (30-second TTL per user).
   *
   * @param {object} [ctx]  { synaps_user_id, institution_id }
   * @returns {Promise<Array>}
   */
  async listTools(ctx = {}) {
    const synapsUserId = ctx?.synaps_user_id ?? ctx?.synapsUserId ?? null;

    // Always include the static synaps_chat tool.
    const base = ALL_TOOL_DESCRIPTORS.slice();

    if (this._surfaceRpcTools && this._rpcRouter && synapsUserId) {
      let rpcTools = [];
      try {
        rpcTools = await this._rpcRouter.listTools(synapsUserId);
      } catch (err) {
        this._logger.warn(
          `McpToolRegistry.listTools: rpcRouter.listTools failed: ${err.message}`,
        );
        rpcTools = [];
      }
      return [...base, ...rpcTools];
    }

    return base;
  }

  /**
   * Invoke a tool by name. Returns the MCP-shape `{content, isError}` result.
   *
   * Routing:
   *   - name === 'synaps_chat' → existing sessionRouter path
   *   - else, surfaceRpcTools && rpcRouter → rpcRouter.callTool(...)
   *   - else → throw McpToolNotFoundError (JSON-RPC -32601)
   *
   * @param {object} call
   * @param {string} call.name
   * @param {object} call.arguments
   * @param {string} call.synaps_user_id
   * @param {string} [call.institution_id]
   * @returns {Promise<{content: Array, isError: boolean}>}
   * @throws {McpToolNotFoundError|McpToolInvalidArgsError}
   */
  async callTool({ name, arguments: args, synaps_user_id, institution_id }) {
    // ── synaps_chat: existing path ─────────────────────────────────────────
    if (name === SYNAPS_CHAT_TOOL_DESCRIPTOR.name) {
      const v = validateArgs(args ?? {}, SYNAPS_CHAT_TOOL_DESCRIPTOR.inputSchema);
      if (!v.valid) {
        throw new McpToolInvalidArgsError(name, v.error);
      }
      return this._invokeChat({ args, synaps_user_id });
    }

    // ── unknown tool: forward to rpcRouter when surfacing is on ───────────
    if (this._surfaceRpcTools && this._rpcRouter) {
      return this._rpcRouter.callTool({
        synapsUserId: synaps_user_id,
        name,
        args: args ?? {},
      });
    }

    // ── surfacing off (or no rpcRouter): Method not found ─────────────────
    throw new McpToolNotFoundError(name);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Route a validated synaps_chat call through the session router.
   *
   * @param {object} opts
   * @param {object} opts.args             — validated call arguments
   * @param {string} opts.synaps_user_id
   * @returns {Promise<{content: Array, isError: boolean}>}
   */
  async _invokeChat({ args, synaps_user_id }) {
    const rpc = await this._sessionRouter.getOrCreate({ synaps_user_id });
    const fullPrompt = args.context
      ? `${args.context}\n\n${args.prompt}`
      : args.prompt;

    // Race rpc.prompt() against a timeout that doesn't keep the event loop alive.
    const timeoutPromise = new Promise((_resolve, reject) => {
      const t = setTimeout(
        () => reject(new McpToolTimeoutError(SYNAPS_CHAT_TOOL_DESCRIPTOR.name, this._chatTimeoutMs)),
        this._chatTimeoutMs,
      );
      if (typeof t.unref === 'function') t.unref();
    });

    try {
      const result = await Promise.race([rpc.prompt(fullPrompt), timeoutPromise]);

      // Normalise the result to a plain string.
      // rpc.prompt() resolves to the flattened frame body which typically has
      // a `message` field; handle bare strings and fallback to JSON.
      const text =
        typeof result === 'string'
          ? result
          : result?.message != null
            ? result.message
            : JSON.stringify(result);

      return {
        content: [{ type: 'text', text }],
        isError: false,
      };
    } catch (err) {
      if (err instanceof McpToolTimeoutError) {
        // Surface timeout as an isError:true MCP result rather than a thrown
        // JSON-RPC error — the call consumed workspace resources and a partial
        // (empty) result is more useful to the client than a hard error.
        return {
          content: [{ type: 'text', text: `Tool timed out after ${this._chatTimeoutMs}ms` }],
          isError: true,
        };
      }
      throw err;
    }
  }
}
