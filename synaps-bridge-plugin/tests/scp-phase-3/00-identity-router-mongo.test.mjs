/**
 * @file tests/scp-phase-3/00-identity-router-mongo.test.mjs
 *
 * Acceptance tests for IdentityRouter wired to a real mongo-memory-server.
 *
 * Strategy
 * ────────
 * • MongoMemoryServer spins up an in-process MongoDB instance in beforeAll.
 * • We use a private mongoose.Mongoose() to avoid polluting the global
 *   singleton used by other test files.
 * • Models are built via the production model factories.
 * • Repos are wrapped in thin adapter objects that bridge the interface
 *   expected by IdentityRouter (findByChannelId / upsert / findByCode /
 *   create / markRedeemed) to the production repo method names
 *   (findByExternal / upsertExternal / findActiveByCode / issue / redeem).
 * • IdentityRouter receives injected repos — no global mongoose state touched.
 *
 * Scenarios (~10 tests)
 * ─────────────────────
 * 1. resolve (Slack, new)  → creates SynapsUser + 'inferred' identity
 * 2. resolve (Slack, same) → idempotent — returns same SynapsUser
 * 3. resolve (different external_team_id, same external_id) → DIFFERENT user
 * 4. resolveWebUser (first call) → creates SynapsUser + 'web' identity
 * 5. resolveWebUser (second call) → same SynapsUser (idempotent)
 * 6. issueLinkCode → real doc appears in synaps_link_codes
 * 7. redeemLinkCode happy path → channel_identity created in collection
 * 8. redeemLinkCode expired → reason: expired
 * 9. redeemLinkCode already_redeemed → second call → reason: already_redeemed
 * 10. Cross-channel reconciliation → Slack resolve after redeem returns same
 *     memory_namespace as web user
 *
 * Constraints
 * ───────────
 * • ESM only (.mjs)
 * • vitest pool: vmThreads (already configured)
 * • beforeAll timeout ≥ 60_000 (mongo-memory-server pattern)
 * • No top-level await
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { getSynapsChannelIdentityModel }  from '../../bridge/core/db/models/synaps-channel-identity.js';
import { getSynapsLinkCodeModel }         from '../../bridge/core/db/models/synaps-link-code.js';
import { UserRepo }                       from '../../bridge/core/db/repositories/user-repo.js';
import { ChannelIdentityRepo }            from '../../bridge/core/db/repositories/channel-identity-repo.js';
import { LinkCodeRepo }                   from '../../bridge/core/db/repositories/link-code-repo.js';
import { IdentityRouter }                 from '../../bridge/core/identity-router.js';

// ─── Test-local SynapsUser schema ────────────────────────────────────────────
//
// The production SynapsUser schema marks pria_user_id as required.
// For Slack synthetic users (IdentityRouter.resolve() creating a user for a
// Slack-only user who hasn't linked their pria account), pria_user_id is null.
// We use a looser test schema that matches the real production intent
// (nullable pria_user_id for synthetic/inferred users).
//
// The web-user and link-code tests use the stricter pria_user_id form, so only
// these resolve() tests require the relaxed schema.

function buildLooseSynapsUserSchema(m) {
  const { Schema } = m;
  const s = new Schema(
    {
      pria_user_id:     { type: Schema.Types.ObjectId, default: null },
      institution_id:   { type: Schema.Types.ObjectId },
      display_name:     String,
      workspace_id:     Schema.Types.ObjectId,
      memory_namespace: { type: String, required: true },
      default_channel:  { type: String, default: 'web' },
    },
    {
      collection: 'synaps_users',
      timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    },
  );
  return s;
}

function getSynapsUserModelLoose(m) {
  if (m.models && m.models.SynapsUser) return m.models.SynapsUser;
  return m.model('SynapsUser', buildLooseSynapsUserSchema(m));
}

// ─── Module-level fixtures ───────────────────────────────────────────────────

let mongod;
let m;   // Private mongoose.Mongoose instance
let UserModel, CIModel, LCModel;
let userRepo, channelIdentityRepo, linkCodeRepo;
let router;

/** Silent logger – keeps test output clean. */
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// ─── Adapter builders ────────────────────────────────────────────────────────
//
// IdentityRouter calls:
//   channelIdentityRepo.findByChannelId({ channel, external_id, external_team_id })
//   channelIdentityRepo.upsert({ synaps_user_id, channel, external_id, external_team_id, display_name, link_method })
//   linkCodeRepo.findByCode(code) → raw doc with code/redeemed_at/expires_at/synaps_user_id
//   linkCodeRepo.create({ code, pria_user_id, synaps_user_id, expires_at })
//   linkCodeRepo.markRedeemed(code, { redeemed_by })
//
// Real repos expose different method names; these thin wrappers reconcile.

