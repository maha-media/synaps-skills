/**
 * @file bridge/core/mcp/mcp-tool-acl-resolver.test.js
 *
 * Unit tests for McpToolAclResolver.
 *
 * Uses an in-memory stub repo (no MongoDB connection required) so that all
 * 12 test cases run in milliseconds with full clock control.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { McpToolAclResolver } from './mcp-tool-acl-resolver.js';

// ── Stub repo factory ─────────────────────────────────────────────────────────

/**
 * Build a stub repo whose findByUserAndTool returns values from a plain map.
 *
 * aclMap: { [`${userId}|${toolName}`]: { policy, reason, expires_at } }
 */
function makeStubRepo(aclMap = {}) {
  return {
    async findByUserAndTool({ synaps_user_id, tool_name }) {
      const key = `${synaps_user_id}|${tool_name}`;
      const row = aclMap[key];
      if (!row) return null;
      return {
        synaps_user_id,
        tool_name,
        policy:     row.policy,
        reason:     row.reason ?? '',
        expires_at: row.expires_at ?? null,
      };
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const userId = new mongoose.Types.ObjectId();

function makeResolver({ aclMap = {}, clock = Date.now, cacheMs = 60_000 } = {}) {
  return new McpToolAclResolver({
    repo:    makeStubRepo(aclMap),
    clock,
    cacheMs,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('McpToolAclResolver.check() — fall-through', () => {
  it('1. returns {allowed:true, source:"none"} when no rows exist', async () => {
    const resolver = makeResolver();
    const result   = await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });

    expect(result.allowed).toBe(true);
    expect(result.source).toBe('none');
  });
});

describe('McpToolAclResolver.check() — exact rows', () => {
  it('2. exact allow → allowed, source:"exact"', async () => {
    const resolver = makeResolver({
      aclMap: { [`${userId}|web_fetch`]: { policy: 'allow', reason: 'ok' } },
    });

    const result = await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });

    expect(result.allowed).toBe(true);
    expect(result.policy).toBe('allow');
    expect(result.source).toBe('exact');
  });

  it('3. exact deny → denied, reason propagated, source:"exact"', async () => {
    const resolver = makeResolver({
      aclMap: { [`${userId}|web_fetch`]: { policy: 'deny', reason: 'blocked by admin' } },
    });

    const result = await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });

    expect(result.allowed).toBe(false);
    expect(result.policy).toBe('deny');
    expect(result.reason).toBe('blocked by admin');
    expect(result.source).toBe('exact');
  });
});

describe('McpToolAclResolver.check() — wildcard rows', () => {
  it('4. wildcard allow only → allowed, source:"wildcard"', async () => {
    const resolver = makeResolver({
      aclMap: { [`${userId}|*`]: { policy: 'allow', reason: 'open' } },
    });

    const result = await resolver.check({ synaps_user_id: userId, tool_name: 'any_tool' });

    expect(result.allowed).toBe(true);
    expect(result.policy).toBe('allow');
    expect(result.source).toBe('wildcard');
  });

  it('5. wildcard deny only → denied, source:"wildcard"', async () => {
    const resolver = makeResolver({
      aclMap: { [`${userId}|*`]: { policy: 'deny', reason: 'lockdown' } },
    });

    const result = await resolver.check({ synaps_user_id: userId, tool_name: 'any_tool' });

    expect(result.allowed).toBe(false);
    expect(result.policy).toBe('deny');
    expect(result.reason).toBe('lockdown');
    expect(result.source).toBe('wildcard');
  });
});

describe('McpToolAclResolver.check() — security default (deny wins)', () => {
  it('6. wildcard deny + exact allow → DENIED (wildcard deny wins)', async () => {
    const resolver = makeResolver({
      aclMap: {
        [`${userId}|*`]:         { policy: 'deny',  reason: 'global lockdown' },
        [`${userId}|web_fetch`]: { policy: 'allow', reason: 'try to override' },
      },
    });

    const result = await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });

    expect(result.allowed).toBe(false);
    expect(result.source).toBe('wildcard');
  });

  it('7. wildcard allow + exact deny → DENIED (exact deny wins)', async () => {
    const resolver = makeResolver({
      aclMap: {
        [`${userId}|*`]:         { policy: 'allow', reason: 'generally allowed' },
        [`${userId}|web_fetch`]: { policy: 'deny',  reason: 'specifically banned' },
      },
    });

    const result = await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });

    expect(result.allowed).toBe(false);
    expect(result.source).toBe('exact');
    expect(result.reason).toBe('specifically banned');
  });
});

