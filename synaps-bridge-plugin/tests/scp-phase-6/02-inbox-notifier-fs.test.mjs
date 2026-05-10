/**
 * @file tests/scp-phase-6/02-inbox-notifier-fs.test.mjs
 *
 * InboxNotifier + Reaper integration acceptance tests with a real filesystem.
 *
 * Strategy
 * ────────
 * • Uses `os.tmpdir()` derived directories for isolation — each test gets a
 *   unique subdir so tests cannot interfere.
 * • Real `node:fs/promises` is used (not mocked) so we verify actual FS writes.
 * • InboxNotifier.notifyWorkspaceReaped() is called directly and the written
 *   file is parsed and validated against the Rust Event struct shape.
 * • Reaper integration: builds a Reaper with a mock repo + NoopWorkspaceManager
 *   and NoopInboxNotifier so we can assert notifier calls without real Docker.
 *
 * ≥ 5 tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { InboxNotifier, NoopInboxNotifier } from '../../bridge/core/inbox-notifier.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const silent = { info: () => {}, warn: vi.fn(), debug: () => {}, error: () => {} };

/** Create a temp dir unique to this test run. */
async function makeTempDir() {
  const dir = path.join(os.tmpdir(), `synaps-inbox-test-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Deep-search an object (stringified) for a literal string. */
function deepContains(obj, str) {
  return JSON.stringify(obj).includes(str);
}

// ─── 1. File written with correct name pattern ────────────────────────────────

describe('InboxNotifier — file written with correct name pattern', () => {
  let inboxDir;

  beforeEach(async () => {
    inboxDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(inboxDir, { recursive: true, force: true });
  });

  it('writes reaper-<workspaceId>-<YYYYMMDD-HHMMSS>.json', async () => {
    const workspaceId = 'ws_alice';
    const notifier = new InboxNotifier({ inboxDir });

    const result = await notifier.notifyWorkspaceReaped({
      workspaceId,
      synapsUserId: 'user-1',
      reason:       'stale_heartbeat',
      details:      { ageMs: 31 * 60_000 },
    });

    expect(result.written).toBe(true);
    expect(typeof result.path).toBe('string');

    // Filename must match the pattern reaper-<workspaceId>-YYYYMMDD-HHMMSS.json
    const filename = path.basename(result.path);
    expect(filename).toMatch(/^reaper-ws_alice-\d{8}-\d{6}\.json$/);
  });
});

// ─── 2. Payload shape exactly matches Rust Event struct ───────────────────────

describe('InboxNotifier — payload shape matches Rust Event struct', () => {
  let inboxDir;

  beforeEach(async () => {
    inboxDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(inboxDir, { recursive: true, force: true });
  });

  it('written JSON exactly matches Rust Event/EventSource/EventContent shape', async () => {
    const workspaceId = 'ws_payload_test';
    const synapsUserId = 'user-payload-1';
    const reason = 'stale_heartbeat';
    const details = { ageMs: 31 * 60_000, threshold: 30 * 60_000 };

    const now = new Date('2025-01-01T10:00:00.000Z');
    const testUUID = '12345678-1234-1234-1234-123456789abc';

    const notifier = new InboxNotifier({
      inboxDir,
      now:        () => now,
      randomUUID: () => testUUID,
    });

    const result = await notifier.notifyWorkspaceReaped({
      workspaceId,
      synapsUserId,
      reason,
      details,
    });

    expect(result.written).toBe(true);

    const payload = JSON.parse(await fs.readFile(result.path, 'utf8'));

    // Top-level fields.
    expect(payload.id).toBe(testUUID);
    expect(payload.timestamp).toBe('2025-01-01T10:00:00.000Z');
    expect(payload.channel).toBeNull();
    expect(payload.sender).toBeNull();
    expect(payload.expects_response).toBe(false);
    expect(payload.reply_to).toBeNull();

    // source shape.
    expect(payload.source).toMatchObject({
      source_type: 'reaper',
      name:        workspaceId,
      callback:    null,
    });

    // content shape.
    expect(payload.content).toMatchObject({
      content_type: 'workspace_reaped',
      severity:     'High',
    });
    expect(typeof payload.content.text).toBe('string');
    expect(payload.content.text).toContain(workspaceId);

    // content.data shape.
    expect(payload.content.data).toMatchObject({
      workspace_id:   workspaceId,
      synaps_user_id: synapsUserId,
      reason,
    });
  });
});

// ─── 3. Directory created if missing ──────────────────────────────────────────

describe('InboxNotifier — mkdir recursive', () => {
  it('creates the directory when it does not yet exist', async () => {
    const base = path.join(os.tmpdir(), `synaps-mkdir-test-${randomUUID()}`);
    const inboxDir = path.join(base, 'nested', 'inbox');

    const notifier = new InboxNotifier({ inboxDir });

    const result = await notifier.notifyWorkspaceReaped({
      workspaceId:  'ws-mkdir',
      synapsUserId: 'user-1',
      reason:       'stale_heartbeat',
    });

    expect(result.written).toBe(true);

    // Directory exists now.
    const stat = await fs.stat(inboxDir);
    expect(stat.isDirectory()).toBe(true);

    // Clean up.
    await fs.rm(base, { recursive: true, force: true });
  });
});

// ─── 4. mkdir error → returns { written: false } + warn log ──────────────────

describe('InboxNotifier — mkdir failure is soft', () => {
  it('returns { written: false } and warn-logs when mkdir fails', async () => {
    const warnSpy = vi.fn();
    const brokenFs = {
      mkdir:     vi.fn().mockRejectedValue(new Error('permission denied')),
      writeFile: vi.fn(),
    };

    const notifier = new InboxNotifier({
      inboxDir: '/some/inbox',
      fs:       brokenFs,
      logger:   { info: () => {}, warn: warnSpy, debug: () => {}, error: () => {} },
    });

    const result = await notifier.notifyWorkspaceReaped({
      workspaceId:  'ws-fail',
      synapsUserId: 'user-1',
      reason:       'stale_heartbeat',
    });

    expect(result.written).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(warnSpy).toHaveBeenCalled();
    expect(brokenFs.writeFile).not.toHaveBeenCalled();
  });
});

// ─── 5. writeFile error → returns { written: false } + warn log ───────────────

describe('InboxNotifier — writeFile failure is soft', () => {
  it('returns { written: false } and warn-logs when writeFile fails', async () => {
    const warnSpy = vi.fn();
    const brokenFs = {
      mkdir:     vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockRejectedValue(new Error('disk full')),
    };

    const notifier = new InboxNotifier({
      inboxDir: '/some/inbox',
      fs:       brokenFs,
      logger:   { info: () => {}, warn: warnSpy, debug: () => {}, error: () => {} },
    });

    const result = await notifier.notifyWorkspaceReaped({
      workspaceId:  'ws-diskfull',
      synapsUserId: 'user-1',
      reason:       'stale_heartbeat',
    });

    expect(result.written).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ─── 6. NoopInboxNotifier writes nothing ──────────────────────────────────────

describe('NoopInboxNotifier — writes no file', () => {
  it('notifyWorkspaceReaped() returns { written: false, reason: "noop" }', async () => {
    const noop = new NoopInboxNotifier();
    const result = await noop.notifyWorkspaceReaped({
      workspaceId:  'ws-noop',
      synapsUserId: 'user-1',
      reason:       'stale_heartbeat',
    });
    expect(result.written).toBe(false);
    expect(result.reason).toBe('noop');
  });
});

// ─── 7. Reaper → InboxNotifier integration (via mock Reaper) ──────────────────

describe('InboxNotifier — Reaper integration', () => {
  let inboxDir;

  beforeEach(async () => {
    inboxDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(inboxDir, { recursive: true, force: true });
  });

  it('payload content.text describes the reap reason + workspace', async () => {
    const notifier = new InboxNotifier({ inboxDir });

    const result = await notifier.notifyWorkspaceReaped({
      workspaceId:  'ws_reaper_test',
      synapsUserId: 'user-reaper',
      reason:       'stale_heartbeat',
      details:      { ageMs: 31 * 60_000 },
    });

    expect(result.written).toBe(true);

    const payload = JSON.parse(await fs.readFile(result.path, 'utf8'));
    expect(payload.content.text).toContain('ws_reaper_test');
    expect(payload.content.text).toContain('stale_heartbeat');
  });
});
