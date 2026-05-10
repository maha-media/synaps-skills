/**
 * @file bridge/core/db/repositories/mcp-token-repo.js
 *
 * Repository class encapsulating all MongoDB queries for the
 * `synaps_mcp_tokens` collection.
 *
 * All methods are pure DB calls — no background work, no timers, no events.
 *
 * Spec reference: Phase 7 brief § Wave A1 — McpTokenRepo
 */

/**
 * @typedef {import('mongoose').Model} MongooseModel
 *
 * @typedef {Object} McpTokenRepoOptions
 * @property {MongooseModel} db      - The SynapsMcpToken mongoose model.
 * @property {object}        [clock] - Object with a `.now()` method; defaults to `Date`.
 *                                     Inject a frozen clock in tests.
 */

/**
 * Repository for synaps_mcp_token documents.
 *
 * The `clock` parameter is used for all "now" calculations so that tests
 * can inject a deterministic time without monkey-patching globals.
 */
export class McpTokenRepo {
  /**
   * @param {McpTokenRepoOptions} opts
   */
  constructor({ db, clock = Date }) {
    this._model = db;
    this._clock = clock;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Insert a new MCP token row.
   *
   * The caller is responsible for hashing the raw token with SHA-256 before
   * calling this method.  The raw token is never passed in or stored.
   *
   * @param {object}   input
   * @param {string}   input.token_hash      - SHA-256 hex digest, lowercase.
   * @param {string}   input.synaps_user_id
   * @param {string}   input.institution_id
   * @param {string}   input.name            - Human-readable label.
   * @param {Date}     [input.expires_at]    - Omit or pass null for no expiry.
   * @param {string[]} [input.scopes]        - Defaults to `['*']`.
   * @returns {Promise<{_id: import('mongoose').Types.ObjectId, name: string, expires_at: Date|null, created_at: Date}>}
   */
  async create({ token_hash, synaps_user_id, institution_id, name, expires_at = null, scopes }) {
    const payload = {
      token_hash,
      synaps_user_id,
      institution_id,
      name,
      expires_at,
    };
    if (scopes !== undefined) {
      payload.scopes = scopes;
    }

    const doc = await this._model.create(payload);

    // Return only safe fields — never expose token_hash to the caller.
    return {
      _id:        doc._id,
      name:       doc.name,
      expires_at: doc.expires_at,
      created_at: doc.created_at,
    };
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Find an active token by its SHA-256 hash.
   *
   * "Active" means: `revoked_at` is null AND (`expires_at` is null OR
   * `expires_at` is in the future relative to the injected clock).
   *
   * Does NOT update `last_used_at` — call `touch()` separately if needed.
   *
   * @param {string} token_hash - SHA-256 hex digest, lowercase.
   * @returns {Promise<{_id, synaps_user_id, institution_id, name, scopes}|null>}
   */
  async findActive(token_hash) {
    const now = new this._clock();

    const doc = await this._model
      .findOne({
        token_hash,
        revoked_at: null,
        $or: [
          { expires_at: null },
          { expires_at: { $gt: now } },
        ],
      })
      .select('_id synaps_user_id institution_id name scopes')
      .lean();

    return doc ?? null;
  }

  /**
   * Record that a token was used right now.
   *
   * Best-effort: errors are silently swallowed so that an audit update never
   * breaks the request path.  Safe to call on revoked tokens.
   *
   * @param {string} token_id - The `_id` of the token document (as a string or ObjectId).
   * @returns {Promise<void>}
   */
  async touch(token_id) {
    try {
      await this._model.findByIdAndUpdate(
        token_id,
        { $set: { last_used_at: new this._clock() } },
      );
    } catch {
      // best-effort — swallow
    }
  }

  /**
   * List tokens belonging to a user, institution, or both.
   *
   * Returned rows do NOT include `token_hash`.
   * Results are sorted by `created_at` descending (newest first).
   *
   * @param {object}  q
   * @param {string}  [q.synaps_user_id]  - Filter by user.
   * @param {string}  [q.institution_id]  - Filter by institution.
   * @returns {Promise<Array<{_id, name, last_used_at, expires_at, revoked_at, created_at}>>}
   */
  async list(q) {
    const filter = {};
    if (q.synaps_user_id != null) filter.synaps_user_id = q.synaps_user_id;
    if (q.institution_id  != null) filter.institution_id  = q.institution_id;

    const docs = await this._model
      .find(filter)
      .select('_id name last_used_at expires_at revoked_at created_at')
      .sort({ created_at: -1 })
      .lean();

    return docs;
  }

  /**
   * Revoke a token by setting `revoked_at` to now.
   *
   * Idempotent: if `revoked_at` is already set, the document is not modified.
   * Returns `{ ok: false }` when the token_id is not found.
   *
   * @param {string} token_id - The `_id` of the token document.
   * @returns {Promise<{ok: boolean}>}
   */
  async revoke(token_id) {
    const result = await this._model.findOneAndUpdate(
      { _id: token_id, revoked_at: null },
      { $set: { revoked_at: new this._clock() } },
      { new: false },
    ).lean();

    if (result == null) {
      // Either not found, or already revoked — determine which.
      const exists = await this._model.exists({ _id: token_id });
      if (!exists) return { ok: false };
      // Already revoked — idempotent no-op, still considered ok.
      return { ok: true };
    }

    return { ok: true };
  }
}
