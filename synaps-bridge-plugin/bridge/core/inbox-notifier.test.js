/**
 * @file bridge/core/inbox-notifier.test.js
 *
 * Tests for InboxNotifier and NoopInboxNotifier.
 *
 * Strategy: all tests use a pure mock `fs` object (no real disk I/O) so
 * they are hermetic, fast, and work on any CI host regardless of filesystem
 * permissions.  One group of integration-style tests uses a real tmpdir to
 * verify the full flow end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as realFs } from 'node:fs';
import { InboxNotifier, NoopInboxNotifier } from './inbox-notifier.js';

// ─── Shared test fixtures ─────────────────────────────────────────────────────

const FIXED_UUID      = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FIXED_DATE      = new Date('2025-05-10T14:30:45.000Z');   // → 20250510-143045
const FIXED_ISO       = '2025-05-10T14:30:45.000Z';
const INBOX_DIR       = '/test/inbox/ws_alice';
const WORKSPACE_ID    = 'ws_alice';
const SYNAPS_USER_ID  = 'user_123';
const REASON          = 'stale_heartbeat';
const DETAILS         = { ageMs: 31 * 60_000, threshold: 1800000 };

/** Build a mock fs object — mkdir and writeFile succeed by default. */
function makeMockFs({ mkdirError = null, writeFileError = null } = {}) {
  return {
    mkdir:     vi.fn().mockImplementation(() => mkdirError    ? Promise.reject(mkdirError)    : Promise.resolve()),
    writeFile: vi.fn().mockImplementation(() => writeFileError ? Promise.reject(writeFileError) : Promise.resolve()),
  };
}

/** Build a standard InboxNotifier with all injectable deps mocked. */
function makeNotifier(overrides = {}) {
  const mockFs = overrides.fs ?? makeMockFs();
  const logger  = overrides.logger ?? {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    notifier: new InboxNotifier({
      inboxDir:   overrides.inboxDir    ?? INBOX_DIR,
      fs:         mockFs,
      now:        overrides.now         ?? (() => FIXED_DATE),
      logger,
      randomUUID: overrides.randomUUID  ?? (() => FIXED_UUID),
    }),
    mockFs,
    logger,
  };
}

/** Extract the parsed JSON payload that was passed to `fs.writeFile`. */
function capturedPayload(mockFs) {
  expect(mockFs.writeFile).toHaveBeenCalledOnce();
  const [, rawJson] = mockFs.writeFile.mock.calls[0];
  return JSON.parse(rawJson);
}

// ─── InboxNotifier tests ──────────────────────────────────────────────────────

