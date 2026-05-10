/**
 * bridge/core/mcp/mcp-tool-descriptors.js
 *
 * Frozen MCP tool descriptor constants for all tools Synaps exposes.
 * Also exports a minimal JSON-schema-ish validator for argument checking.
 */

// ─── Descriptors ─────────────────────────────────────────────────────────────

export const SYNAPS_CHAT_TOOL_DESCRIPTOR = Object.freeze({
  name: 'synaps_chat',
  description:
    'Send a prompt to your Synaps agent workspace and receive the response. ' +
    'The agent runs in your dedicated Linux container and has access to your tools, memory, and credentials.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({
      prompt: Object.freeze({
        type: 'string',
        description: 'The user prompt to send to the agent.',
      }),
      context: Object.freeze({
        type: 'string',
        description:
          'Optional additional context to prepend to the prompt (e.g. system instructions, current state).',
      }),
    }),
    required: Object.freeze(['prompt']),
    additionalProperties: false,
  }),
});

export const ALL_TOOL_DESCRIPTORS = Object.freeze([SYNAPS_CHAT_TOOL_DESCRIPTOR]);

// ─── Validator ────────────────────────────────────────────────────────────────

/**
 * Minimal JSON-schema-ish validator for v0. Only supports:
 *   - type: 'object', properties, required, additionalProperties
 *   - property type: 'string'
 *
 * Returns { valid: true } or { valid: false, error: '...' }.
 *
 * Out of scope: $ref, oneOf, format, enum.
 *
 * @param {unknown} args
 * @param {object}  inputSchema
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
export function validateArgs(args, inputSchema) {
  // Must be a plain, non-null object
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { valid: false, error: 'arguments must be a plain object' };
  }

  const { properties = {}, required = [], additionalProperties } = inputSchema;

  // Check required fields
  for (const key of required) {
    if (!(key in args)) {
      return { valid: false, error: `missing required property: "${key}"` };
    }
  }

  // Check additionalProperties: false
  if (additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in properties)) {
        return { valid: false, error: `unknown property: "${key}"` };
      }
    }
  }

  // Check property types for values that are present
  for (const [key, schema] of Object.entries(properties)) {
    if (key in args) {
      const val = args[key];
      if (schema.type === 'string' && typeof val !== 'string') {
        return { valid: false, error: `property "${key}" must be a string` };
      }
    }
  }

  return { valid: true };
}
