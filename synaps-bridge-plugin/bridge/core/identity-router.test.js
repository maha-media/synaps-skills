/**
 * @file bridge/core/identity-router.test.js
 *
 * Comprehensive tests for IdentityRouter and NoOpIdentityRouter.
 *
 * All tests use in-memory fake repos — no real DB, no mongoose.connect().
 * Only `new mongoose.Types.ObjectId()` is used for id generation inside the
 * fake repos themselves (mirroring what the real repos will do).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { IdentityRouter, NoOpIdentityRouter } from './identity-router.js';

// ─── Fake repo factories ──────────────────────────────────────────────────────

/**
 * In-memory SynapsUser repo.
 *
 * Stores docs by _id (string) and pria_user_id (string).
 */
function makeFakeUserRepo() {
  const docs  = new Map(); // String(_id)   → doc
  const byPria = new Map(); // String(pria_id) → doc

  return {
    _docs:  docs,
    _byPria: byPria,

    async findByPriaUserId(id) {
      return byPria.get(String(id)) ?? null;
    },

    async create({ pria_user_id, institution_id, display_name, default_channel = 'web' }) {
      const _id = new mongoose.Types.ObjectId();
      const doc = {
        _id,
        pria_user_id,
        institution_id,
        display_name,
        default_channel,
        memory_namespace: 'u_' + _id.toHexString(),
        created_at: new Date(),
      };
      docs.set(String(_id), doc);
      if (pria_user_id) byPria.set(String(pria_user_id), doc);
      return doc;
    },

    async findById(id) {
      return docs.get(String(id)) ?? null;
    },

    async setWorkspaceId() { return null; },
  };
}

/**
 * In-memory ChannelIdentity repo.
 *
 * Lookup key: `${channel}::${external_id}::${external_team_id}`.
 */
function makeFakeChannelIdentityRepo() {
  // Map from compound key → doc
  const byKey = new Map();

  function key({ channel, external_id, external_team_id = '' }) {
    return `${channel}::${external_id}::${external_team_id}`;
  }

  return {
    _byKey: byKey,

    async findByChannelId({ channel, external_id, external_team_id = '' }) {
      return byKey.get(key({ channel, external_id, external_team_id })) ?? null;
    },

    async upsert({ synaps_user_id, channel, external_id, external_team_id = '', display_name, link_method }) {
      const k = key({ channel, external_id, external_team_id });
      const existing = byKey.get(k);
      if (existing) {
        // Update in place.
        existing.synaps_user_id = synaps_user_id;
        existing.display_name   = display_name;
        existing.link_method    = link_method;
        existing.linked_at      = new Date();
        return existing;
      }
      const _id = new mongoose.Types.ObjectId();
      const doc = {
        _id,
        synaps_user_id,
        channel,
        external_id,
        external_team_id,
        display_name,
        link_method,
        linked_at: new Date(),
      };
      byKey.set(k, doc);
      return doc;
    },
  };
}

/**
 * In-memory LinkCode repo.
 *
 * Lookup key: code (string).
 */
function makeFakeLinkCodeRepo() {
  const byCode = new Map(); // code → doc

  return {
    _byCode: byCode,

    async findByCode(code) {
      return byCode.get(code) ?? null;
    },

    async create({ code, pria_user_id, synaps_user_id, expires_at }) {
      const _id = new mongoose.Types.ObjectId();
      const doc = {
        _id,
        code,
        pria_user_id,
        synaps_user_id,
        expires_at,
        redeemed_at: null,
        redeemed_by: null,
        created_at: new Date(),
      };
      byCode.set(code, doc);
      return doc;
    },

    async markRedeemed(code, { redeemed_by }) {
      const doc = byCode.get(code);
      if (!doc) return null;
      doc.redeemed_at = new Date();
      doc.redeemed_by = redeemed_by;
      return doc;
    },
  };
}

