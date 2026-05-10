/**
 * bridge/core/mcp/mcp-tool-registry.js
 *
 * McpToolRegistry — lists Synaps-exposed MCP tools and dispatches
 * tools/call requests to the user's synaps rpc session via SessionRouter.
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
   * @param {object}   opts.sessionRouter   — has .getOrCreate({ synaps_user_id }) → Promise<SynapsRpc>
   * @param {number}   [opts.chatTimeoutMs=120_000]
   * @param {object}   [opts.logger=console]
   * @param {Function} [opts.now=Date.now]  — for tests
   */
  constructor({ sessionRouter, chatTimeoutMs = 120_000, logger = console, now = Date.now }) {
    if (!sessionRouter) throw new TypeError('McpToolRegistry: sessionRouter required');
    this._sessionRouter = sessionRouter;
    this._chatTimeoutMs = chatTimeoutMs;
    this._logger = logger;
    this._now = now;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * List all available tools. v0 returns the static [synaps_chat] descriptor.
   * Filtering by approval is the gate's responsibility.
   *
   * @param {object} _ctx  { synaps_user_id, institution_id }
   * @returns {Promise<Array>}
   */
  async listTools(_ctx) {
    return ALL_TOOL_DESCRIPTORS.slice();
  }

  /**
   * Invoke a tool by name. Returns the MCP-shape `{content, isError}` result.
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
    if (name !== SYNAPS_CHAT_TOOL_DESCRIPTOR.name) {
      throw new McpToolNotFoundError(name);
    }

    const v = validateArgs(args ?? {}, SYNAPS_CHAT_TOOL_DESCRIPTOR.inputSchema);
    if (!v.valid) {
      throw new McpToolInvalidArgsError(name, v.error);
    }

    return this._invokeChat({ args, synaps_user_id });
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
