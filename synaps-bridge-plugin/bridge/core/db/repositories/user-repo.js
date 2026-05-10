/**
 * @file bridge/core/db/repositories/user-repo.js
 *
 * Repository class encapsulating all MongoDB queries for the
 * `synaps_users` collection.
 *
 * All methods are pure DB calls — no background work, no timers, no events.
 *
 * Spec reference: PLATFORM.SPEC.md § 3.2
 */

/**
 * @typedef {import('mongoose').Model} MongooseModel
 *
 * @typedef {Object} RepoOptions
 * @property {MongooseModel} model    - The SynapsUser mongoose model.
 * @property {object}        [logger] - Logger with .info/.warn/.error; defaults to console.
 */

/**
 * Repository for synaps_user documents.
 */
export class UserRepo {
  /**
   * @param {RepoOptions} opts
   */
  constructor({ model, logger = console }) {
    this._model  = model;
    this._logger = logger;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Insert a new synaps_user document.
   *
   * The `memory_namespace` is derived from the inserted document's `_id`
   * (`'u_' + doc._id.toHexString()`) and is written back in a second update so
   * it is always consistent with the stored `_id`.
   *
   * @param {object} params
   * @param {import('mongoose').Types.ObjectId|string} params.pria_user_id
   * @param {import('mongoose').Types.ObjectId|string} [params.institution_id]
   * @param {string}  [params.display_name]
   * @param {string}  [params.default_channel]
   * @returns {Promise<object>} The created document (with memory_namespace set).
   */
  async create({ pria_user_id, institution_id, display_name, default_channel } = {}) {
    // Step 1 — insert with a placeholder namespace so the required validator
    // doesn't fire before we know the _id.  We immediately overwrite it.
    const doc = await this._model.create({
      pria_user_id,
      ...(institution_id  !== undefined && { institution_id }),
      ...(display_name    !== undefined && { display_name }),
      ...(default_channel !== undefined && { default_channel }),
      memory_namespace: `u_${new this._model.base.Types.ObjectId().toHexString()}`, // temp
    });

    // Step 2 — update the namespace to `u_<actual _id>`.
    const memory_namespace = `u_${doc._id.toHexString()}`;
    const updated = await this._model
      .findByIdAndUpdate(doc._id, { $set: { memory_namespace } }, { new: true })
      .lean();

    this._logger.info(`[UserRepo] Created user ${doc._id} ns=${memory_namespace}`);
    return updated;
  }

  /**
   * Find a synaps_user by their external pria user ID.
   *
   * @param {import('mongoose').Types.ObjectId|string} priaUserId
   * @returns {Promise<object|null>}
   */
  async findByPriaUserId(priaUserId) {
    return this._model.findOne({ pria_user_id: priaUserId }).lean();
  }

  /**
   * Fetch a synaps_user by its `_id`.
   *
   * @param {import('mongoose').Types.ObjectId|string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    return this._model.findById(id).lean();
  }

  /**
   * Find-or-create pattern.
   *
   * Returns `{ doc, isNew: true }` if a new document was created, or
   * `{ doc, isNew: false }` if one already existed.
   *
   * Uses a two-step approach (find then create) to keep `memory_namespace`
   * consistent with the real `_id` even on first insert.
   *
   * @param {object} params
   * @param {import('mongoose').Types.ObjectId|string} params.pria_user_id
   * @param {import('mongoose').Types.ObjectId|string} [params.institution_id]
   * @param {string}  [params.display_name]
   * @param {string}  [params.default_channel]
   * @returns {Promise<{ doc: object, isNew: boolean }>}
   */
  async ensure({ pria_user_id, institution_id, display_name, default_channel } = {}) {
    const existing = await this.findByPriaUserId(pria_user_id);
    if (existing) {
      return { doc: existing, isNew: false };
    }

    const doc = await this.create({ pria_user_id, institution_id, display_name, default_channel });
    return { doc, isNew: true };
  }

  /**
   * Set (or update) the `workspace_id` for a synaps_user.
   *
   * @param {import('mongoose').Types.ObjectId|string} userId
   * @param {import('mongoose').Types.ObjectId|string} workspaceId
   * @returns {Promise<object|null>} The updated document, or null if not found.
   */
  async setWorkspaceId(userId, workspaceId) {
    const doc = await this._model
      .findByIdAndUpdate(userId, { $set: { workspace_id: workspaceId } }, { new: true })
      .lean();
    return doc;
  }
}
