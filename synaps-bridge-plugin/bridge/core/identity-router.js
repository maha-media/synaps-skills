/**
 * @file bridge/core/identity-router.js
 *
 * Pure-logic identity reconciliation layer.
 *
 * IdentityRouter
 *   Resolves an inbound (channel, external_id) → SynapsUser, creating rows as
 *   needed.  Handles web-user resolution and the 6-char link-code flow that
 *   lets Slack/Discord users merge their identity into an existing pria account.
 *
 * NoOpIdentityRouter
 *   Drop-in replacement used when `identity.enabled = false`.  Mirrors the
 *   full API but never touches any repo; returns a synthetic SynapsUser whose
 *   memory_namespace preserves the Phase-2 `u_<external_id>` format so that
 *   existing Slack deployments keep working without any code changes in the
 *   adapters.
 *
 * ─── Cardinal rules ──────────────────────────────────────────────────────────
 * • ESM only (import / export)
 * • No top-level await
 * • No I/O in constructors
 * • No mongoose.connect() — only new mongoose.Types.ObjectId() for id gen
 * • No repo class imports — repos are injected via constructor DI
 */

import mongoose from 'mongoose';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Generate a cryptographically-random 6-char [A-Z0-9] code. */
function generateCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  // Use random bytes for uniform distribution.
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

// ─── IdentityRouter ───────────────────────────────────────────────────────────

