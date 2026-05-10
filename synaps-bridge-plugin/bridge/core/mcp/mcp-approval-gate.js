/**
 * @file bridge/core/mcp/mcp-approval-gate.js
 *
 * Gates which Synaps tools are exposed/callable per institution by reading the
 * SCP policy row from pria-ui-v22's `mcpservers` collection via McpServerRepo.
 *
 * Approval policy (Phase 7 v0):
 *
 *  • One row per institution identified by `name === policyName` (default
 *    "synaps-control-plane") is the SCP policy row.
 *  • No active row → deny-all.
 *  • `tool_configuration.enabled === false` → all tools pass the whitelist.
 *  • `tool_configuration.enabled === true`:
 *      – `allowed_tools` empty → all tools pass (empty = open).
 *      – `allowed_tools` non-empty → only listed tools pass.
 *  • `require_approval.enabled === false` → tool exposed.
 *  • `require_approval.enabled === true`:
 *      – tool in `skip_approval_tools` → exposed.
 *      – tool NOT in `skip_approval_tools` → blocked.
 *
 * Both checks must pass (AND semantics).
 */

export class McpApprovalGate {
  /**
   * @param {object} opts
   * @param {import('../db/repositories/mcp-server-repo.js').McpServerRepo} opts.mcpServerRepo
   * @param {string} [opts.policyName='synaps-control-plane']
   * @param {object} [opts.logger=console]
   */
  constructor({ mcpServerRepo, policyName = 'synaps-control-plane', logger = console } = {}) {
    if (!mcpServerRepo) throw new TypeError('McpApprovalGate: mcpServerRepo required');
    this._repo       = mcpServerRepo;
    this._policyName = policyName;
    this._logger     = logger;
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Filter a tool descriptor list to those allowed for the institution.
   *
   * Returns an empty array when:
   *  - `institution_id` is absent/falsy, or
   *  - no active policy row exists for the institution.
   *
   * @param {Array<{name: string, [k: string]: unknown}>} tools
   * @param {object} ctx
   * @param {string} ctx.institution_id
   * @returns {Promise<Array>}
   */
  async filterTools(tools, { institution_id } = {}) {
    if (!institution_id) return [];

    const policy = await this._repo.findActiveByName({
      institution_id,
      name: this._policyName,
    });

    if (!policy) {
      this._logger.warn(`[McpApprovalGate] No active policy "${this._policyName}" for institution ${institution_id} — deny-all`);
      return [];
    }

    return tools.filter(t => this._isAllowedByPolicy(t.name, policy));
  }

  /**
   * Check whether a single tool name is allowed for the institution.
   *
   * @param {string} toolName
   * @param {object} ctx
   * @param {string} ctx.institution_id
   * @returns {Promise<boolean>}
   */
  async isToolAllowed(toolName, { institution_id } = {}) {
    if (!institution_id) return false;

    const policy = await this._repo.findActiveByName({
      institution_id,
      name: this._policyName,
    });

    if (!policy) return false;

    return this._isAllowedByPolicy(toolName, policy);
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /**
   * Apply whitelist AND approval-gate checks against a policy document.
   *
   * @param {string} toolName
   * @param {object} policy  — raw mcpservers document
   * @returns {boolean}
   * @private
   */
  _isAllowedByPolicy(toolName, policy) {
    // 1. Whitelist check (tool_configuration)
    const tc    = policy.tool_configuration || {};
    if (tc.enabled === true) {
      const allow = tc.allowed_tools || [];
      if (allow.length > 0 && !allow.includes(toolName)) return false;
    }

    // 2. Approval gate check (require_approval)
    const ra   = policy.require_approval || {};
    if (ra.enabled === true) {
      const skip = ra.skip_approval_tools || [];
      if (!skip.includes(toolName)) return false;
    }

    return true;
  }
}
