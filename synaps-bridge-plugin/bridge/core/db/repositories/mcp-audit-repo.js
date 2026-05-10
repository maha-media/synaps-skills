/**
 * @file bridge/core/db/repositories/mcp-audit-repo.js
 *
 * Repository class encapsulating all MongoDB queries for the
 * `synaps_mcp_audit` collection.
 *
 * Design notes:
 *   - record() is "best-effort" — it swallows all errors so that an audit
 *     path never crashes an otherwise-healthy request.
 *   - recent() uses .lean() to return plain JS objects, omitting __v.
 *
 * Spec reference: Phase 7 brief § McpAuditRepo
 */

/**
 * @typedef {import('mongoose').Model} MongooseModel
 *
 * @typedef {Object} RepoOptions
 * @property {MongooseModel} model          - The SynapsMcpAudit mongoose model.
 * @property {object}        [clock=Date]   - Clock provider; defaults to Date.
 * @property {object}        [logger]       - Logger with .warn; optional.
 */

/**
 * Repository for synaps_mcp_audit documents.
 */
export class McpAuditRepo {
  /**
   * @param {RepoOptions} opts
   */
  constructor({ model, clock = Date, logger }) {
    this._model  = model;
    this._clock  = clock;
    this._logger = logger ?? null;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Record an audit entry.  Best-effort — never throws (returns void on error).
   *
   * ts is auto-filled from the injected clock when not supplied by the caller.
   *
   * @param {object} entry  Matches the synapsMcpAuditSchema shape.
   * @returns {Promise<void>}
   */
  async record(entry) {
    try {
      const data = {
        ts: new this._clock(),
        ...entry,
      };
      await this._model.create(data);
    } catch (err) {
      if (this._logger && typeof this._logger.warn === 'function') {
        this._logger.warn('[McpAuditRepo] record() swallowed error:', err);
      }
      // Intentionally swallowed — audit must not crash the caller.
    }
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Return recent audit entries, newest first.
   *
   * @param {object}  [q={}]
   * @param {string}  [q.synaps_user_id]  Filter by user ObjectId string.
   * @param {string}  [q.institution_id]  Filter by institution ObjectId string.
   * @param {number}  [q.limit=100]       Maximum number of entries to return.
   * @returns {Promise<Array<object>>}
   */
  async recent(q = {}) {
    const { synaps_user_id, institution_id, limit = 100 } = q;

    const filter = {};
    if (synaps_user_id != null) filter.synaps_user_id = synaps_user_id;
    if (institution_id  != null) filter.institution_id  = institution_id;

    return this._model
      .find(filter)
      .sort({ ts: -1 })
      .limit(limit)
      .select('-__v')
      .lean();
  }
}