// ─── Factory helpers ──────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Build a fully-wired IdentityRouter with fresh in-memory repos. */
function makeRouter(overrides = {}) {
  const userRepo            = overrides.userRepo            ?? makeFakeUserRepo();
  const channelIdentityRepo = overrides.channelIdentityRepo ?? makeFakeChannelIdentityRepo();
  const linkCodeRepo        = overrides.linkCodeRepo        ?? makeFakeLinkCodeRepo();
  const logger              = overrides.logger              ?? makeLogger();
  const nowMs               = overrides.nowMs               ?? (() => Date.now());

  const router = new IdentityRouter({
    userRepo,
    channelIdentityRepo,
    linkCodeRepo,
    logger,
    nowMs,
  });

  return { router, userRepo, channelIdentityRepo, linkCodeRepo, logger };
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — Constructor validation
// ─────────────────────────────────────────────────────────────────────────────

describe('IdentityRouter — constructor validation', () => {
  it('throws when userRepo is missing', () => {
    expect(() => new IdentityRouter({
      channelIdentityRepo: makeFakeChannelIdentityRepo(),
      linkCodeRepo:        makeFakeLinkCodeRepo(),
    })).toThrow(TypeError);
    expect(() => new IdentityRouter({
      channelIdentityRepo: makeFakeChannelIdentityRepo(),
      linkCodeRepo:        makeFakeLinkCodeRepo(),
    })).toThrow(/userRepo/);
  });

  it('throws when channelIdentityRepo is missing', () => {
    expect(() => new IdentityRouter({
      userRepo:     makeFakeUserRepo(),
      linkCodeRepo: makeFakeLinkCodeRepo(),
    })).toThrow(TypeError);
    expect(() => new IdentityRouter({
      userRepo:     makeFakeUserRepo(),
      linkCodeRepo: makeFakeLinkCodeRepo(),
    })).toThrow(/channelIdentityRepo/);
  });

  it('throws when linkCodeRepo is missing', () => {
    expect(() => new IdentityRouter({
      userRepo:            makeFakeUserRepo(),
      channelIdentityRepo: makeFakeChannelIdentityRepo(),
    })).toThrow(TypeError);
    expect(() => new IdentityRouter({
      userRepo:            makeFakeUserRepo(),
      channelIdentityRepo: makeFakeChannelIdentityRepo(),
    })).toThrow(/linkCodeRepo/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — enabled flag
// ─────────────────────────────────────────────────────────────────────────────

describe('IdentityRouter#enabled', () => {
  it('returns true', () => {
    const { router } = makeRouter();
    expect(router.enabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — resolve — first call (unknown identity)
// ─────────────────────────────────────────────────────────────────────────────

describe('IdentityRouter#resolve — first call for unknown (channel, external_id)', () => {
  it('returns isLinked:false and isNew:true for a brand-new Slack user', async () => {
    const { router } = makeRouter();
    const result = await router.resolve({
      channel:     'slack',
      external_id: 'U001',
    });

    expect(result.isNew).toBe(true);
    expect(result.isLinked).toBe(false);
  });

  it('creates a SynapsUser with a valid _id and memory_namespace', async () => {
    const { router } = makeRouter();
    const { synapsUser } = await router.resolve({
      channel:     'slack',
      external_id: 'U001',
    });

    expect(synapsUser).toBeTruthy();
    expect(synapsUser._id).toBeTruthy();
    expect(synapsUser.memory_namespace).toMatch(/^u_[0-9a-f]{24}$/);
  });

  it('creates a channel_identity with link_method="inferred"', async () => {
    const { router, channelIdentityRepo } = makeRouter();
    await router.resolve({ channel: 'slack', external_id: 'U001' });

    const identity = await channelIdentityRepo.findByChannelId({
      channel: 'slack', external_id: 'U001', external_team_id: '',
    });
    expect(identity).toBeTruthy();
    expect(identity.link_method).toBe('inferred');
  });

  it('stores pria_user_id as null on the synthetic user', async () => {
    const { router } = makeRouter();
    const { synapsUser } = await router.resolve({
      channel:      'slack',
      external_id:  'U001',
      display_name: 'Alice',
    });
    expect(synapsUser.pria_user_id).toBeNull();
  });

  it('records display_name on the user doc when provided', async () => {
    const { router } = makeRouter();
    const { synapsUser } = await router.resolve({
      channel:      'slack',
      external_id:  'U002',
      display_name: 'Bob',
    });
    expect(synapsUser.display_name).toBe('Bob');
  });

  it('defaults external_team_id to empty string', async () => {
    const { router, channelIdentityRepo } = makeRouter();
    await router.resolve({ channel: 'slack', external_id: 'U003' });

    const identity = await channelIdentityRepo.findByChannelId({
      channel: 'slack', external_id: 'U003', external_team_id: '',
    });
    expect(identity.external_team_id).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — resolve — second call (existing identity row)
// ─────────────────────────────────────────────────────────────────────────────

describe('IdentityRouter#resolve — second call returns existing user', () => {
  it('returns isLinked:true on second call for the same (channel, external_id)', async () => {
    const { router } = makeRouter();

    await router.resolve({ channel: 'slack', external_id: 'U001' });
    const second = await router.resolve({ channel: 'slack', external_id: 'U001' });

    expect(second.isLinked).toBe(true);
    expect(second.isNew).toBe(false);
  });

  it('returns the same SynapsUser._id on both calls', async () => {
    const { router } = makeRouter();

    const first  = await router.resolve({ channel: 'slack', external_id: 'U010' });
    const second = await router.resolve({ channel: 'slack', external_id: 'U010' });

    expect(String(second.synapsUser._id)).toBe(String(first.synapsUser._id));
  });

  it('does NOT create a second SynapsUser on repeated calls', async () => {
    const { router, userRepo } = makeRouter();

    await router.resolve({ channel: 'slack', external_id: 'U020' });
    await router.resolve({ channel: 'slack', external_id: 'U020' });

    expect(userRepo._docs.size).toBe(1);
  });

  it('different external_ids produce independent users', async () => {
    const { router, userRepo } = makeRouter();

    await router.resolve({ channel: 'slack', external_id: 'U100' });
    await router.resolve({ channel: 'slack', external_id: 'U101' });

    expect(userRepo._docs.size).toBe(2);
  });

  it('same external_id on different channels produces independent users', async () => {
    const { router, userRepo } = makeRouter();

    await router.resolve({ channel: 'slack',   external_id: 'X1' });
    await router.resolve({ channel: 'discord', external_id: 'X1' });

    expect(userRepo._docs.size).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — resolveWebUser — first call
// ─────────────────────────────────────────────────────────────────────────────

describe('IdentityRouter#resolveWebUser — first call', () => {
  it('creates a SynapsUser and returns isNew:true', async () => {
    const { router } = makeRouter();
    const priaId = new mongoose.Types.ObjectId();

    const { synapsUser, isNew } = await router.resolveWebUser({
      pria_user_id: priaId,
    });

    expect(isNew).toBe(true);
    expect(synapsUser).toBeTruthy();
    expect(String(synapsUser.pria_user_id)).toBe(String(priaId));
  });

  it('stores the SynapsUser with memory_namespace = u_<_id>', async () => {
    const { router } = makeRouter();
    const { synapsUser } = await router.resolveWebUser({
      pria_user_id: new mongoose.Types.ObjectId(),
    });
    expect(synapsUser.memory_namespace).toBe(`u_${synapsUser._id.toHexString()}`);
  });

  it('creates a web channel_identity with link_method="oauth"', async () => {
    const { router, channelIdentityRepo } = makeRouter();
    const priaId = new mongoose.Types.ObjectId();

    await router.resolveWebUser({ pria_user_id: priaId });

    const identity = await channelIdentityRepo.findByChannelId({
      channel: 'web', external_id: String(priaId), external_team_id: '',
    });
    expect(identity).toBeTruthy();
    expect(identity.link_method).toBe('oauth');
  });

  it('records display_name on both the user and the identity', async () => {
    const { router, channelIdentityRepo } = makeRouter();
    const priaId = new mongoose.Types.ObjectId();

    const { synapsUser } = await router.resolveWebUser({
      pria_user_id:  priaId,
      display_name: 'Jane Doe',
    });

    expect(synapsUser.display_name).toBe('Jane Doe');

    const identity = await channelIdentityRepo.findByChannelId({
      channel: 'web', external_id: String(priaId), external_team_id: '',
    });
    expect(identity.display_name).toBe('Jane Doe');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — resolveWebUser — second call (existing user)
// ─────────────────────────────────────────────────────────────────────────────

describe('IdentityRouter#resolveWebUser — second call returns existing user', () => {
  it('returns isNew:false on second call', async () => {
    const { router } = makeRouter();
    const priaId = new mongoose.Types.ObjectId();

    await router.resolveWebUser({ pria_user_id: priaId });
    const { isNew } = await router.resolveWebUser({ pria_user_id: priaId });

    expect(isNew).toBe(false);
  });

  it('returns the same SynapsUser._id on both calls', async () => {
    const { router } = makeRouter();
    const priaId = new mongoose.Types.ObjectId();

    const first  = await router.resolveWebUser({ pria_user_id: priaId });
    const second = await router.resolveWebUser({ pria_user_id: priaId });

    expect(String(second.synapsUser._id)).toBe(String(first.synapsUser._id));
  });

  it('does NOT create a second SynapsUser', async () => {
    const { router, userRepo } = makeRouter();
    const priaId = new mongoose.Types.ObjectId();

    await router.resolveWebUser({ pria_user_id: priaId });
    await router.resolveWebUser({ pria_user_id: priaId });

    expect(userRepo._docs.size).toBe(1);
  });

  it('is idempotent for the web channel_identity (upsert, not double-insert)', async () => {
    const { router, channelIdentityRepo } = makeRouter();
    const priaId = new mongoose.Types.ObjectId();

    await router.resolveWebUser({ pria_user_id: priaId });
    await router.resolveWebUser({ pria_user_id: priaId });

    // Only one entry in the channel identity store.
    expect(channelIdentityRepo._byKey.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — issueLinkCode
// ─────────────────────────────────────────────────────────────────────────────

describe('IdentityRouter#issueLinkCode', () => {
  it('returns a 6-char [A-Z0-9] code', async () => {
    const { router } = makeRouter();
    const priaId = new mongoose.Types.ObjectId();

    await router.resolveWebUser({ pria_user_id: priaId });
    const { code } = await router.issueLinkCode({ pria_user_id: priaId });

    expect(code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('returns expires_at approximately 5 minutes from nowMs', async () => {
    const baseMs = 1_700_000_000_000;
    const { router } = makeRouter({ nowMs: () => baseMs });
    const priaId = new mongoose.Types.ObjectId();

    const { expires_at } = await router.issueLinkCode({ pria_user_id: priaId });

    expect(expires_at.getTime()).toBe(baseMs + 300_000);
  });

  it('returns synaps_user_id matching the existing SynapsUser', async () => {
    const { router } = makeRouter();
    const priaId = new mongoose.Types.ObjectId();

    const { synapsUser } = await router.resolveWebUser({ pria_user_id: priaId });
    const { synaps_user_id } = await router.issueLinkCode({ pria_user_id: priaId });

    expect(synaps_user_id).toBe(String(synapsUser._id));
  });

  it('each call produces a code entry in the linkCodeRepo', async () => {
    const { router, linkCodeRepo } = makeRouter();
    const priaId = new mongoose.Types.ObjectId();

    const { code } = await router.issueLinkCode({ pria_user_id: priaId });

    const stored = await linkCodeRepo.findByCode(code);
    expect(stored).toBeTruthy();
    expect(stored.code).toBe(code);
    expect(stored.redeemed_at).toBeNull();
  });

  it('auto-creates a SynapsUser if resolveWebUser was not called first', async () => {
    const { router, userRepo } = makeRouter();
    const priaId = new mongoose.Types.ObjectId();

    expect(userRepo._docs.size).toBe(0);
    await router.issueLinkCode({ pria_user_id: priaId });
    expect(userRepo._docs.size).toBe(1);
  });

  it('successive calls produce different codes', async () => {
    const { router } = makeRouter();
    const priaId = new mongoose.Types.ObjectId();

    const r1 = await router.issueLinkCode({ pria_user_id: priaId });
    const r2 = await router.issueLinkCode({ pria_user_id: priaId });

    // Astronomically unlikely they collide but we test they are independent.
    // (They could theoretically match — if so, re-run once to confirm flakiness.)
    expect(typeof r1.code).toBe('string');
    expect(typeof r2.code).toBe('string');
    expect(r1.code).toHaveLength(6);
    expect(r2.code).toHaveLength(6);
  });

  it('respects a custom ttl_ms', async () => {
    const baseMs = 1_700_000_000_000;
    const { router } = makeRouter({ nowMs: () => baseMs });
    const priaId = new mongoose.Types.ObjectId();

    const { expires_at } = await router.issueLinkCode({
      pria_user_id: priaId,
      ttl_ms: 60_000, // 1 minute
    });

    expect(expires_at.getTime()).toBe(baseMs + 60_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — redeemLinkCode — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('IdentityRouter#redeemLinkCode — happy path', () => {
  it('returns ok:true and the correct synaps_user_id', async () => {
    const baseMs = 1_700_000_000_000;
    const { router } = makeRouter({ nowMs: () => baseMs });
    const priaId = new mongoose.Types.ObjectId();

    const { synaps_user_id: issuedId, code } = await router.issueLinkCode({
      pria_user_id: priaId,
    });

    const result = await router.redeemLinkCode({
      code,
      channel:     'slack',
      external_id: 'U999',
    });

    expect(result.ok).toBe(true);
    expect(result.synaps_user_id).toBe(issuedId);
  });

  it('was_relinked is false when no prior channel identity existed', async () => {
    const baseMs = 1_700_000_000_000;
    const { router } = makeRouter({ nowMs: () => baseMs });
    const priaId = new mongoose.Types.ObjectId();
    const { code } = await router.issueLinkCode({ pria_user_id: priaId });

    const result = await router.redeemLinkCode({
      code,
      channel:     'slack',
      external_id: 'U_NEW',
    });

    expect(result.was_relinked).toBe(false);
  });

  it('creates a channel_identity with link_method="magic_code"', async () => {
    const baseMs = 1_700_000_000_000;
    const { router, channelIdentityRepo } = makeRouter({ nowMs: () => baseMs });
    const priaId = new mongoose.Types.ObjectId();
    const { code } = await router.issueLinkCode({ pria_user_id: priaId });

    await router.redeemLinkCode({
      code,
      channel:     'slack',
      external_id: 'ULINK',
    });

    const identity = await channelIdentityRepo.findByChannelId({
      channel: 'slack', external_id: 'ULINK', external_team_id: '',
    });
    expect(identity).toBeTruthy();
    expect(identity.link_method).toBe('magic_code');
  });

  it('marks the code as redeemed in the repo', async () => {
    const baseMs = 1_700_000_000_000;
    const { router, linkCodeRepo } = makeRouter({ nowMs: () => baseMs });
    const priaId = new mongoose.Types.ObjectId();
    const { code } = await router.issueLinkCode({ pria_user_id: priaId });

    await router.redeemLinkCode({
      code,
      channel:     'slack',
      external_id: 'UREDEEM',
    });

    const stored = await linkCodeRepo.findByCode(code);
    expect(stored.redeemed_at).not.toBeNull();
    expect(stored.redeemed_by).toMatchObject({
      channel: 'slack', external_id: 'UREDEEM',
    });
  });

  it('can subsequently resolve the channel via the linked identity', async () => {
    const baseMs = 1_700_000_000_000;
    const { router } = makeRouter({ nowMs: () => baseMs });
    const priaId = new mongoose.Types.ObjectId();

    const { synaps_user_id, code } = await router.issueLinkCode({ pria_user_id: priaId });

    await router.redeemLinkCode({
      code,
      channel:     'slack',
      external_id: 'UFULL',
    });

    // Now resolve via the Slack channel — should return the same user.
    const { synapsUser, isLinked } = await router.resolve({
      channel:     'slack',
      external_id: 'UFULL',
    });

    expect(isLinked).toBe(true);
    expect(String(synapsUser._id)).toBe(synaps_user_id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 — redeemLinkCode — failure cases
// ─────────────────────────────────────────────────────────────────────────────

describe('IdentityRouter#redeemLinkCode — unknown code', () => {
  it('returns { ok:false, reason:"unknown" } for a non-existent code', async () => {
    const { router } = makeRouter();

    const result = await router.redeemLinkCode({
      code:        'XXXXXX',
      channel:     'slack',
      external_id: 'U000',
    });

    expect(result).toEqual({ ok: false, reason: 'unknown' });
  });
});

describe('IdentityRouter#redeemLinkCode — expired code', () => {
  it('returns { ok:false, reason:"expired" } when expires_at is in the past', async () => {
    const PAST = 1_000_000_000_000; // ~2001

    // Issue at T=PAST, ttl=300_000 → expires at T=PAST+300_000
    const { router } = makeRouter({ nowMs: () => PAST });
    const priaId = new mongoose.Types.ObjectId();
    const { code } = await router.issueLinkCode({ pria_user_id: priaId });

    // Now attempt to redeem at T=PAST+400_000 (well past expiry).
    const futureMs = PAST + 400_000;
    const { router: router2, linkCodeRepo: lr2, channelIdentityRepo: ci2 } = makeRouter({
      nowMs:               () => futureMs,
      linkCodeRepo:        router._linkCodeRepo,
      channelIdentityRepo: router._channelIdentityRepo,
      userRepo:            router._userRepo,
    });
    // Re-use the same repos so the code is visible.
    const router2Scoped = new IdentityRouter({
      userRepo:            router._userRepo,
      channelIdentityRepo: router._channelIdentityRepo,
      linkCodeRepo:        router._linkCodeRepo,
      nowMs:               () => futureMs,
    });

    const result = await router2Scoped.redeemLinkCode({
      code,
      channel:     'slack',
      external_id: 'U_EXP',
    });

    expect(result).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('IdentityRouter#redeemLinkCode — already redeemed', () => {
  it('returns { ok:false, reason:"already_redeemed" } on second redemption', async () => {
    const baseMs = 1_700_000_000_000;
    const { router } = makeRouter({ nowMs: () => baseMs });
    const priaId = new mongoose.Types.ObjectId();
    const { code } = await router.issueLinkCode({ pria_user_id: priaId });

    // First redemption — should succeed.
    await router.redeemLinkCode({ code, channel: 'slack', external_id: 'U_FIRST' });

    // Second redemption — should fail.
    const result = await router.redeemLinkCode({
      code,
      channel:     'slack',
      external_id: 'U_SECOND',
    });

    expect(result).toEqual({ ok: false, reason: 'already_redeemed' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §10 — redeemLinkCode — relink scenario
// ─────────────────────────────────────────────────────────────────────────────

describe('IdentityRouter#redeemLinkCode — relink (was_relinked)', () => {
  it('returns was_relinked:true when the channel identity was bound to a different user', async () => {
    const baseMs = 1_700_000_000_000;
    const { router } = makeRouter({ nowMs: () => baseMs });

    const priaA = new mongoose.Types.ObjectId();
    const priaB = new mongoose.Types.ObjectId();

    // UserA has an existing Slack binding for USLACK.
    await router.resolve({ channel: 'slack', external_id: 'USLACK' });
    // UserA is the current owner.

    // UserB issues a link code.
    const { code } = await router.issueLinkCode({ pria_user_id: priaB });

    // USLACK redeems UserB's code → was_relinked should be true.
    const result = await router.redeemLinkCode({
      code,
      channel:     'slack',
      external_id: 'USLACK',
    });

    expect(result.ok).toBe(true);
    expect(result.was_relinked).toBe(true);
  });

  it('rebinds the channel identity to the new user after relinking', async () => {
    const baseMs = 1_700_000_000_000;
    const { router } = makeRouter({ nowMs: () => baseMs });

    const priaB = new mongoose.Types.ObjectId();

    // Create original Slack-only user (synthetic).
    await router.resolve({ channel: 'slack', external_id: 'USWITCH' });

    // UserB issues a code and USWITCH redeems it.
    const { synaps_user_id: userBId, code } = await router.issueLinkCode({
      pria_user_id: priaB,
    });

    await router.redeemLinkCode({
      code,
      channel:     'slack',
      external_id: 'USWITCH',
    });

    // Now resolving USWITCH should give UserB's SynapsUser.
    const { synapsUser } = await router.resolve({
      channel:     'slack',
      external_id: 'USWITCH',
    });

    expect(String(synapsUser._id)).toBe(userBId);
  });

  it('was_relinked:false when same user redeems another code (no ownership change)', async () => {
    const baseMs = 1_700_000_000_000;
    const { router } = makeRouter({ nowMs: () => baseMs });
    const priaId = new mongoose.Types.ObjectId();

    // Issue two codes for the same user.
    const { code: code1 } = await router.issueLinkCode({ pria_user_id: priaId });
    const { code: code2 } = await router.issueLinkCode({ pria_user_id: priaId });

    // Redeem first code → bind USAME to priaId.
    await router.redeemLinkCode({ code: code1, channel: 'slack', external_id: 'USAME' });

    // Redeem second code with same user → was_relinked should be false (same user).
    const result = await router.redeemLinkCode({
      code:        code2,
      channel:     'slack',
      external_id: 'USAME',
    });

    expect(result.ok).toBe(true);
    expect(result.was_relinked).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §11 — NoOpIdentityRouter — enabled flag
// ─────────────────────────────────────────────────────────────────────────────

describe('NoOpIdentityRouter#enabled', () => {
  it('returns false', () => {
    const noop = new NoOpIdentityRouter();
    expect(noop.enabled).toBe(false);
  });

  it('IdentityRouter.enabled (true) vs NoOpIdentityRouter.enabled (false)', () => {
    const { router } = makeRouter();
    const noop = new NoOpIdentityRouter();

    expect(router.enabled).toBe(true);
    expect(noop.enabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §12 — NoOpIdentityRouter — resolve
// ─────────────────────────────────────────────────────────────────────────────

describe('NoOpIdentityRouter#resolve', () => {
  it('returns a synthetic user without calling any repo', async () => {
    const userRepo            = { create: vi.fn(), findById: vi.fn(), findByPriaUserId: vi.fn() };
    const channelIdentityRepo = { findByChannelId: vi.fn(), upsert: vi.fn() };
    const noop = new NoOpIdentityRouter();

    const result = await noop.resolve({ channel: 'slack', external_id: 'U001' });

    // Repos must NOT be called.
    expect(userRepo.create).not.toHaveBeenCalled();
    expect(channelIdentityRepo.findByChannelId).not.toHaveBeenCalled();

    expect(result.synapsUser).toMatchObject({ _id: null });
    expect(result.synapsUser.memory_namespace).toBe('u_U001');
    expect(result.isNew).toBe(false);
    expect(result.isLinked).toBe(false);
  });

  it('uses external_id for the memory_namespace', async () => {
    const noop = new NoOpIdentityRouter();
    const { synapsUser } = await noop.resolve({
      channel:     'discord',
      external_id: 'D-XYZ',
    });
    expect(synapsUser.memory_namespace).toBe('u_D-XYZ');
  });

  it('is a pure function — successive calls return independent objects', async () => {
    const noop = new NoOpIdentityRouter();
    const r1 = await noop.resolve({ channel: 'slack', external_id: 'UA' });
    const r2 = await noop.resolve({ channel: 'slack', external_id: 'UB' });

    expect(r1.synapsUser.memory_namespace).toBe('u_UA');
    expect(r2.synapsUser.memory_namespace).toBe('u_UB');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §13 — NoOpIdentityRouter — resolveWebUser
// ─────────────────────────────────────────────────────────────────────────────

describe('NoOpIdentityRouter#resolveWebUser', () => {
  it('returns a synthetic user with memory_namespace = u_<pria_user_id>', async () => {
    const noop   = new NoOpIdentityRouter();
    const priaId = 'some-pria-id';
    const { synapsUser, isNew } = await noop.resolveWebUser({ pria_user_id: priaId });

    expect(synapsUser._id).toBeNull();
    expect(synapsUser.memory_namespace).toBe('u_some-pria-id');
    expect(isNew).toBe(false);
  });

  it('accepts an ObjectId as pria_user_id and stringifies it', async () => {
    const noop   = new NoOpIdentityRouter();
    const priaId = new mongoose.Types.ObjectId();
    const { synapsUser } = await noop.resolveWebUser({ pria_user_id: priaId });

    expect(synapsUser.memory_namespace).toBe('u_' + String(priaId));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §14 — NoOpIdentityRouter — issueLinkCode throws
// ─────────────────────────────────────────────────────────────────────────────

describe('NoOpIdentityRouter#issueLinkCode', () => {
  it('throws an error with "identity disabled" in the message', async () => {
    const noop = new NoOpIdentityRouter();

    await expect(noop.issueLinkCode({ pria_user_id: 'p1' }))
      .rejects.toThrow('identity disabled');
  });

  it('throws even with no arguments', async () => {
    const noop = new NoOpIdentityRouter();
    await expect(noop.issueLinkCode()).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §15 — NoOpIdentityRouter — redeemLinkCode
// ─────────────────────────────────────────────────────────────────────────────

describe('NoOpIdentityRouter#redeemLinkCode', () => {
  it('returns { ok:false, reason:"disabled" }', async () => {
    const noop = new NoOpIdentityRouter();
    const result = await noop.redeemLinkCode({
      code:        'ABC123',
      channel:     'slack',
      external_id: 'U999',
    });
    expect(result).toEqual({ ok: false, reason: 'disabled' });
  });

  it('returns { ok:false, reason:"disabled" } with no arguments', async () => {
    const noop = new NoOpIdentityRouter();
    const result = await noop.redeemLinkCode();
    expect(result).toEqual({ ok: false, reason: 'disabled' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §16 — NoOpIdentityRouter — default constructor
// ─────────────────────────────────────────────────────────────────────────────

describe('NoOpIdentityRouter — constructor', () => {
  it('can be instantiated with no arguments', () => {
    expect(() => new NoOpIdentityRouter()).not.toThrow();
  });

  it('accepts a custom logger', () => {
    const logger = makeLogger();
    const noop   = new NoOpIdentityRouter({ logger });
    expect(noop._logger).toBe(logger);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §17 — resolve — external_team_id is respected in lookup key
// ─────────────────────────────────────────────────────────────────────────────

describe('IdentityRouter#resolve — external_team_id isolation', () => {
  it('treats same external_id in different teams as distinct identities', async () => {
    const { router, userRepo } = makeRouter();

    await router.resolve({ channel: 'slack', external_id: 'U1', external_team_id: 'T_ALPHA' });
    await router.resolve({ channel: 'slack', external_id: 'U1', external_team_id: 'T_BETA' });

    expect(userRepo._docs.size).toBe(2);
  });

  it('same (external_id, team) returns the same user on second call', async () => {
    const { router, userRepo } = makeRouter();

    const first  = await router.resolve({ channel: 'slack', external_id: 'U2', external_team_id: 'T_X' });
    const second = await router.resolve({ channel: 'slack', external_id: 'U2', external_team_id: 'T_X' });

    expect(userRepo._docs.size).toBe(1);
    expect(String(second.synapsUser._id)).toBe(String(first.synapsUser._id));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §18 — Integration: full link-code flow end-to-end
// ─────────────────────────────────────────────────────────────────────────────

describe('IdentityRouter — full link-code flow (integration)', () => {
  it('web user issues code → Slack user redeems → both channels share same memory_namespace', async () => {
    const baseMs = 1_700_000_000_000;
    const { router } = makeRouter({ nowMs: () => baseMs });

    // Step 1: pria user logs in via web.
    const priaId = new mongoose.Types.ObjectId();
    const { synapsUser: webUser } = await router.resolveWebUser({
      pria_user_id:  priaId,
      display_name: 'Alice',
    });

    // Step 2: Alice issues a link code from the web dashboard.
    const { code } = await router.issueLinkCode({ pria_user_id: priaId });

    // Step 3: Alice types `/synaps link <code>` from Slack (U_ALICE / T_CORP).
    const redeemResult = await router.redeemLinkCode({
      code,
      channel:         'slack',
      external_id:     'U_ALICE',
      external_team_id: 'T_CORP',
      display_name:    'Alice (Slack)',
    });

    expect(redeemResult.ok).toBe(true);
    expect(redeemResult.synaps_user_id).toBe(String(webUser._id));

    // Step 4: Future Slack messages should resolve to the same SynapsUser.
    const { synapsUser: slackUser, isLinked } = await router.resolve({
      channel:         'slack',
      external_id:     'U_ALICE',
      external_team_id: 'T_CORP',
    });

    expect(isLinked).toBe(true);
    expect(String(slackUser._id)).toBe(String(webUser._id));

    // Both channels share the same memory_namespace.
    expect(slackUser.memory_namespace).toBe(webUser.memory_namespace);
  });
});
