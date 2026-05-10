/**
 * @file bridge/core/db/repositories/hook-repo.test.js
 *
 * Tests for HookRepo.
 *
 * Uses mongodb-memory-server for an in-process MongoDB instance.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { makeHookModel } from '../models/synaps-hook.js';
import { HookRepo } from './hook-repo.js';

// ── Shared in-memory DB fixture ──────────────────────────────────────────────

let mongod;
let m;
let Hook;
let repo;

/** Minimal valid hook payload — override individual fields per test. */
function validPayload(overrides = {}) {
  return {
    scope: { type: 'user', id: new mongoose.Types.ObjectId() },
    event: 'pre_tool',
    action: {
      type: 'webhook',
      config: {
        url:    'https://example.com/hook',
        secret: 'topsecret',
      },
    },
    ...overrides,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5_000,
    autoIndex: true,
  });
  Hook = makeHookModel(m);
  repo = new HookRepo({ Hook });
}, 60_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Hook.deleteMany({});
});

// ── 1. create() — inserts a new hook ─────────────────────────────────────────

describe('HookRepo.create() — inserts a new hook', () => {
  it('returns the saved document with an _id', async () => {
    const doc = await repo.create(validPayload());

    expect(doc._id).toBeDefined();
    expect(doc.event).toBe('pre_tool');
    expect(doc.action.type).toBe('webhook');
    expect(doc.enabled).toBe(true);
  });

  it('persists scope.type and scope.id', async () => {
    const scopeId = new mongoose.Types.ObjectId();
    const doc = await repo.create(validPayload({ scope: { type: 'institution', id: scopeId } }));

    expect(doc.scope.type).toBe('institution');
    expect(doc.scope.id.toString()).toBe(scopeId.toString());
  });

  it('persists global scope with null id', async () => {
    const doc = await repo.create(validPayload({ scope: { type: 'global', id: null } }));

    expect(doc.scope.type).toBe('global');
    expect(doc.scope.id).toBeNull();
  });

  it('persists optional matcher fields', async () => {
    const doc = await repo.create(
      validPayload({ matcher: { tool: 'github_pr', channel: '#dev' } }),
    );

    expect(doc.matcher.tool).toBe('github_pr');
    expect(doc.matcher.channel).toBe('#dev');
  });
});

// ── 2. findById() ─────────────────────────────────────────────────────────────

describe('HookRepo.findById()', () => {
  it('returns the matching hook as a lean document', async () => {
    const created = await repo.create(validPayload());
    const found   = await repo.findById(created._id);

    expect(found).toBeDefined();
    expect(found._id.toString()).toBe(created._id.toString());
    expect(found.event).toBe('pre_tool');
  });

  it('returns null when no hook with that id exists', async () => {
    const result = await repo.findById(new mongoose.Types.ObjectId());
    expect(result).toBeNull();
  });
});

// ── 3. listAll() ──────────────────────────────────────────────────────────────

describe('HookRepo.listAll()', () => {
  it('returns all hooks when called with no filter', async () => {
    await repo.create(validPayload({ enabled: true }));
    await repo.create(validPayload({ enabled: false }));

    const all = await repo.listAll();
    expect(all).toHaveLength(2);
  });

  it('filters by enabled=true', async () => {
    await repo.create(validPayload({ enabled: true }));
    await repo.create(validPayload({ enabled: false }));

    const enabled = await repo.listAll({ enabled: true });
    expect(enabled).toHaveLength(1);
    expect(enabled[0].enabled).toBe(true);
  });

  it('filters by enabled=false', async () => {
    await repo.create(validPayload({ enabled: true }));
    await repo.create(validPayload({ enabled: false }));

    const disabled = await repo.listAll({ enabled: false });
    expect(disabled).toHaveLength(1);
    expect(disabled[0].enabled).toBe(false);
  });

  it('returns empty array when collection is empty', async () => {
    const result = await repo.listAll();
    expect(result).toEqual([]);
  });
});

// ── 4. setEnabled() ──────────────────────────────────────────────────────────

describe('HookRepo.setEnabled()', () => {
  it('disables an enabled hook', async () => {
    const doc     = await repo.create(validPayload({ enabled: true }));
    const updated = await repo.setEnabled(doc._id, false);

    expect(updated.enabled).toBe(false);
  });

  it('enables a disabled hook', async () => {
    const doc     = await repo.create(validPayload({ enabled: false }));
    const updated = await repo.setEnabled(doc._id, true);

    expect(updated.enabled).toBe(true);
  });

  it('returns null when id does not exist', async () => {
    const result = await repo.setEnabled(new mongoose.Types.ObjectId(), false);
    expect(result).toBeNull();
  });

  it('persists the change to the database', async () => {
    const doc = await repo.create(validPayload({ enabled: true }));
    await repo.setEnabled(doc._id, false);

    const fetched = await repo.findById(doc._id);
    expect(fetched.enabled).toBe(false);
  });
});

