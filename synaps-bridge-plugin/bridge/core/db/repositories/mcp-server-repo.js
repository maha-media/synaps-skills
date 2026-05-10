/**
 * @file bridge/core/db/repositories/mcp-server-repo.js
 *
 * Read-only adapter over pria-ui-v22's existing `mcpservers` collection.
 *
 * We are a READER only — pria-ui-v22 admin owns all writes.
 * We bypass Mongoose model registration and use the raw driver collection so
 * we are not coupled to pria's schema version.
 *
 * Collection name confirmed from:
 *   /home/jr/Projects/Praxis/pria-ui-v22/routes/models/mcpserver.js
 *   → mongoose.model('mcpserver', MCPServerSchema)
 *   Mongoose pluralises 'mcpserver' → 'mcpservers'
 */

import mongoose from 'mongoose';

/**
 * Read-only repository for pria's `mcpservers` collection.
 */
export class McpServerRepo {
  /**
   * @param {object} opts
   * @param {mongoose.Connection} opts.db          — pria's priadb connection
   * @param {string} [opts.collection='mcpservers'] — collection name; default confirmed from pria model
   */
  constructor({ db, collection = 'mcpservers' } = {}) {
    if (!db) throw new TypeError('McpServerRepo: db required');
    this._db   = db;
    // Access the raw MongoDB Collection — no schema coupling.
    this._coll = db.collection(collection);
  }

  /**
   * Find the SCP policy row for an institution by exact name match.
   *
   * Accepts `institution_id` as either a hex string or an ObjectId; internally
   * converts strings to ObjectId so the MongoDB query hits the indexed field type.
   *
   * @param {object} q
   * @param {string|mongoose.Types.ObjectId} q.institution_id
   * @param {string} q.name
   * @returns {Promise<object|null>}
   */
  async findActiveByName({ institution_id, name }) {
    const institutionOid =
      typeof institution_id === 'string'
        ? new mongoose.Types.ObjectId(institution_id)
        : institution_id;

    const row = await this._coll.findOne({
      institution: institutionOid,
      name,
      status: 'active',
    });

    return row ?? null;
  }
}
