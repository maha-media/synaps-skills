/**
 * @file bridge/core/db/models/synaps-hook.test.js
 *
 * Schema-validation and round-trip tests for the Hook model.
 *
 * Uses mongodb-memory-server for round-trip tests; schema-only tests run
 * without hitting the network.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { makeHookModel } from './synaps-hook.js';

// ── Shared in-memory DB ──────────────────────────────────────────────────────

let mongod;
let m;
let Hook;

/** Minimal valid hook payload — override individual fields per test. */
function validHook(overrides = {}) {
  return {
    scope: { type: 'user', id: new mongoose.Types.ObjectId() },
    event: 'pre_tool',
    action: {
      type: 'webhook',
      config: {
        url:    'https://example.com/hook',
        secret: 'supersecret',
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
}, 60_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Hook.deleteMany({});
});

// ── 1. saves a hook with all required valid fields ───────────────────────────

describe('Hook model — saves a hook with valid fields', () => {
  it('persists scope, event, action and defaults', async () => {
    const doc = await Hook.create(validHook());

    expect(doc._id).toBeDefined();
    expect(doc.scope.type).toBe('user');
    expect(doc.scope.id).toBeDefined();
    expect(doc.event).toBe('pre_tool');
    expect(doc.action.type).toBe('webhook');
    expect(doc.action.config.url).toBe('https://example.com/hook');
    expect(doc.action.config.secret).toBe('supersecret');
    expect(doc.enabled).toBe(true);
  });
});

// ── 2. default values ────────────────────────────────────────────────────────

describe('Hook model — defaults', () => {
  it('defaults enabled to true when not provided', async () => {
    const doc = await Hook.create(validHook());
    expect(doc.enabled).toBe(true);
  });

  it('defaults action.config.timeout_ms to 5000', async () => {
    const doc = await Hook.create(validHook());
    expect(doc.action.config.timeout_ms).toBe(5000);
  });

  it('defaults matcher.tool to null', async () => {
    const doc = await Hook.create(validHook());
    expect(doc.matcher.tool).toBeNull();
  });

  it('defaults matcher.channel to null', async () => {
    const doc = await Hook.create(validHook());
    expect(doc.matcher.channel).toBeNull();
  });
});

// ── 3. event enum ────────────────────────────────────────────────────────────

describe('Hook model — event enum', () => {
  it('accepts all 5 valid lifecycle events', async () => {
    const events = ['pre_tool', 'post_tool', 'pre_stream', 'post_stream', 'on_error'];
    for (const event of events) {
      const doc = new Hook(validHook({ event }));
      await expect(doc.validate()).resolves.toBeUndefined();
    }
  });

  it('rejects an unknown event value', async () => {
    const doc = new Hook(validHook({ event: 'unknown_event' }));
    await expect(doc.validate()).rejects.toThrow(/not a valid hook event/);
  });

  it('requires event to be present', async () => {
    const payload = validHook();
    delete payload.event;
    const doc = new Hook(payload);
    await expect(doc.validate()).rejects.toThrow(/event is required/);
  });
});

// ── 4. action.type enum ──────────────────────────────────────────────────────

describe('Hook model — action.type enum', () => {
  it('accepts "webhook" as action.type', async () => {
    const doc = new Hook(validHook());
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('rejects a non-webhook action type', async () => {
    const payload = validHook();
    payload.action.type = 'email';
    const doc = new Hook(payload);
    await expect(doc.validate()).rejects.toThrow(/not a valid action type/);
  });
});

// ── 5. scope.type enum ───────────────────────────────────────────────────────

describe('Hook model — scope.type enum', () => {
  it('accepts user, institution, global as scope.type', async () => {
    for (const type of ['user', 'institution', 'global']) {
      const id   = type !== 'global' ? new mongoose.Types.ObjectId() : null;
      const doc  = new Hook(validHook({ scope: { type, id } }));
      await expect(doc.validate()).resolves.toBeUndefined();
    }
  });

  it('rejects an unknown scope.type', async () => {
    const doc = new Hook(validHook({ scope: { type: 'team', id: new mongoose.Types.ObjectId() } }));
    await expect(doc.validate()).rejects.toThrow(/not a valid scope type/);
  });
});

// ── 6. scope.id custom validator ─────────────────────────────────────────────

describe('Hook model — scope.id required for non-global scopes', () => {
  it('rejects scope.id null when scope.type is user', async () => {
    const doc = new Hook(validHook({ scope: { type: 'user', id: null } }));
    await expect(doc.validate()).rejects.toThrow(/scope\.id is required/);
  });

  it('rejects scope.id null when scope.type is institution', async () => {
    const doc = new Hook(validHook({ scope: { type: 'institution', id: null } }));
    await expect(doc.validate()).rejects.toThrow(/scope\.id is required/);
  });

  it('allows scope.id null when scope.type is global', async () => {
    const doc = new Hook(validHook({ scope: { type: 'global', id: null } }));
    await expect(doc.validate()).resolves.toBeUndefined();
  });

  it('allows a valid ObjectId when scope.type is user', async () => {
    const doc = new Hook(validHook({ scope: { type: 'user', id: new mongoose.Types.ObjectId() } }));
    await expect(doc.validate()).resolves.toBeUndefined();
  });
});

// ── 7. action.config required fields ─────────────────────────────────────────

describe('Hook model — action.config required fields', () => {
  it('requires action.config.url', async () => {
    const payload = validHook();
    delete payload.action.config.url;
    const doc = new Hook(payload);
    await expect(doc.validate()).rejects.toThrow(/action\.config\.url is required/);
  });

  it('requires action.config.secret', async () => {
    const payload = validHook();
    delete payload.action.config.secret;
    const doc = new Hook(payload);
    await expect(doc.validate()).rejects.toThrow(/action\.config\.secret is required/);
  });
});

// ── 8. matcher stores optional sub-selectors ─────────────────────────────────

describe('Hook model — matcher fields', () => {
  it('persists matcher.tool and matcher.channel when provided', async () => {
    const doc = await Hook.create(
      validHook({ matcher: { tool: 'github_pr', channel: '#dev' } }),
    );
    expect(doc.matcher.tool).toBe('github_pr');
    expect(doc.matcher.channel).toBe('#dev');
  });
});

// ── 9. timestamps ────────────────────────────────────────────────────────────

describe('Hook model — timestamps', () => {
  it('sets created_at and updated_at on create', async () => {
    const before = Date.now();
    const doc    = await Hook.create(validHook());
    const after  = Date.now();

    expect(doc.created_at).toBeInstanceOf(Date);
    expect(doc.updated_at).toBeInstanceOf(Date);
    expect(doc.created_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(doc.created_at.getTime()).toBeLessThanOrEqual(after);
  });

  it('updates updated_at on save', async () => {
    const doc = await Hook.create(validHook());
    const originalUpdatedAt = doc.updated_at;

    // Tiny delay to ensure clock advances
    await new Promise((r) => setTimeout(r, 5));

    doc.enabled = false;
    await doc.save();

    expect(doc.updated_at.getTime()).toBeGreaterThanOrEqual(originalUpdatedAt.getTime());
  });
});

// ── 10. enabled toggle ───────────────────────────────────────────────────────

describe('Hook model — enabled toggle', () => {
  it('can be saved with enabled=false', async () => {
    const doc = await Hook.create(validHook({ enabled: false }));
    expect(doc.enabled).toBe(false);
  });

  it('can be toggled from true to false', async () => {
    const doc = await Hook.create(validHook({ enabled: true }));
    doc.enabled = false;
    await doc.save();
    const fetched = await Hook.findById(doc._id).lean();
    expect(fetched.enabled).toBe(false);
  });
});

// ── 11. makeHookModel is idempotent ──────────────────────────────────────────

describe('makeHookModel — idempotent', () => {
  it('returns the exact same model instance on repeated calls', () => {
    const m1 = makeHookModel(m);
    const m2 = makeHookModel(m);
    expect(m1).toBe(m2);
  });
});

// ── 12. collection name ──────────────────────────────────────────────────────

describe('Hook model — collection name', () => {
  it('uses the synaps_hook collection', () => {
    expect(Hook.collection.name).toBe('synaps_hook');
  });
});
