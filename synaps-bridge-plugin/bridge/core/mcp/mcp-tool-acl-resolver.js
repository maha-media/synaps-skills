/**
 * @file bridge/core/mcp/mcp-tool-acl-resolver.js
 *
 * Per-tool ACL resolver for the Synaps Control Plane.
 *
 * Sits between the McpApprovalGate and dispatch in the MCP request pipeline:
 *
 *   request → auth → rate-limit → approval-gate → ACL → dispatch
 *
 * Deny-wins / most-restrictive semantics (security default):
 *
 *   1. If wildcard (user, '*') is 'deny'  → DENY regardless of exact row.
 *   2. Else if exact (user, tool_name) exists → use it.
 *   3. Else if wildcard (user, '*') is 'allow' → ALLOW.
 *   4. Else no rows → fall-through ALLOW (default open, gate above handles it).
 *
 * Examples:
 *   (user, *, deny)  + (user, web_fetch, allow) → DENIED  (wildcard deny wins)
 *   (user, *, allow) + (user, web_fetch, deny)  → DENIED  (exact deny wins)
 *   (user, web_fetch, deny)  alone              → DENIED
 *   (user, web_fetch, allow) alone              → ALLOWED
 *   no rows for user                            → ALLOWED  source:'none'
 *
 * Caching:
 *   In-memory Map keyed "${userId}|${toolName}" with a per-entry fetchedAt
 *   timestamp.  Entries expire after `cacheMs` milliseconds (default 60 000).
 *   invalidate({ synaps_user_id, tool_name }) flushes one key.
 *   invalidate({ synaps_user_id, tool_name:'*' }) flushes ALL keys for that user
 *   (because a wildcard change affects every per-tool decision).
 *   invalidateAll() clears everything (admin / tests).
 *
 * Spec reference: Phase 9 brief § Track 4 — McpToolAclResolver
 */

/**
 * @typedef {'allow'|'deny'} Policy
 * @typedef {'exact'|'wildcard'|'none'} Source
 *
 * @typedef {Object} AclDecision
 * @property {boolean}  allowed
 * @property {string}   [reason]
 * @property {Policy}   [policy]
 * @property {Source}   source
 */

/**
 * @typedef {Object} McpToolAclResolverOptions
 * @property {import('../db/repositories/mcp-tool-acl-repo.js').McpToolAclRepo} repo
 * @property {object}   [logger]
 * @property {function} [clock=Date.now]  - Returns current epoch ms.
 * @property {number}   [cacheMs=60_000]  - Cache TTL in milliseconds.
 */

export class McpToolAclResolver {
  /**
   * @param {McpToolAclResolverOptions} opts
   */
  constructor({ repo, logger, clock = Date.now, cacheMs = 60_000 } = {}) {
    if (!repo) throw new TypeError('McpToolAclResolver: repo is required');

    this._repo    = repo;
    this._logger  = logger ?? null;
    this._clock   = clock;
    this._cacheMs = cacheMs;

    /** @type {Map<string, {decision: AclDecision, fetchedAt: number}>} */
    this._cache = new Map();
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Check whether a user may call a specific tool.
   *
   * @param {object} opts
   * @param {*}      opts.synaps_user_id
   * @param {string} opts.tool_name
   * @returns {Promise<AclDecision>}
   */
  async check({ synaps_user_id, tool_name }) {
    const cacheKey = `${synaps_user_id}|${tool_name}`;
    const now      = this._clock();

    // ── Cache hit ────────────────────────────────────────────────────────────
    const cached = this._cache.get(cacheKey);
    if (cached && now - cached.fetchedAt < this._cacheMs) {
      return cached.decision;
    }

    // ── Fetch exact + wildcard in parallel ───────────────────────────────────
    const [exact, wildcard] = await Promise.all([
      this._repo.findByUserAndTool({ synaps_user_id, tool_name }),
      this._repo.findByUserAndTool({ synaps_user_id, tool_name: '*' }),
    ]);

    // Filter out expired rows (defence in depth alongside TTL index).
    const isLive = (doc) =>
      doc !== null &&
      (doc.expires_at == null || new Date(doc.expires_at).getTime() > now);

    const liveExact    = isLive(exact)    ? exact    : null;
    const liveWildcard = isLive(wildcard) ? wildcard : null;

    // ── Apply deny-wins semantics ─────────────────────────────────────────────
    const decision = this._resolve(liveExact, liveWildcard);

    // ── Store in cache ───────────────────────────────────────────────────────
    this._cache.set(cacheKey, { decision, fetchedAt: now });

    return decision;
  }

  /**
   * Invalidate cached decisions for a specific user+tool pair.
   *
   * If tool_name is '*', ALL cache entries for that user are evicted because a
   * wildcard ACL change affects every per-tool decision for that user.
   *
   * @param {object} opts
   * @param {*}      opts.synaps_user_id
   * @param {string} opts.tool_name
   */
  invalidate({ synaps_user_id, tool_name }) {
    if (tool_name === '*') {
      // Flush everything for this user (wildcard affects all tools).
      const prefix = `${synaps_user_id}|`;
      for (const key of this._cache.keys()) {
        if (key.startsWith(prefix)) {
          this._cache.delete(key);
        }
      }
    } else {
      this._cache.delete(`${synaps_user_id}|${tool_name}`);
    }
  }

  /**
   * Flush the entire cache.  Intended for tests and admin operations.
   */
  invalidateAll() {
    this._cache.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /**
   * Apply deny-wins ACL semantics given the live exact and wildcard docs.
   *
   * Precedence rules (from the spec):
   *   1. Wildcard deny  → DENY  (source: 'wildcard')
   *   2. Exact present  → use exact policy  (source: 'exact')
   *   3. Wildcard allow → ALLOW  (source: 'wildcard')
   *   4. No rows        → ALLOW  (source: 'none')
   *
   * @param {object|null} exact
   * @param {object|null} wildcard
   * @returns {AclDecision}
   * @private
   */
  _resolve(exact, wildcard) {
    // Rule 1: wildcard deny trumps everything.
    if (wildcard !== null && wildcard.policy === 'deny') {
      return {
        allowed: false,
        policy:  'deny',
        reason:  wildcard.reason ?? '',
        source:  'wildcard',
      };
    }

    // Rule 2: exact row present (policy is either allow or deny).
    if (exact !== null) {
      return {
        allowed: exact.policy === 'allow',
        policy:  exact.policy,
        reason:  exact.reason ?? '',
        source:  'exact',
      };
    }

    // Rule 3: wildcard allow (deny case already handled above).
    if (wildcard !== null) {
      return {
        allowed: true,
        policy:  'allow',
        reason:  wildcard.reason ?? '',
        source:  'wildcard',
      };
    }

    // Rule 4: no rows at all — fall through to default allow.
    return {
      allowed: true,
      source:  'none',
    };
  }
}