describe('McpToolAclResolver — caching', () => {
  it('8. cache hit: repo is not called again within cacheMs', async () => {
    const findByUserAndTool = vi.fn().mockResolvedValue(null);
    const resolver = new McpToolAclResolver({
      repo:    { findByUserAndTool },
      cacheMs: 60_000,
    });

    await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });
    await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });

    // findByUserAndTool is called twice per check (exact + wildcard) but
    // only on the first check — second call must be fully cached.
    expect(findByUserAndTool).toHaveBeenCalledTimes(2); // 2 lookups for 1st check only
  });

  it('9. cache miss after clock advances past cacheMs', async () => {
    let now = 1_000_000;
    const clock = () => now;

    const findByUserAndTool = vi.fn().mockResolvedValue(null);
    const resolver = new McpToolAclResolver({
      repo:    { findByUserAndTool },
      clock,
      cacheMs: 60_000,
    });

    // First check — populates cache at t=1_000_000
    await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });

    // Advance clock past cacheMs
    now = 1_000_000 + 60_001;

    // Second check — cache is stale, should re-fetch
    await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });

    // 2 lookups per check × 2 checks = 4 total
    expect(findByUserAndTool).toHaveBeenCalledTimes(4);
  });
});

describe('McpToolAclResolver — cache invalidation', () => {
  it('10. invalidate({user, tool}) flushes only that entry', async () => {
    const findByUserAndTool = vi.fn().mockResolvedValue(null);
    const resolver = new McpToolAclResolver({ repo: { findByUserAndTool }, cacheMs: 60_000 });

    // Warm up two different tool entries
    await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });
    await resolver.check({ synaps_user_id: userId, tool_name: 'synaps_chat' });

    const callsAfterWarmup = findByUserAndTool.mock.calls.length; // 4

    // Invalidate only web_fetch
    resolver.invalidate({ synaps_user_id: userId, tool_name: 'web_fetch' });

    // Re-check both
    await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });   // cache miss → 2 new calls
    await resolver.check({ synaps_user_id: userId, tool_name: 'synaps_chat' }); // cache hit  → 0 new calls

    expect(findByUserAndTool.mock.calls.length).toBe(callsAfterWarmup + 2);
  });

  it('11. invalidate({user, "*"}) flushes ALL entries for that user', async () => {
    const user2                 = new mongoose.Types.ObjectId();
    const findByUserAndTool     = vi.fn().mockResolvedValue(null);
    const resolver = new McpToolAclResolver({ repo: { findByUserAndTool }, cacheMs: 60_000 });

    // Warm up entries for userId and user2
    await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });
    await resolver.check({ synaps_user_id: userId, tool_name: 'synaps_chat' });
    await resolver.check({ synaps_user_id: user2,  tool_name: 'web_fetch' });

    const callsAfterWarmup = findByUserAndTool.mock.calls.length; // 6

    // Invalidate all entries for userId via wildcard
    resolver.invalidate({ synaps_user_id: userId, tool_name: '*' });

    // userId entries are stale — both re-fetch (2 lookups each = 4 new calls)
    await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });
    await resolver.check({ synaps_user_id: userId, tool_name: 'synaps_chat' });
    // user2 entry is still cached — no extra calls
    await resolver.check({ synaps_user_id: user2,  tool_name: 'web_fetch' });

    expect(findByUserAndTool.mock.calls.length).toBe(callsAfterWarmup + 4);
  });

  it('12. invalidateAll() flushes everything', async () => {
    const findByUserAndTool = vi.fn().mockResolvedValue(null);
    const resolver = new McpToolAclResolver({ repo: { findByUserAndTool }, cacheMs: 60_000 });

    await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });
    await resolver.check({ synaps_user_id: userId, tool_name: 'synaps_chat' });

    const callsAfterWarmup = findByUserAndTool.mock.calls.length; // 4

    resolver.invalidateAll();

    // Both re-fetch
    await resolver.check({ synaps_user_id: userId, tool_name: 'web_fetch' });
    await resolver.check({ synaps_user_id: userId, tool_name: 'synaps_chat' });

    expect(findByUserAndTool.mock.calls.length).toBe(callsAfterWarmup + 4);
  });
});