function makeChannelIdentityAdapter(repo) {
  return {
    async findByChannelId({ channel, external_id, external_team_id }) {
      return repo.findByExternal({ channel, external_id, external_team_id });
    },
    async upsert({ synaps_user_id, channel, external_id, external_team_id, display_name, link_method }) {
      return repo.upsertExternal({ synaps_user_id, channel, external_id, external_team_id, display_name, link_method });
    },
  };
}

function makeLinkCodeAdapter(repo, Model) {
  return {
    async findByCode(code) {
      // Return any doc (including expired/redeemed) – IdentityRouter checks fields itself.
      return Model.findOne({ code }).lean();
    },
    async create({ code, pria_user_id, synaps_user_id, expires_at }) {
      const doc = await Model.create({ code, pria_user_id, synaps_user_id, expires_at });
      return doc.toObject ? doc.toObject() : doc;
    },
    async markRedeemed(code, { redeemed_by }) {
      await Model.findOneAndUpdate(
        { code },
        { $set: { redeemed_at: new Date(), redeemed_by } },
      ).lean();
    },
  };
}

// ─── beforeAll / afterAll ────────────────────────────────────────────────────

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), { serverSelectionTimeoutMS: 5000, autoIndex: true });

  // Use the looser user model so resolve() can create synthetic Slack users
  // with null pria_user_id (the prod schema is stricter; this models the
  // intended real-world requirement for synthetic channel users).
  UserModel  = getSynapsUserModelLoose(m);
  CIModel    = getSynapsChannelIdentityModel(m);
  LCModel    = getSynapsLinkCodeModel(m);

  userRepo           = new UserRepo({ model: UserModel, logger: silent });
  channelIdentityRepo = new ChannelIdentityRepo({ model: CIModel, logger: silent });
  linkCodeRepo       = new LinkCodeRepo({ model: LCModel, logger: silent });

  router = new IdentityRouter({
    userRepo,
    channelIdentityRepo: makeChannelIdentityAdapter(channelIdentityRepo),
    linkCodeRepo: makeLinkCodeAdapter(linkCodeRepo, LCModel),
    logger: silent,
  });
}, 60_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  // Clear all collections between tests to keep state isolated.
  await UserModel.deleteMany({});
  await CIModel.deleteMany({});
  await LCModel.deleteMany({});
});

// ─── 1. resolve — new slack user creates SynapsUser + identity ───────────────

