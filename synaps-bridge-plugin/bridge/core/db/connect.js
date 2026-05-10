/**
 * @file bridge/core/db/connect.js
 *
 * Lazy Mongoose connection singleton.
 *
 * No top-level await. No I/O at import time.
 * The module only establishes a MongoDB connection when `getMongoose()` is
 * first called.
 *
 * Public API
 * ----------
 *   getMongoose(uri?, opts?)  – returns the singleton mongoose instance,
 *                               connecting on the first call.
 *   disconnect()              – closes the connection if open.
 *   isConnected()             – boolean.
 */

import mongoose from 'mongoose';

mongoose.set('strictQuery', true);

/** Default connection URI. */
const DEFAULT_URI = process.env.MONGODB_URI ?? 'mongodb://localhost/priadb';

/** Shared connection options (autoIndex off for production). */
const DEFAULT_CONNECT_OPTS = {
  serverSelectionTimeoutMS: 5000,
  autoIndex: false,
};

/** Tracks whether a connect() call is already in flight. */
let _connectPromise = null;

/**
 * @typedef {Object} ConnectOptions
 * @property {object} [logger]  - Object with .info/.warn/.error methods.
 *                                Defaults to console.
 * @property {string} [uri]     - MongoDB URI override.
 */

/**
 * Return the singleton mongoose instance, connecting on first call.
 *
 * Calling this multiple times is safe: subsequent calls return the same
 * mongoose instance once the first connection resolves.
 *
 * @param {string}         [uri]     - MongoDB connection URI.
 * @param {ConnectOptions} [opts={}] - Optional logger override.
 * @returns {Promise<import('mongoose').Mongoose>}
 */
export async function getMongoose(uri, opts = {}) {
  const log = opts.logger ?? console;
  const connectionUri = uri ?? DEFAULT_URI;

  // Already connected – return immediately.
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  // A connect() is already in flight; piggyback on it.
  if (_connectPromise) {
    await _connectPromise;
    return mongoose;
  }

  log.info(`[db/connect] Connecting to MongoDB: ${connectionUri}`);

  _connectPromise = mongoose
    .connect(connectionUri, DEFAULT_CONNECT_OPTS)
    .then(() => {
      log.info('[db/connect] MongoDB connected.');
    })
    .catch((err) => {
      log.error('[db/connect] MongoDB connection error:', err.message);
      _connectPromise = null; // allow retry
      throw err;
    });

  await _connectPromise;
  return mongoose;
}

/**
 * Close the active connection if one is open.
 *
 * After this call, `isConnected()` returns false and `getMongoose()` will
 * establish a fresh connection on the next invocation.
 *
 * @returns {Promise<void>}
 */
export async function disconnect() {
  _connectPromise = null;
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

/**
 * Returns true when the underlying mongoose connection is in the "connected"
 * state (readyState === 1).
 *
 * @returns {boolean}
 */
export function isConnected() {
  return mongoose.connection.readyState === 1;
}