describe('InboxNotifier', () => {

  // ── Construction ────────────────────────────────────────────────────────────

  it('throws TypeError when inboxDir is missing', () => {
    expect(() => new InboxNotifier({})).toThrow(TypeError);
  });

  it('throws TypeError when inboxDir is an empty string', () => {
    expect(() => new InboxNotifier({ inboxDir: '' })).toThrow(TypeError);
  });

  // ── Filename pattern ────────────────────────────────────────────────────────

  it('writes a file with the correct reaper-<id>-<YYYYMMDD-HHMMSS>.json pattern', async () => {
    const { notifier, mockFs } = makeNotifier();

    const result = await notifier.notifyWorkspaceReaped({
      workspaceId:   WORKSPACE_ID,
      synapsUserId:  SYNAPS_USER_ID,
      reason:        REASON,
      details:       DETAILS,
    });

    expect(result.written).toBe(true);

    // Assert the filename passed to writeFile matches the pattern
    const [writtenPath] = mockFs.writeFile.mock.calls[0];
    const basename = path.basename(writtenPath);
    expect(basename).toMatch(/^reaper-ws_alice-\d{8}-\d{6}\.json$/);
  });

  it('encodes the fixed timestamp as YYYYMMDD-HHMMSS in the filename', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId:   WORKSPACE_ID,
      synapsUserId:  SYNAPS_USER_ID,
      reason:        REASON,
      details:       DETAILS,
    });

    const [writtenPath] = mockFs.writeFile.mock.calls[0];
    expect(path.basename(writtenPath)).toBe('reaper-ws_alice-20250510-143045.json');
  });

  it('places the file inside inboxDir', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId:   WORKSPACE_ID,
      synapsUserId:  SYNAPS_USER_ID,
      reason:        REASON,
      details:       DETAILS,
    });

    const [writtenPath] = mockFs.writeFile.mock.calls[0];
    expect(writtenPath.startsWith(INBOX_DIR)).toBe(true);
    expect(result => result); // silence lint
    // returned path matches what was written
    const res = await makeNotifier().notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });
    expect(res.path).toContain(INBOX_DIR);
  });

  // ── Directory creation ───────────────────────────────────────────────────────

  it('calls mkdir with { recursive: true } before writing the file', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId:   WORKSPACE_ID,
      synapsUserId:  SYNAPS_USER_ID,
      reason:        REASON,
      details:       DETAILS,
    });

    expect(mockFs.mkdir).toHaveBeenCalledOnce();
    const [mkdirPath, mkdirOpts] = mockFs.mkdir.mock.calls[0];
    expect(mkdirPath).toBe(INBOX_DIR);
    expect(mkdirOpts).toEqual({ recursive: true });

    // mkdir must have been called BEFORE writeFile
    const mkdirOrder    = mockFs.mkdir.mock.invocationCallOrder[0];
    const writeOrder    = mockFs.writeFile.mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(writeOrder);
  });

  // ── Payload shape — exact match with Rust Event struct ───────────────────────

  it('payload has correct top-level keys matching the Rust Event struct', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId:   WORKSPACE_ID,
      synapsUserId:  SYNAPS_USER_ID,
      reason:        REASON,
      details:       DETAILS,
    });

    const payload = capturedPayload(mockFs);

    expect(payload).toHaveProperty('id');
    expect(payload).toHaveProperty('timestamp');
    expect(payload).toHaveProperty('source');
    expect(payload).toHaveProperty('channel');
    expect(payload).toHaveProperty('sender');
    expect(payload).toHaveProperty('content');
    expect(payload).toHaveProperty('expects_response');
    expect(payload).toHaveProperty('reply_to');
  });

  it('payload.id is the injected UUID', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    expect(capturedPayload(mockFs).id).toBe(FIXED_UUID);
  });

  it('payload.timestamp is ISO-8601 and equals the injected now()', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    const payload = capturedPayload(mockFs);
    expect(payload.timestamp).toBe(FIXED_ISO);
    // Must parse as a valid Date
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
  });

  it('payload.source matches { source_type: "reaper", name: workspaceId, callback: null }', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    const { source } = capturedPayload(mockFs);
    expect(source).toEqual({
      source_type: 'reaper',
      name:        WORKSPACE_ID,
      callback:    null,
    });
  });

  it('payload.channel and payload.sender are null', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    const payload = capturedPayload(mockFs);
    expect(payload.channel).toBeNull();
    expect(payload.sender).toBeNull();
  });

  it('payload.content.content_type is "workspace_reaped"', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    expect(capturedPayload(mockFs).content.content_type).toBe('workspace_reaped');
  });

  it('payload.content.severity is "High"', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    expect(capturedPayload(mockFs).content.severity).toBe('High');
  });

  it('payload.content.text contains reason', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    const { text } = capturedPayload(mockFs).content;
    expect(text).toContain(REASON);
    expect(text).toContain(WORKSPACE_ID);
  });

  it('payload.content.data.reason equals the passed reason', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    const { data } = capturedPayload(mockFs).content;
    expect(data.reason).toBe(REASON);
  });

  it('payload.content.data contains workspace_id and synaps_user_id', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    const { data } = capturedPayload(mockFs).content;
    expect(data.workspace_id).toBe(WORKSPACE_ID);
    expect(data.synaps_user_id).toBe(SYNAPS_USER_ID);
  });

  it('payload.expects_response is false and payload.reply_to is null', async () => {
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    const payload = capturedPayload(mockFs);
    expect(payload.expects_response).toBe(false);
    expect(payload.reply_to).toBeNull();
  });

  // ── Injected clock & UUID ───────────────────────────────────────────────────

  it('timestamp uses the injected now() date', async () => {
    const customDate = new Date('2024-01-01T00:00:00.000Z');
    const { notifier, mockFs } = makeNotifier({ now: () => customDate });

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    expect(capturedPayload(mockFs).timestamp).toBe('2024-01-01T00:00:00.000Z');
  });

  it('uuid uses the injected randomUUID()', async () => {
    const myUUID = '12345678-1234-1234-1234-123456789abc';
    const { notifier, mockFs } = makeNotifier({ randomUUID: () => myUUID });

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    expect(capturedPayload(mockFs).id).toBe(myUUID);
  });

  // ── Error resilience ────────────────────────────────────────────────────────

  it('mkdir error → returns { written: false, error } and does NOT throw', async () => {
    const mkdirErr = new Error('EACCES: permission denied');
    const { notifier } = makeNotifier({
      fs: makeMockFs({ mkdirError: mkdirErr }),
    });

    // Must resolve (not reject)
    const resultPromise = notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });
    await expect(resultPromise).resolves.toBeDefined();
    const result = await resultPromise.catch(() => undefined);
    const settled = await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    expect(settled.written).toBe(false);
    expect(settled.error).toBe(mkdirErr.message);
  });

  it('mkdir error → warn is logged with relevant context', async () => {
    const mkdirErr = new Error('EACCES: permission denied');
    const { notifier, logger } = makeNotifier({
      fs: makeMockFs({ mkdirError: mkdirErr }),
    });

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    expect(logger.warn).toHaveBeenCalledOnce();
    const [msg] = logger.warn.mock.calls[0];
    expect(msg).toMatch(/mkdir/i);
  });

  it('mkdir error → writeFile is NOT called', async () => {
    const mkdirErr = new Error('ENOENT');
    const mockFs = makeMockFs({ mkdirError: mkdirErr });
    const { notifier } = makeNotifier({ fs: mockFs });

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it('writeFile error → returns { written: false, error } and does NOT throw', async () => {
    const writeErr = new Error('ENOSPC: no space left on device');
    const { notifier } = makeNotifier({
      fs: makeMockFs({ writeFileError: writeErr }),
    });

    const settled = await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    expect(settled.written).toBe(false);
    expect(settled.error).toBe(writeErr.message);
  });

  it('writeFile error → warn is logged', async () => {
    const writeErr = new Error('ENOSPC: no space left on device');
    const { notifier, logger } = makeNotifier({
      fs: makeMockFs({ writeFileError: writeErr }),
    });

    await notifier.notifyWorkspaceReaped({
      workspaceId: WORKSPACE_ID, synapsUserId: SYNAPS_USER_ID,
      reason: REASON, details: DETAILS,
    });

    expect(logger.warn).toHaveBeenCalledOnce();
    const [msg] = logger.warn.mock.calls[0];
    expect(msg).toMatch(/writeFile/i);
  });

  // ── synapsUserId null tolerance ─────────────────────────────────────────────

  it('tolerates synapsUserId: null and passes it through as null in data', async () => {
    const { notifier, mockFs } = makeNotifier();

    const result = await notifier.notifyWorkspaceReaped({
      workspaceId:   WORKSPACE_ID,
      synapsUserId:  null,
      reason:        REASON,
      details:       DETAILS,
    });

    expect(result.written).toBe(true);
    const { data } = capturedPayload(mockFs).content;
    expect(data.synaps_user_id).toBeNull();
  });

  // ── reason in content.text ──────────────────────────────────────────────────

  it('reason string appears in content.text and content.data.reason', async () => {
    const customReason = 'oom_killed';
    const { notifier, mockFs } = makeNotifier();

    await notifier.notifyWorkspaceReaped({
      workspaceId:   WORKSPACE_ID,
      synapsUserId:  SYNAPS_USER_ID,
      reason:        customReason,
      details:       {},
    });

    const { content } = capturedPayload(mockFs);
    expect(content.text).toContain(customReason);
    expect(content.data.reason).toBe(customReason);
  });

  // ── Return value ────────────────────────────────────────────────────────────

  it('returns { written: true, path } on success with full path', async () => {
    const { notifier } = makeNotifier();

    const result = await notifier.notifyWorkspaceReaped({
      workspaceId:   WORKSPACE_ID,
      synapsUserId:  SYNAPS_USER_ID,
      reason:        REASON,
      details:       DETAILS,
    });

    expect(result.written).toBe(true);
    expect(typeof result.path).toBe('string');
    expect(result.path.startsWith(INBOX_DIR)).toBe(true);
    expect(result.path.endsWith('.json')).toBe(true);
  });

  // ── Integration: real tmpdir ────────────────────────────────────────────────

  it('real fs: creates directory and writes a readable JSON file', async () => {
    const tmpDir = path.join(os.tmpdir(), `inbox-notifier-test-${Date.now()}`);

    const notifier = new InboxNotifier({
      inboxDir:   tmpDir,
      // use real fs
      now:        () => FIXED_DATE,
      randomUUID: () => FIXED_UUID,
    });

    const result = await notifier.notifyWorkspaceReaped({
      workspaceId:  'ws_real_test',
      synapsUserId: 'u_real',
      reason:       'stale_heartbeat',
      details:      { ageMs: 120_000 },
    });

    expect(result.written).toBe(true);

    // Verify file is readable and well-formed JSON
    const raw     = await realFs.readFile(result.path, 'utf8');
    const payload = JSON.parse(raw);
    expect(payload.id).toBe(FIXED_UUID);
    expect(payload.content.content_type).toBe('workspace_reaped');
    expect(payload.source.source_type).toBe('reaper');

    // Clean up
    await realFs.rm(tmpDir, { recursive: true, force: true });
  });

});

// ─── NoopInboxNotifier tests ──────────────────────────────────────────────────

describe('NoopInboxNotifier', () => {

  it('notifyWorkspaceReaped() resolves to { written: false, reason: "noop" }', async () => {
    const noop = new NoopInboxNotifier();
    const result = await noop.notifyWorkspaceReaped({
      workspaceId:   WORKSPACE_ID,
      synapsUserId:  SYNAPS_USER_ID,
      reason:        REASON,
      details:       DETAILS,
    });

    expect(result).toEqual({ written: false, reason: 'noop' });
  });

  it('does NOT touch the filesystem (no real I/O)', async () => {
    // We verify by passing no inboxDir — if it tried to use fs it would throw.
    const noop = new NoopInboxNotifier();
    // Should resolve cleanly without any errors even with no deps
    await expect(
      noop.notifyWorkspaceReaped({ workspaceId: 'x', synapsUserId: null, reason: 'y', details: {} }),
    ).resolves.toEqual({ written: false, reason: 'noop' });
  });

  it('calling with no args also resolves to { written: false, reason: "noop" }', async () => {
    const noop = new NoopInboxNotifier();
    const result = await noop.notifyWorkspaceReaped();
    expect(result).toEqual({ written: false, reason: 'noop' });
  });

});
