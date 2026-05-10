/**
 * @file bridge/core/mcp/mcp-rate-limiter.js
 *
 * Pure token-bucket rate limiter for the MCP `/mcp/v1` surface.
 *
 * Two independent dimensions are evaluated per request:
 *   • per-tokenHash  — keyed on the SHA-256 hash of the bearer token
 *   • per-IP         — keyed on the caller's remote address
 *
 * Both dimensions must allow the request (AND semantics).  When one or
 * both dimensions block, the return value carries the offending `scope`
 * and a `retryAfterMs` hint so callers can produce a proper `Retry-After`
 * HTTP header.
 *
 * No I/O, no Mongo, no HTTP — pure in-process logic.
 *
 * Spec reference: Phase 8 brief § Track 1 — Rate Limiting
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Prune buckets that have been at full capacity for at least this long. */
const IDLE_PRUNE_AGE_MS = 60_000;

/**
 * Run the prune pass every N successful `check()` invocations.
 * (Doesn't need to be exact — just bounds the Map size over time.)
 */
const PRUNE_INTERVAL = 200;

// ── McpRateLimiter ────────────────────────────────────────────────────────────

export class McpRateLimiter {
  /**
   * @param {object} opts
   * @param {{capacity: number, refillPerSec: number}} opts.perToken
   *   Bucket parameters for per-tokenHash limiting.
   * @param {{capacity: number, refillPerSec: number}} opts.perIp
   *   Bucket parameters for per-IP limiting.
   * @param {() => number} [opts.now]
   *   Injectable clock — returns current epoch-ms.  Defaults to `Date.now`.
   * @param {object} [opts.logger]
   *   Optional logger; must expose `.debug?.()`.  Defaults to no-op.
   */
  constructor({ perToken, perIp, now, logger } = {}) {
    if (!perToken || typeof perToken.capacity !== 'number' || typeof perToken.refillPerSec !== 'number') {
      throw new TypeError('McpRateLimiter: perToken must be { capacity, refillPerSec }');
    }
    if (!perIp || typeof perIp.capacity !== 'number' || typeof perIp.refillPerSec !== 'number') {
      throw new TypeError('McpRateLimiter: perIp must be { capacity, refillPerSec }');
    }

    this._perToken     = perToken;
    this._perIp        = perIp;
    this._now          = now ?? (() => Date.now());
    this._logger       = logger ?? null;

    /** @type {Map<string, {tokens: number, lastRefillMs: number}>} */
    this._tokenBuckets = new Map();

    /** @type {Map<string, {tokens: number, lastRefillMs: number}>} */
    this._ipBuckets    = new Map();

    /** Counter used to decide when to run the prune pass. */
    this._callCount    = 0;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Check whether a request is allowed under the rate limit.
   *
   * @param {object} req
   * @param {string|null|undefined} req.tokenHash  SHA-256 hex hash of the bearer token.
   * @param {string|null|undefined} req.ip         Remote IP address string.
   * @returns {{ allowed: boolean, retryAfterMs?: number, scope?: 'token'|'ip' }}
   */
  check({ tokenHash, ip } = {}) {
    const nowMs = this._now();

    // ── Evaluate each dimension ───────────────────────────────────────────

    const tokenResult = tokenHash
      ? this._checkBucket(this._tokenBuckets, tokenHash, this._perToken, nowMs)
      : { allowed: true };

    const ipResult = ip
      ? this._checkBucket(this._ipBuckets, ip, this._perIp, nowMs)
      : { allowed: true };

    // ── Consume tokens only when BOTH dimensions allow ─────────────────

    if (tokenResult.allowed && ipResult.allowed) {
      if (tokenHash) this._consumeToken(this._tokenBuckets, tokenHash);
      if (ip)        this._consumeToken(this._ipBuckets,    ip);

      this._maybePrune(nowMs);
      return { allowed: true };
    }

    // ── Blocked — prefer 'token' scope when both are blocked ───────────

    if (!tokenResult.allowed) {
      return {
        allowed:      false,
        scope:        'token',
        retryAfterMs: _retryAfterMs(this._perToken.refillPerSec),
      };
    }

    return {
      allowed:      false,
      scope:        'ip',
      retryAfterMs: _retryAfterMs(this._perIp.refillPerSec),
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Get or create a bucket, apply lazy refill, and return whether it has
   * at least one token available.
   *
   * Does NOT consume the token — consumption is deferred until both
   * dimensions have been checked (so we don't drain one dimension for a
   * request that the other dimension would block).
   *
   * @param {Map} store
   * @param {string} key
   * @param {{capacity: number, refillPerSec: number}} cfg
   * @param {number} nowMs
   * @returns {{ allowed: boolean }}
   * @private
   */
  _checkBucket(store, key, cfg, nowMs) {
    let bucket = store.get(key);

    if (!bucket) {
      // Lazy initialisation — bucket starts full.
      bucket = { tokens: cfg.capacity, lastRefillMs: nowMs };
      store.set(key, bucket);
    } else {
      // Lazy refill: add tokens proportional to elapsed time.
      const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1_000);
      const refill     = elapsedSec * cfg.refillPerSec;

      if (refill > 0) {
        bucket.tokens      = Math.min(cfg.capacity, bucket.tokens + refill);
        bucket.lastRefillMs = nowMs;
      }
    }

    return { allowed: bucket.tokens >= 1 };
  }

  /**
   * Consume exactly one token from the bucket identified by `key`.
   *
   * Precondition: `_checkBucket` returned `{ allowed: true }` for this key.
   *
   * @param {Map} store
   * @param {string} key
   * @private
   */
  _consumeToken(store, key) {
    const bucket = store.get(key);
    if (bucket) {
      bucket.tokens -= 1;
    }
  }

  /**
   * Periodically prune buckets that have been at full capacity for ≥ 60 s.
   * This bounds Map memory growth for long-running processes.
   *
   * @param {number} nowMs
   * @private
   */
  _maybePrune(nowMs) {
    this._callCount += 1;
    if (this._callCount % PRUNE_INTERVAL !== 0) return;

    _pruneStore(this._tokenBuckets, this._perToken.capacity, this._perToken.refillPerSec, nowMs);
    _pruneStore(this._ipBuckets,    this._perIp.capacity,    this._perIp.refillPerSec,    nowMs);

    this._logger?.debug?.('[McpRateLimiter] prune pass', {
      tokenBuckets: this._tokenBuckets.size,
      ipBuckets:    this._ipBuckets.size,
    });
  }
}

// ── Module-private utilities ──────────────────────────────────────────────────

/**
 * Remove entries from `store` that would be at full capacity right now
 * (accounting for pending lazy refill) AND that reached full capacity
 * at least `IDLE_PRUNE_AGE_MS` ago.
 *
 * "Reached full capacity at" is computed as:
 *   `lastRefillMs + (capacity - tokens) / refillPerSec * 1000`
 *
 * This is read-only — it does NOT mutate the bucket's stored fields.
 *
 * @param {Map<string, {tokens: number, lastRefillMs: number}>} store
 * @param {number} capacity
 * @param {number} refillPerSec
 * @param {number} nowMs
 */
function _pruneStore(store, capacity, refillPerSec, nowMs) {
  for (const [key, bucket] of store) {
    // How many tokens does this bucket effectively hold right now?
    const elapsedSec      = Math.max(0, (nowMs - bucket.lastRefillMs) / 1_000);
    const effectiveTokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);

    // Only prune if the bucket would currently be at full capacity.
    if (effectiveTokens < capacity) continue;

    // When did it reach full capacity?
    const tokensMissing = capacity - bucket.tokens;
    const secsToFull    = refillPerSec > 0 ? tokensMissing / refillPerSec : 0;
    const fullSinceMs   = bucket.lastRefillMs + secsToFull * 1_000;
    const idleSinceMs   = nowMs - fullSinceMs;

    if (idleSinceMs >= IDLE_PRUNE_AGE_MS) {
      store.delete(key);
    }
  }
}

/**
 * Compute the minimum wait time in milliseconds before one token refills.
 *
 * @param {number} refillPerSec
 * @returns {number}
 */
function _retryAfterMs(refillPerSec) {
  return Math.ceil((1 / refillPerSec) * 1_000);
}
