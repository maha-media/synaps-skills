/**
 * @file bridge/core/db/repositories/workspace-repo.js
 *
 * Repository class encapsulating all MongoDB queries for the
 * `synaps_workspaces` collection.
 *
 * All methods are pure DB calls — no background work, no timers, no events.
 *
 * Spec reference: PLATFORM.SPEC.md § 12.1
 */

/**
 * @typedef {import('mongoose').Model} MongooseModel
 *
 * @typedef {Object} RepoOptions
 * @property {MongooseModel} model   - The SynapsWorkspace mongoose model.
 * @property {object}        [logger] - Logger with .info/.warn/.error; defaults to console.
 */

/**
 * Repository for synaps_workspace documents.
 */
export class WorkspaceRepo {
  /**
   * @param {RepoOptions} opts
   */
  constructor({ model, logger = console }) {
    this._model  = model;
    this._logger = logger;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Insert a new workspace document.
   *
   * @param {object} params
   * @param {import('mongoose').Types.ObjectId|string} params.synaps_user_id
   * @param {string}  [params.image]
   * @param {object}  [params.resource_limits]
   * @returns {Promise<object>} The created Mongoose document.
   */
  async create({ synaps_user_id, image, resource_limits } = {}) {
    const doc = await this._model.create({
      synaps_user_id,
      ...(image            !== undefined && { image }),
      ...(resource_limits  !== undefined && { resource_limits }),
    });
    this._logger.info(`[WorkspaceRepo] Created workspace ${doc._id}`);
    return doc;
  }

  /**
   * Update the state of a workspace, optionally merging extra fields such as
   * `container_id`, `vnc_url`, or `rpc_socket`.
   *
   * @param {string|import('mongoose').Types.ObjectId} id
   * @param {string} state  - New state value.
   * @param {object} [extra={}] - Additional fields to merge into the document.
   * @returns {Promise<object|null>} The updated document, or null if not found.
   */
  async setState(id, state, extra = {}) {
    const doc = await this._model
      .findByIdAndUpdate(
        id,
        { $set: { state, ...extra } },
        { new: true, runValidators: true },
      )
      .lean();
    return doc;
  }

  /**
   * Update `last_heartbeat` to the current time for the given workspace.
   *
   * @param {string|import('mongoose').Types.ObjectId} id
   * @returns {Promise<void>}
   */
  async heartbeat(id) {
    await this._model.updateOne(
      { _id: id },
      { $set: { last_heartbeat: new Date() } },
    );
  }

  /**
   * Delete a workspace document by ID.
   *
   * @param {string|import('mongoose').Types.ObjectId} id
   * @returns {Promise<boolean>} True if a document was removed.
   */
  async delete(id) {
    const result = await this._model.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Fetch a workspace by its `_id`.
   *
   * @param {string|import('mongoose').Types.ObjectId} id
   * @returns {Promise<object|null>}
   */
  async byId(id) {
    return this._model.findById(id).lean();
  }

  /**
   * Fetch the most recent non-reaped workspace for a given user.
   *
   * @param {string|import('mongoose').Types.ObjectId} synaps_user_id
   * @returns {Promise<object|null>}
   */
  async byUserId(synaps_user_id) {
    return this._model
      .findOne({ synaps_user_id, state: { $ne: 'reaped' } })
      .sort({ created_at: -1 })
      .lean();
  }

  /**
   * Fetch a workspace by its Docker container ID.
   *
   * @param {string} container_id
   * @returns {Promise<object|null>}
   */
  async byContainerId(container_id) {
    return this._model.findOne({ container_id }).lean();
  }

  /**
   * Return all workspaces in the `running` state whose `last_heartbeat` is
   * older than `olderThanMs` milliseconds ago (or is null).
   *
   * @param {number} olderThanMs - Age threshold in milliseconds.
   * @returns {Promise<object[]>}
   */
  async listStaleHeartbeat(olderThanMs) {
    const threshold = new Date(Date.now() - olderThanMs);
    return this._model
      .find({
        state: 'running',
        $or: [
          { last_heartbeat: null },
          { last_heartbeat: { $lt: threshold } },
        ],
      })
      .lean();
  }
}