export class IdentityRouter {
  /**
   * @param {object}   opts
   * @param {object}   opts.userRepo             - SynapsUserRepo instance.
   * @param {object}   opts.channelIdentityRepo  - ChannelIdentityRepo instance.
   * @param {object}   opts.linkCodeRepo         - LinkCodeRepo instance.
   * @param {object}   [opts.logger=console]     - Logger.
   * @param {Function} [opts.nowMs]              - Returns current epoch ms (injectable for tests).
   */
  constructor({
    userRepo,
    channelIdentityRepo,
    linkCodeRepo,
    logger = console,
    nowMs = () => Date.now(),
  } = {}) {
    if (!userRepo)            throw new TypeError('IdentityRouter: userRepo is required');
    if (!channelIdentityRepo) throw new TypeError('IdentityRouter: channelIdentityRepo is required');
    if (!linkCodeRepo)        throw new TypeError('IdentityRouter: linkCodeRepo is required');

    this._userRepo            = userRepo;
    this._channelIdentityRepo = channelIdentityRepo;
    this._linkCodeRepo        = linkCodeRepo;
    this._logger              = logger;
    this._nowMs               = nowMs;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** @returns {true} */
  get enabled() { return true; }

  /**
   * Resolve an inbound (channel, external_id) pair to a SynapsUser.
   *
   * Semantics of `isLinked`:
   *   true  — a channel_identity row already existed (regardless of how it was
   *            created — even an 'inferred' row from a prior call counts).
   *            The synapsUser is the authoritative account for this channel+id.
   *   false — no row existed; we just created a synthetic SynapsUser AND an
   *            'inferred' channel_identity.  Caller should send a link prompt.
   *
   * `isNew` reflects whether the SynapsUser document was created this call.
   *
   * @param {object} params
   * @param {string}  params.channel
   * @param {string}  params.external_id
   * @param {string}  [params.external_team_id='']
   * @param {string|null} [params.display_name=null]
   * @returns {Promise<{ synapsUser: object, isNew: boolean, isLinked: boolean }>}
   */
  async resolve({ channel, external_id, external_team_id = '', display_name = null }) {
    // 1. Lookup existing channel identity.
    const identity = await this._channelIdentityRepo.findByChannelId({
      channel,
      external_id,
      external_team_id,
    });

    if (identity) {
      // 2. Hit — load the associated user.
      const synapsUser = await this._userRepo.findById(String(identity.synaps_user_id));
      return { synapsUser, isNew: false, isLinked: true };
    }

    // 3. Miss — create synthetic SynapsUser + inferred identity.
    const synapsUser = await this._userRepo.create({
      pria_user_id:   null,
      institution_id: null,
      display_name,
      default_channel: channel,
    });

    await this._channelIdentityRepo.upsert({
      synaps_user_id:  synapsUser._id,
      channel,
      external_id,
      external_team_id,
      display_name,
      link_method: 'inferred',
    });

    return { synapsUser, isNew: true, isLinked: false };
  }

  /**
   * Resolve a logged-in pria web user.
   *
   * Always returns a real SynapsUser (creates if pria_user_id is new).
   * Also ensures a 'web' channel_identity row exists for this user.
   *
   * @param {object} params
   * @param {string|import('mongoose').Types.ObjectId} params.pria_user_id
   * @param {string|import('mongoose').Types.ObjectId|null} [params.institution_id]
   * @param {string|null} [params.display_name]
   * @returns {Promise<{ synapsUser: object, isNew: boolean }>}
   */
  async resolveWebUser({ pria_user_id, institution_id = null, display_name = null }) {
    let isNew = false;

    // 1. Check for an existing SynapsUser by pria_user_id.
    let synapsUser = await this._userRepo.findByPriaUserId(String(pria_user_id));

    if (!synapsUser) {
      // 2. Create one.
      synapsUser = await this._userRepo.create({
        pria_user_id,
        institution_id,
        display_name,
        default_channel: 'web',
      });
      isNew = true;
    }

    // 3. Ensure a 'web' channel_identity exists (idempotent upsert).
    await this._channelIdentityRepo.upsert({
      synaps_user_id:  synapsUser._id,
      channel:         'web',
      external_id:     String(pria_user_id),
      external_team_id: '',
      display_name,
      link_method:     'oauth',
    });

    return { synapsUser, isNew };
  }

  /**
   * Issue a 6-char link code for a logged-in pria user.
   *
   * Pre-condition: caller usually runs resolveWebUser first.  For safety,
   * this method also auto-creates the SynapsUser if missing.
   *
   * @param {object} params
   * @param {string|import('mongoose').Types.ObjectId} params.pria_user_id
   * @param {string|import('mongoose').Types.ObjectId|null} [params.institution_id]
   * @param {string|null} [params.display_name]
   * @param {number} [params.ttl_ms=300_000]  5-minute default TTL.
   * @returns {Promise<{ code: string, expires_at: Date, synaps_user_id: string }>}
   */
  async issueLinkCode({ pria_user_id, institution_id = null, display_name = null, ttl_ms = 300_000 }) {
    // Auto-create SynapsUser for safety.
    let synapsUser = await this._userRepo.findByPriaUserId(String(pria_user_id));
    if (!synapsUser) {
      synapsUser = await this._userRepo.create({
        pria_user_id,
        institution_id,
        display_name,
        default_channel: 'web',
      });
    }

    const code       = generateCode();
    const expires_at = new Date(this._nowMs() + ttl_ms);

    await this._linkCodeRepo.create({
      code,
      pria_user_id,
      synaps_user_id: synapsUser._id,
      expires_at,
    });

    return { code, expires_at, synaps_user_id: String(synapsUser._id) };
  }

  /**
   * Redeem a link code from a non-web channel.
   *
   * On success, upserts a channel_identity binding and marks the code redeemed.
   * `was_relinked` is true when the (channel, external_id) was previously bound
   * to a *different* SynapsUser — the caller may want to warn the user.
   *
   * @param {object} params
   * @param {string}  params.code
   * @param {string}  params.channel
   * @param {string}  params.external_id
   * @param {string}  [params.external_team_id='']
   * @param {string|null} [params.display_name=null]
   * @returns {Promise<
   *   | { ok: true,  synaps_user_id: string, was_relinked: boolean }
   *   | { ok: false, reason: 'unknown'|'expired'|'already_redeemed' }
   * >}
   */
  async redeemLinkCode({ code, channel, external_id, external_team_id = '', display_name = null }) {
    // 1. Look up the code document.
    const linkCode = await this._linkCodeRepo.findByCode(code);

    if (!linkCode) {
      return { ok: false, reason: 'unknown' };
    }

    if (linkCode.redeemed_at != null) {
      return { ok: false, reason: 'already_redeemed' };
    }

    if (new Date(linkCode.expires_at) < new Date(this._nowMs())) {
      return { ok: false, reason: 'expired' };
    }

    const synaps_user_id = String(linkCode.synaps_user_id);

    // 2. Check for an existing binding for this (channel, external_id).
    const existing = await this._channelIdentityRepo.findByChannelId({
      channel,
      external_id,
      external_team_id,
    });

    const was_relinked =
      existing != null && String(existing.synaps_user_id) !== synaps_user_id;

    // 3. Upsert the channel_identity to bind to the code's SynapsUser.
    await this._channelIdentityRepo.upsert({
      synaps_user_id: linkCode.synaps_user_id,
      channel,
      external_id,
      external_team_id,
      display_name,
      link_method: 'magic_code',
    });

    // 4. Mark the code redeemed.
    await this._linkCodeRepo.markRedeemed(code, {
      redeemed_by: { channel, external_id, external_team_id },
    });

    return { ok: true, synaps_user_id, was_relinked };
  }
}

// ─── NoOpIdentityRouter ───────────────────────────────────────────────────────

/**
 * Drop-in replacement for IdentityRouter used when `identity.enabled = false`.
 *
 * All methods are immediate no-ops that return synthetic values:
 *   - resolve / resolveWebUser → synthetic SynapsUser with memory_namespace
 *     `u_<external_id>` (preserves Phase-2 behaviour so live Slack bridges
 *     keep working unchanged).
 *   - issueLinkCode → throws — callers must gate this behind `enabled`.
 *   - redeemLinkCode → { ok: false, reason: 'disabled' }
 */
export class NoOpIdentityRouter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.logger=console]
   */
  constructor({ logger = console } = {}) {
    this._logger = logger;
  }

  /** @returns {false} */
  get enabled() { return false; }

  /**
   * Return a synthetic SynapsUser without touching any repo.
   *
   * @param {object} params
   * @param {string}  params.external_id
   * @returns {Promise<{ synapsUser: object, isNew: boolean, isLinked: boolean }>}
   */
  async resolve({ external_id }) {
    return {
      synapsUser: { _id: null, memory_namespace: 'u_' + external_id },
      isNew: false,
      isLinked: false,
    };
  }

  /**
   * Return a synthetic SynapsUser for a pria web user without touching any repo.
   *
   * @param {object} params
   * @param {string|import('mongoose').Types.ObjectId} params.pria_user_id
   * @returns {Promise<{ synapsUser: object, isNew: boolean }>}
   */
  async resolveWebUser({ pria_user_id }) {
    return {
      synapsUser: { _id: null, memory_namespace: 'u_' + String(pria_user_id) },
      isNew: false,
    };
  }

  /**
   * Always throws — identity is disabled.
   *
   * @throws {Error}
   */
  async issueLinkCode() {
    throw new Error('identity disabled');
  }

  /**
   * Always returns a disabled failure.
   *
   * @returns {Promise<{ ok: false, reason: 'disabled' }>}
   */
  async redeemLinkCode() {
    return { ok: false, reason: 'disabled' };
  }
}
