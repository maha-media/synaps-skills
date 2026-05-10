/**
 * @file bridge/core/db/repositories/mcp-tool-acl-repo.js
 *
 * Repository class encapsulating all MongoDB queries for the
 * `synaps_mcp_tool_acls` collection.
 *
 * All methods are pure DB calls — no background work, no timers, no events.
 * Defence-in-depth expiry filtering is applied in code alongside the MongoDB
 * TTL index so that in-flight or freshly-inserted expired rows are also
 * excluded from effective lookups.
 *
 * Spec reference: Phase 9 brief § Track 4 — McpToolAclRepo
 */

/**
 * @typedef {import('mongoose').Model} MongooseModel
 *
 * @typedef {Object} McpToolAclRepoOptions
 * @property {MongooseModel} model           - The SynapsMcpToolAcl mongoose model.
 * @property {function}      [clock=Date.now] - Returns current epoch ms. Inject for tests.
 * @property {object}        [logger]         - Logger with .warn; optional.
 */

/**
 * Repository for synaps_mcp_tool_acls documents.
 *
 * The `clock` parameter is used for all "now" calculations so that tests
 * can inject a deterministic time without monkey-patching globals.
 */
export class McpToolAclRepo {
  /**
   * @param {McpToolAclRepoOptions} opts
   */
  constructor({ model, clock = Date.now, logger } = {}) {
    if (!model) throw new TypeError('McpToolAclRepo: model is required');
    this._model  = model;
    this._clock  = clock;
    this._logger = logger ?? null;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Upsert an ACL row identified by (synaps_user_id, tool_name).
   *
   * Creates the document if it does not exist; otherwise updates
   * policy, reason, and expires_at in place.
   *
   * @param {object}      input
   * @param {*}           input.synaps_user_id
   * @param {string}      input.tool_name
   * @param {'allow'|'deny'} input.policy
   * @param {string}      [input.reason='']
   * @param {Date|null}   [input.expires_at=null]
   * @returns {Promise<object>} The resulting document (plain JS object).
   */
  async upsert({ synaps_user_id, tool_name, policy, reason = '', expires_at = null }) {
    const filter = { synaps_user_id, tool_name };
    const update = {
      $set: { policy, reason, expires_at },
      $setOnInsert: { created_at: new Date(this._clock()) },
    };

    const doc = await this._model.findOneAndUpdate(filter, update, {
      upsert: true,
      new:    true,
    }).lean();

    return doc;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * List all ACL rows for a specific user, sorted by tool_name ascending.
   *
   * @param {object} q
   * @param {*}      q.synaps_user_id
   * @returns {Promise<Array<object>>}
   */
  async list({ synaps_user_id }) {
    return this._model
      .find({ synaps_user_id })
      .sort({ tool_name: 1 })
      .lean();
  }

  /**
   * List ALL ACL rows across all users, sorted by (synaps_user_id, tool_name).
   * Capped at 1000 for safety (admin/audit use).
   *
   * @returns {Promise<Array<object>>}
   */
  async listAll() {
    return this._model
      .find({})
      .sort({ synaps_user_id: 1, tool_name: 1 })
      .limit(1000)
      .lean();
  }

  /**
   * Find a specific ACL row by composite key (synaps_user_id, tool_name).
   * Returns null if not found.
   * Does NOT filter on expires_at (returns even if expired — caller decides).
   *
   * @param {object} q
   * @param {*}      q.synaps_user_id
   * @param {string} q.tool_name
   * @returns {Promise<object|null>}
   */
  async findByUserAndTool({ synaps_user_id, tool_name }) {
    const doc = await this._model
      .findOne({ synaps_user_id, tool_name })
      .lean();
    return doc ?? null;
  }

  /**
   * Find the effective ACL for (user, tool), honouring wildcard precedence
   * and skipping expired rows (defence in depth alongside TTL).
   *
   * Precedence:
   *   1. Exact (user, tool_name) if not expired
   *   2. Wildcard (user, '*') if not expired
   *   3. null (no effective ACL found)
   *
   * NOTE: this method returns the "most specific live doc" but does NOT apply
   * deny-wins semantics — that is the resolver's responsibility.
   *
   * @param {object} q
   * @param {*}      q.synaps_user_id
   * @param {string} q.tool_name
   * @returns {Promise<object|null>}
   */
  async findEffective({ synaps_user_id, tool_name }) {
    const now = this._clock();

    // Fetch exact and wildcard in parallel.
    const [exact, wildcard] = await Promise.all([
      tool_name !== '*'
        ? this._model.findOne({ synaps_user_id, tool_name }).lean()
        : null,
      this._model.findOne({ synaps_user_id, tool_name: '*' }).lean(),
    ]);

    const isLive = (doc) =>
      doc !== null &&
      (doc.expires_at === null || new Date(doc.expires_at).getTime() > now);

    if (isLive(exact))     return exact;
    if (isLive(wildcard))  return wildcard;
    return null;
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  /**
   * Remove the ACL row identified by (synaps_user_id, tool_name).
   *
   * Returns `{ deleted: true }` when a row was removed,
   * `{ deleted: false }` when no matching row existed.
   *
   * @param {object} q
   * @param {*}      q.synaps_user_id
   * @param {string} q.tool_name
   * @returns {Promise<{deleted: boolean}>}
   */
  async delete({ synaps_user_id, tool_name }) {
    const result = await this._model.findOneAndDelete({ synaps_user_id, tool_name });
    return { deleted: result !== null };
  }
}
