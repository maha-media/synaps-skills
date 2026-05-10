/**
 * @file bridge/core/db/repositories/channel-identity-repo.js
 *
 * Repository class encapsulating all MongoDB queries for the
 * `synaps_channel_identities` collection.
 *
 * All methods are pure DB calls — no background work, no timers, no events.
 *
 * Spec reference: PLATFORM.SPEC.md § 3.2
 */

/**
 * @typedef {import('mongoose').Model} MongooseModel
 *
 * @typedef {Object} RepoOptions
 * @property {MongooseModel} model    - The SynapsChannelIdentity mongoose model.
 * @property {object}        [logger] - Logger with .info/.warn/.error; defaults to console.
 */

/**
 * Repository for synaps_channel_identity documents.
 */
export class ChannelIdentityRepo {
  /**
   * @param {RepoOptions} opts
   */
  constructor({ model, logger = console }) {
    this._model  = model;
    this._logger = logger;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Find a channel identity by its unique external key
   * `{ channel, external_id, external_team_id }`.
   *
   * @param {object} params
   * @param {string} params.channel
   * @param {string} params.external_id
   * @param {string} params.external_team_id
   * @returns {Promise<object|null>}
   */
  async findByExternal({ channel, external_id, external_team_id }) {
    return this._model.findOne({ channel, external_id, external_team_id }).lean();
  }

  /**
   * Return all channel identities belonging to a synaps user.
   *
   * @param {import('mongoose').Types.ObjectId|string} synapsUserId
   * @returns {Promise<object[]>}
   */
  async listByUser(synapsUserId) {
    return this._model.find({ synaps_user_id: synapsUserId }).lean();
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Insert a new channel identity document.
   *
   * @param {object} params
   * @param {import('mongoose').Types.ObjectId|string} params.synaps_user_id
   * @param {string} params.channel
   * @param {string} params.external_id
   * @param {string} params.external_team_id
   * @param {string} [params.display_name]
   * @param {string} [params.link_method]
   * @returns {Promise<object>} The created document.
   */
  async create({ synaps_user_id, channel, external_id, external_team_id, display_name, link_method } = {}) {
    const doc = await this._model.create({
      synaps_user_id,
      channel,
      external_id,
      external_team_id,
      linked_at: new Date(),
      ...(display_name !== undefined && { display_name }),
      ...(link_method  !== undefined && { link_method }),
    });
    this._logger.info(`[ChannelIdentityRepo] Created identity ${doc._id} channel=${channel}`);
    return doc;
  }

  /**
   * Upsert a channel identity by external key `{ channel, external_id, external_team_id }`.
   *
   * - On insert  : sets `synaps_user_id`, `link_method`, `display_name`, `linked_at`.
   * - On update  : refreshes `display_name` and `linked_at` only — never
   *               overwrites `synaps_user_id` or `link_method`.
   *
   * Implementation: 2-call read-then-write pattern (avoids Mongoose 8 rawResult
   * shape changes). Race-window between findOne and create is acceptable for
   * v0; on duplicate-key collision the unique index protects us.
   *
   * @param {object} params
   * @param {import('mongoose').Types.ObjectId|string} params.synaps_user_id
   * @param {string} params.channel
   * @param {string} params.external_id
   * @param {string} params.external_team_id
   * @param {string} [params.display_name]
   * @param {string} [params.link_method]
   * @returns {Promise<{ doc: object, isNew: boolean }>}
   */
  async upsertExternal({ synaps_user_id, channel, external_id, external_team_id, display_name, link_method } = {}) {
    const filter = { channel, external_id, external_team_id };
    const existing = await this._model.findOne(filter).lean();

    if (existing) {
      const set = { linked_at: new Date() };
      if (display_name !== undefined) set.display_name = display_name;
      const updated = await this._model
        .findOneAndUpdate(filter, { $set: set }, { new: true })
        .lean();
      this._logger.info(
        `[ChannelIdentityRepo] Updated identity ${updated._id} channel=${channel} isNew=false`,
      );
      return { doc: updated, isNew: false };
    }

    const created = await this._model.create({
      synaps_user_id,
      channel,
      external_id,
      external_team_id,
      linked_at: new Date(),
      ...(display_name !== undefined && { display_name }),
      ...(link_method  !== undefined && { link_method }),
    });
    const doc = created.toObject ? created.toObject() : created;
    this._logger.info(
      `[ChannelIdentityRepo] Inserted identity ${doc._id} channel=${channel} isNew=true`,
    );
    return { doc, isNew: true };
  }
}