describe('IdentityRouter.resolve() with live Mongo', () => {
  it('creates a SynapsUser and inferred identity on first call', async () => {
    const { synapsUser, isNew, isLinked } = await router.resolve({
      channel: 'slack',
      external_id: 'U001',
      external_team_id: 'T001',
      display_name: 'Alice',
    });

    expect(isNew).toBe(true);
    expect(isLinked).toBe(false);
    expect(synapsUser._id).toBeDefined();
    expect(synapsUser.memory_namespace).toBe(`u_${String(synapsUser._id)}`);

    // Verify the channel_identity row actually landed in MongoDB.
    const ci = await CIModel.findOne({
      channel: 'slack',
      external_id: 'U001',
      external_team_id: 'T001',
    }).lean();
    expect(ci).not.toBeNull();
    expect(String(ci.synaps_user_id)).toBe(String(synapsUser._id));
    expect(ci.link_method).toBe('inferred');
  });

  // ── 2. Same call again → idempotent ─────────────────────────────────────

  it('returns the same SynapsUser on a second resolve call (isLinked=true)', async () => {
    const first = await router.resolve({
      channel: 'slack',
      external_id: 'U001',
      external_team_id: 'T001',
    });

    const second = await router.resolve({
      channel: 'slack',
      external_id: 'U001',
      external_team_id: 'T001',
    });

    expect(second.isNew).toBe(false);
    expect(second.isLinked).toBe(true);
    expect(String(second.synapsUser._id)).toBe(String(first.synapsUser._id));
    expect(second.synapsUser.memory_namespace).toBe(first.synapsUser.memory_namespace);
  });

  // ── 3. Different external_team_id → DIFFERENT SynapsUser ────────────────

  it('creates a DIFFERENT SynapsUser when external_team_id differs (compound key)', async () => {
    const r1 = await router.resolve({
      channel: 'slack',
      external_id: 'U001',
      external_team_id: 'T001',
    });

    const r2 = await router.resolve({
      channel: 'slack',
      external_id: 'U001',
      external_team_id: 'T002', // ← different team
    });

    expect(r1.isNew).toBe(true);
    expect(r2.isNew).toBe(true);
    expect(String(r1.synapsUser._id)).not.toBe(String(r2.synapsUser._id));
    expect(r1.synapsUser.memory_namespace).not.toBe(r2.synapsUser.memory_namespace);

    // Both rows must exist in the DB.
    const docs = await UserModel.find({}).lean();
    expect(docs).toHaveLength(2);
  });
});

// ─── 4+5. resolveWebUser ─────────────────────────────────────────────────────

describe('IdentityRouter.resolveWebUser() with live Mongo', () => {
  it('creates SynapsUser + web channel_identity on first call (isNew=true)', async () => {
    const priaId = new m.Types.ObjectId();
    const { synapsUser, isNew } = await router.resolveWebUser({
      pria_user_id: priaId,
      display_name: 'Bob',
    });

    expect(isNew).toBe(true);
    expect(synapsUser._id).toBeDefined();
    expect(synapsUser.memory_namespace).toBe(`u_${String(synapsUser._id)}`);

    const ci = await CIModel.findOne({
      channel: 'web',
      external_id: String(priaId),
    }).lean();
    expect(ci).not.toBeNull();
    expect(String(ci.synaps_user_id)).toBe(String(synapsUser._id));
    expect(ci.link_method).toBe('oauth');
  });

  it('returns the same SynapsUser on a second resolveWebUser call (isNew=false)', async () => {
    const priaId = new m.Types.ObjectId();

    const first  = await router.resolveWebUser({ pria_user_id: priaId });
    const second = await router.resolveWebUser({ pria_user_id: priaId });

    expect(second.isNew).toBe(false);
    expect(String(second.synapsUser._id)).toBe(String(first.synapsUser._id));

    // Must not have created a second doc.
    const count = await UserModel.countDocuments({ pria_user_id: priaId });
    expect(count).toBe(1);
  });
});

// ─── 6. issueLinkCode → real doc in collection ───────────────────────────────

describe('IdentityRouter.issueLinkCode() with live Mongo', () => {
  it('creates a link_code document with a 6-char code', async () => {
    const priaId = new m.Types.ObjectId();

    const { code, expires_at } = await router.issueLinkCode({
      pria_user_id: priaId,
      ttl_ms: 300_000,
    });

    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now());

    // Verify the doc exists in MongoDB directly.
    const doc = await LCModel.findOne({ code }).lean();
    expect(doc).not.toBeNull();
    expect(doc.redeemed_at).toBeNull();
  });
});

// ─── 7. redeemLinkCode happy path ────────────────────────────────────────────