// ── 5. remove() ──────────────────────────────────────────────────────────────

describe('HookRepo.remove()', () => {
  it('deletes an existing hook and returns true', async () => {
    const doc    = await repo.create(validPayload());
    const result = await repo.remove(doc._id);

    expect(result).toBe(true);

    const fetched = await repo.findById(doc._id);
    expect(fetched).toBeNull();
  });

  it('returns false when no hook exists with that id', async () => {
    const result = await repo.remove(new mongoose.Types.ObjectId());
    expect(result).toBe(false);
  });
});

// ── 6. listByEvent() — basic event filter ────────────────────────────────────

describe('HookRepo.listByEvent() — basic event filter', () => {
  it('returns only enabled hooks for the given event', async () => {
    await repo.create(validPayload({ event: 'pre_tool',  enabled: true }));
    await repo.create(validPayload({ event: 'post_tool', enabled: true }));
    await repo.create(validPayload({ event: 'pre_tool',  enabled: false }));

    const hooks = await repo.listByEvent({ event: 'pre_tool' });

    expect(hooks).toHaveLength(1);
    expect(hooks[0].event).toBe('pre_tool');
    expect(hooks[0].enabled).toBe(true);
  });

  it('returns empty array when no enabled hooks match the event', async () => {
    await repo.create(validPayload({ event: 'on_error', enabled: true }));
    const hooks = await repo.listByEvent({ event: 'pre_stream' });
    expect(hooks).toHaveLength(0);
  });
});

// ── 7. listByEvent() — scope specificity ordering ────────────────────────────

describe('HookRepo.listByEvent() — scope specificity ordering: user > institution > global', () => {
  it('orders results user > institution > global', async () => {
    const userId        = new mongoose.Types.ObjectId();
    const institutionId = new mongoose.Types.ObjectId();

    // Insert in reverse specificity order
    await repo.create(validPayload({ event: 'pre_tool', scope: { type: 'global', id: null } }));
    await repo.create(validPayload({ event: 'pre_tool', scope: { type: 'institution', id: institutionId } }));
    await repo.create(validPayload({ event: 'pre_tool', scope: { type: 'user', id: userId } }));

    const hooks = await repo.listByEvent({
      event: 'pre_tool',
      scope: { userId: userId.toString(), institutionId: institutionId.toString() },
    });

    expect(hooks).toHaveLength(3);
    expect(hooks[0].scope.type).toBe('user');
    expect(hooks[1].scope.type).toBe('institution');
    expect(hooks[2].scope.type).toBe('global');
  });

  it('always returns global hooks last even without user/institution in scope filter', async () => {
    await repo.create(validPayload({ event: 'pre_tool', scope: { type: 'global', id: null } }));
    await repo.create(validPayload({ event: 'pre_tool', scope: { type: 'global', id: null } }));

    const hooks = await repo.listByEvent({ event: 'pre_tool' });

    expect(hooks).toHaveLength(2);
    hooks.forEach((h) => expect(h.scope.type).toBe('global'));
  });
});

// ── 8. listByEvent() — scope filtering excludes other users ──────────────────

describe('HookRepo.listByEvent() — scope filter excludes hooks belonging to other users', () => {
  it('does not include hooks for a different userId', async () => {
    const userId      = new mongoose.Types.ObjectId();
    const otherUserId = new mongoose.Types.ObjectId();

    await repo.create(validPayload({ event: 'pre_tool', scope: { type: 'user', id: otherUserId } }));
    await repo.create(validPayload({ event: 'pre_tool', scope: { type: 'global', id: null } }));

    const hooks = await repo.listByEvent({
      event: 'pre_tool',
      scope: { userId: userId.toString() },
    });

    // Only global should come through — not the other user's hook
    expect(hooks).toHaveLength(1);
    expect(hooks[0].scope.type).toBe('global');
  });
});

// ── 9. listByEvent() — no scope arg returns all enabled hooks for event ───────

describe('HookRepo.listByEvent() — no scope arg', () => {
  it('returns all enabled hooks for the event across all scopes', async () => {
    const id = new mongoose.Types.ObjectId();
    await repo.create(validPayload({ event: 'on_error', scope: { type: 'user',   id } }));
    await repo.create(validPayload({ event: 'on_error', scope: { type: 'global', id: null } }));
    await repo.create(validPayload({ event: 'on_error', enabled: false, scope: { type: 'global', id: null } }));

    const hooks = await repo.listByEvent({ event: 'on_error' });
    expect(hooks).toHaveLength(2);
  });
});
