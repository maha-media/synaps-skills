/**
 * @file bridge/core/db/repositories/heartbeat-repo.js
 *
 * Repository class encapsulating all MongoDB queries for the
 * `synaps_heartbeat` collection.
 *
 * All methods are pure DB calls — no background work, no timers, no events.
 *
 * Spec reference: PLATFORM.SPEC.md § 9 (supervisor / heartbeats)
 */

/**
 * @typedef {import('mongoose').Model} MongooseModel
 *
 * @typedef {Object} HeartbeatRepoOptions
 * @property {MongooseModel}  Heartbeat          - The Heartbeat mongoose model.
 * @property {() => Date}     [now]              - Injectable clock; defaults to
 *                                                 `() => new Date()`.
 */

/**
 * Repository for synaps_heartbeat documents.
 *
 * Designed for dependency injection: pass a test-local `Heartbeat` model and a
 * deterministic `now` function to keep tests fast and predictable.
 */
export class HeartbeatRepo {
  /**
   * @param {HeartbeatRepoOptions} opts
   */
  constructor({ Heartbeat, now = () => new Date() }) {
    this._Heartbeat = Heartbeat;
    this._now       = now;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Upsert a heartbeat document identified by `{component, id}`.
   *
   * `ts` is always overwritten with the result of `now()` so that each call
   * advances the timestamp regardless of what was previously stored.
   *
   * @param {object}  params
   * @param {string}  params.component           - One of 'bridge'|'workspace'|'rpc'|'scp'.
   * @param {string}  params.id                  - Component-specific identifier.
   * @param {boolean} [params.healthy=true]      - Health flag.
   * @param {object}  [params.details={}]        - Free-form detail payload.
   * @returns {Promise<object>} The upserted document (after write).
   */
  async record({ component, id, healthy = true, details = {} }) {
    const ts = this._now();

    const doc = await this._Heartbeat.findOneAndUpdate(
      { component, id },
      { $set: { ts, healthy, details } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );

    return doc;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Return heartbeat documents whose `ts` is strictly older than
   * `(now() - olderThanMs)`.  A document whose ts equals the threshold
   * boundary exactly is NOT considered stale.
   *
   * @param {object}  params
   * @param {number}  params.olderThanMs         - Age threshold in milliseconds.
   * @param {string}  [params.component]         - If supplied, restrict results
   *                                               to this component only.
   * @returns {Promise<object[]>} Array of lean documents.
   */
  async findStale({ component, olderThanMs }) {
    const threshold = new Date(this._now().getTime() - olderThanMs);

    const filter = { ts: { $lt: threshold } };
    if (component !== undefined) {
      filter.component = component;
    }

    return this._Heartbeat.find(filter).lean();
  }

  /**
   * Return all heartbeat documents sorted by component (asc) then id (asc).
   *
   * @returns {Promise<object[]>} Array of lean documents.
   */
  async findAll() {
    return this._Heartbeat.find({}).sort({ component: 1, id: 1 }).lean();
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  /**
   * Delete the heartbeat document identified by `{component, id}`.
   *
   * @param {object} params
   * @param {string} params.component
   * @param {string} params.id
   * @returns {Promise<boolean>} `true` if a document was deleted; `false` otherwise.
   */
  async remove({ component, id }) {
    const result = await this._Heartbeat.deleteOne({ component, id });
    return result.deletedCount > 0;
  }
}