describe('IdentityRouter.redeemLinkCode() happy path', () => {
  it('binds slack identity to web SynapsUser on successful redemption', async () => {
    const priaId = new m.Types.ObjectId();

    // 1. Issue a code for a web user.
    const { code, synaps_user_id: expectedUserId } = await router.issueLinkCode({
      pria_user_id: priaId,
    });

    // 2. Redeem from Slack.
    const result = await router.redeemLinkCode({
      code,
      channel: 'slack',
      external_id: 'U999',
      external_team_id: 'T999',
      display_name: 'Charlie',
    });

    expect(result.ok).toBe(true);
    expect(result.synaps_user_id).toBe(expectedUserId);

    // 3. Verify channel_identity row in MongoDB.
    const ci = await CIModel.findOne({
      channel: 'slack',
      external_id: 'U999',
      external_team_id: 'T999',
    }).lean();
    expect(ci).not.toBeNull();
    expect(String(ci.synaps_user_id)).toBe(expectedUserId);
    expect(ci.link_method).toBe('magic_code');
  });
});

// ─── 8. redeemLinkCode expired ───────────────────────────────────────────────

describe('IdentityRouter.redeemLinkCode() expired', () => {
  it('returns reason:expired when expires_at is in the past', async () => {
    const priaId = new m.Types.ObjectId();

    // Issue then manually backddate expires_at.
    const { code } = await router.issueLinkCode({ pria_user_id: priaId, ttl_ms: 300_000 });

    await LCModel.findOneAndUpdate(
      { code },
      { $set: { expires_at: new Date(Date.now() - 1000) } },
    );

    const result = await router.redeemLinkCode({
      code,
      channel: 'slack',
      external_id: 'U998',
      external_team_id: 'T998',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });
});

// ─── 9. redeemLinkCode already_redeemed ──────────────────────────────────────

describe('IdentityRouter.redeemLinkCode() already_redeemed', () => {
  it('returns reason:already_redeemed on second redemption of same code', async () => {
    const priaId = new m.Types.ObjectId();
    const { code } = await router.issueLinkCode({ pria_user_id: priaId });

    // First redemption — should succeed.
    const first = await router.redeemLinkCode({
      code,
      channel: 'slack',
      external_id: 'U111',
      external_team_id: 'T111',
    });
    expect(first.ok).toBe(true);

    // Second redemption — same code.
    const second = await router.redeemLinkCode({
      code,
      channel: 'slack',
      external_id: 'U222',
      external_team_id: 'T222',
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('already_redeemed');
  });
});

// ─── 10. Cross-channel reconciliation ────────────────────────────────────────

describe('Cross-channel reconciliation — web + slack share memory_namespace', () => {
  it('slack resolve after link-code redeem returns the web user memory_namespace', async () => {
    const priaId = new m.Types.ObjectId();

    // Step 1: Web user resolves → creates SynapsUser M.
    const { synapsUser: webUser } = await router.resolveWebUser({
      pria_user_id: priaId,
      display_name: 'Diana',
    });
    const memoryNamespaceM = webUser.memory_namespace;

    // Step 2: Web user issues a link code.
    const { code } = await router.issueLinkCode({ pria_user_id: priaId });

    // Step 3: Slack user redeems → binds slack identity to same SynapsUser.
    const redeem = await router.redeemLinkCode({
      code,
      channel: 'slack',
      external_id: 'U500',
      external_team_id: 'T500',
    });
    expect(redeem.ok).toBe(true);
    expect(redeem.synaps_user_id).toBe(String(webUser._id));

    // Step 4: Subsequent slack resolve should return the SAME SynapsUser and namespace.
    const { synapsUser: slackUser, isLinked } = await router.resolve({
      channel: 'slack',
      external_id: 'U500',
      external_team_id: 'T500',
    });

    expect(isLinked).toBe(true);
    expect(String(slackUser._id)).toBe(String(webUser._id));
    expect(slackUser.memory_namespace).toBe(memoryNamespaceM);
  });
});
