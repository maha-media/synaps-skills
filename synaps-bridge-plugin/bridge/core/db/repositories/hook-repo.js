/**
 * @file bridge/core/db/repositories/hook-repo.js
 *
 * Repository class encapsulating all MongoDB queries for the `synaps_hook`
 * collection.
 *
 * All methods are pure DB calls — no background work, no timers, no events.
 *
 * Spec reference: PLATFORM.SPEC.md § 10.2 (HookBus) + Phase 6 brief § 6.1
 */

/**
 * @typedef {import('mongoose').Model} MongooseModel
 *
 * @typedef {Object} HookRepoOptions
 * @property {MongooseModel} Hook  - The Hook mongoose model.
 */

/**
 * Scope specificity ordering used by listByEvent.
 * Lower value = more specific = returned first.
 * user (0) > institution (1) > global (2)
 */
const SCOPE_ORDER = { user: 0, institution: 1, global: 2 };

/**
 * Repository for synaps_hook documents.
 *
 * Designed for dependency injection: pass a test-local `Hook` model to keep
 * tests fast and predictable.
 */
export class HookRepo {
  /**
   * @param {HookRepoOptions} opts
   */
  constructor({ Hook }) {
    this._Hook = Hook;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * Insert a new hook document.
   *
   * @param {object}  params
   * @param {object}  params.scope              – { type, id? }
   * @param {string}  params.event              – lifecycle event key
   * @param {object}  [params.matcher]          – optional sub-selectors
   * @param {object}  params.action             – { type, config }
   * @param {boolean} [params.enabled=true]     – initial enabled state
   * @returns {Promise<object>} Saved document.
   */
  async create({ scope, event, matcher = {}, action, enabled = true }) {
    const doc = await this._Hook.create({ scope, event, matcher, action, enabled });
    return doc;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Find a single hook by its _id.
   *
   * @param {string|import('mongoose').Types.ObjectId} id
   * @returns {Promise<object|null>} Lean document or null.
   */
  async findById(id) {
    return this._Hook.findById(id).lean();
  }

  /**
   * List hooks matching a given event (and optionally a scope), ordered by
   * scope specificity: user > institution > global.
   *
   * Only enabled hooks are returned.
   *
   * Scope matching:
   *   - If `scope` is supplied the result set includes hooks whose scope.type
   *     and scope.id match, PLUS institution-level hooks matching scope.institutionId,
   *     PLUS all global hooks.
   *   - If `scope` is omitted, all enabled hooks for the event are returned.
   *
   * @param {object}  params
   * @param {string}  params.event
   * @param {object}  [params.scope]                          – caller's scope context
   * @param {string}  [params.scope.userId]                   – user ObjectId string
   * @param {string}  [params.scope.institutionId]            – institution ObjectId string
   * @returns {Promise<object[]>} Lean documents ordered user > institution > global.
   */
  async listByEvent({ event, scope } = {}) {
    const filter = { event, enabled: true };

    if (scope) {
      const orClauses = [];

      if (scope.userId) {
        orClauses.push({ 'scope.type': 'user', 'scope.id': scope.userId });
      }
      if (scope.institutionId) {
        orClauses.push({ 'scope.type': 'institution', 'scope.id': scope.institutionId });
      }
      orClauses.push({ 'scope.type': 'global' });

      filter.$or = orClauses;
    }

    const hooks = await this._Hook.find(filter).lean();

    // Sort in-process: user first, institution second, global last.
    hooks.sort((a, b) => {
      const aOrd = SCOPE_ORDER[a.scope.type] ?? 99;
      const bOrd = SCOPE_ORDER[b.scope.type] ?? 99;
      return aOrd - bOrd;
    });

    return hooks;
  }

  /**
   * List all hooks, optionally filtered by enabled flag.
   *
   * @param {object}   [params]
   * @param {boolean}  [params.enabled]  – if supplied, filter by this value
   * @returns {Promise<object[]>} Lean documents.
   */
  async listAll({ enabled } = {}) {
    const filter = {};
    if (enabled !== undefined) {
      filter.enabled = enabled;
    }
    return this._Hook.find(filter).lean();
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Enable or disable a hook.
   *
   * @param {string|import('mongoose').Types.ObjectId} id
   * @param {boolean} enabled
   * @returns {Promise<object|null>} Updated lean document, or null if not found.
   */
  async setEnabled(id, enabled) {
    return this._Hook.findByIdAndUpdate(
      id,
      { $set: { enabled } },
      { new: true, runValidators: true },
    ).lean();
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  /**
   * Delete a hook by its _id.
   *
   * @param {string|import('mongoose').Types.ObjectId} id
   * @returns {Promise<boolean>} `true` if a document was deleted; `false` otherwise.
   */
  async remove(id) {
    const result = await this._Hook.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }
}
