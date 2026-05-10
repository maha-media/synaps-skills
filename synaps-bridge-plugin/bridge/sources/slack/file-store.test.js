/**
 * @file file-store.test.js
 *
 * Tests for downloadSlackFile and sanitizeFilename.
 * All I/O and network calls are fully mocked; no live filesystem writes
 * except into os.tmpdir() for the real-path test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as realFs } from 'node:fs';
import { downloadSlackFile, sanitizeFilename } from './file-store.js';

// ─── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal Slack file metadata object. */
function fileMeta(overrides = {}) {
  return {
    id: 'F0001',
    name: 'report.pdf',
    mimetype: 'application/pdf',
    url_private: 'https://files.slack.com/files-pri/T000/F0001/report.pdf',
    size: 1024,
    ...overrides,
  };
}

/** Build a successful fetch mock that returns `bytes` as an ArrayBuffer. */
function okFetch(bytes = new Uint8Array([1, 2, 3]).buffer) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: {
      get: (key) => (key === 'content-length' ? String(bytes.byteLength) : null),
    },
    arrayBuffer: () => Promise.resolve(bytes),
  });
}

/** Build a mock fs.promises object whose writes are recorded but not executed. */
function mockFs() {
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
}

const BASE_OPTS = {
  conversation: 'C123',
  thread: '1620000000.000100',
  botToken: 'xoxb-test-token',
};

// ─── sanitizeFilename ─────────────────────────────────────────────────────────

describe('sanitizeFilename', () => {
  it('returns the name unchanged when it is already safe', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
  });

  it('strips forward slashes (path traversal)', () => {
    const result = sanitizeFilename('../../../etc/passwd');
    expect(result).not.toContain('/');
    expect(result).not.toContain('..');
  });

  it('strips backslashes', () => {
    const result = sanitizeFilename('..\\windows\\system32\\file.dll');
    expect(result).not.toContain('\\');
  });

  it('removes ASCII control characters', () => {
    const nameWithControl = 'file\x00name\x1Ftest.txt';
    const result = sanitizeFilename(nameWithControl);
    // eslint-disable-next-line no-control-regex
    expect(result).not.toMatch(/[\x00-\x1F\x7F]/);
  });

  it('truncates names longer than 200 characters', () => {
    const long = 'a'.repeat(250) + '.txt';
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('falls back to "attachment" for an empty string', () => {
    expect(sanitizeFilename('')).toBe('attachment');
  });

  it('falls back to "attachment" for a non-string input', () => {
    expect(sanitizeFilename(null)).toBe('attachment');
    expect(sanitizeFilename(undefined)).toBe('attachment');
  });

  it('strips filesystem-illegal characters (< > : " | ? *)', () => {
    const result = sanitizeFilename('file<name>:test|thing?.txt');
    expect(result).not.toMatch(/[<>:"|?*]/);
  });
});

// ─── downloadSlackFile — happy path ───────────────────────────────────────────

describe('downloadSlackFile — happy path', () => {
  it('returns { path, name, mime } with correct values', async () => {
    const root = path.join(os.tmpdir(), 'slack-test-happy');
    const fetch = okFetch();
    const fsImpl = mockFs();

    const result = await downloadSlackFile({
      fileMeta: fileMeta(),
      ...BASE_OPTS,
      fetchImpl: fetch,
      fsImpl,
      root,
    });

    expect(result).toMatchObject({
      path: expect.stringContaining('report.pdf'),
      name: 'report.pdf',
      mime: 'application/pdf',
    });
  });

  it('writes to <root>/<conversation>/<thread>/<sanitized-name>', async () => {
    const root = '/tmp/synaps-test-root';
    const fsImpl = mockFs();
    const fetch = okFetch();

    const result = await downloadSlackFile({
      fileMeta: fileMeta({ name: 'my file.pdf' }),
      conversation: 'C999',
      thread: '1620000001.000200',
      botToken: 'xoxb-test',
      fetchImpl: fetch,
      fsImpl,
      root,
    });

    const expectedDir = path.join(root, 'C999', '1620000001.000200');
    expect(fsImpl.mkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
    expect(result.path).toMatch(/C999/);
    expect(result.path).toMatch(/1620000001\.000200/);
  });

  it('writes the file with mode 0o600', async () => {
    const fsImpl = mockFs();
    const fetch = okFetch();

    await downloadSlackFile({
      fileMeta: fileMeta(),
      ...BASE_OPTS,
      fetchImpl: fetch,
      fsImpl,
      root: '/tmp/test-mode',
    });

    expect(fsImpl.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ mode: 0o600 }),
    );
  });

  it('sends the Authorization header with the bot token', async () => {
    const fsImpl = mockFs();
    const fetch = okFetch();

    await downloadSlackFile({
      fileMeta: fileMeta(),
      ...BASE_OPTS,
      botToken: 'xoxb-actual-token-here',
      fetchImpl: fetch,
      fsImpl,
      root: '/tmp/test-auth',
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: 'Bearer xoxb-actual-token-here' },
      }),
    );
  });

  it('propagates Slack file metadata (mimetype) to attachment shape', async () => {
    const fsImpl = mockFs();
    const fetch = okFetch();

    const result = await downloadSlackFile({
      fileMeta: fileMeta({ mimetype: 'image/png', name: 'screenshot.png' }),
      ...BASE_OPTS,
      fetchImpl: fetch,
      fsImpl,
      root: '/tmp/test-mime',
    });

    expect(result.mime).toBe('image/png');
    expect(result.name).toBe('screenshot.png');
  });
});

// ─── downloadSlackFile — size guard ───────────────────────────────────────────

describe('downloadSlackFile — size guard', () => {
  it('rejects when fileMeta.size exceeds maxBytes (no fetch called)', async () => {
    const fsImpl = mockFs();
    const fetch = vi.fn();
    const maxBytes = 100;

    await expect(
      downloadSlackFile({
        fileMeta: fileMeta({ size: 200 }),
        ...BASE_OPTS,
        fetchImpl: fetch,
        fsImpl,
        root: '/tmp/test-size',
        maxBytes,
      }),
    ).rejects.toThrow(/exceeds/);

    expect(fetch).not.toHaveBeenCalled();
    expect(fsImpl.writeFile).not.toHaveBeenCalled();
  });

  it('rejects when actual downloaded bytes exceed maxBytes', async () => {
    const fsImpl = mockFs();
    const bigBuf = new Uint8Array(500).buffer;
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(bigBuf),
    });

    await expect(
      downloadSlackFile({
        fileMeta: fileMeta({ size: 0 }), // unknown size — proceed
        ...BASE_OPTS,
        fetchImpl: fetch,
        fsImpl,
        root: '/tmp/test-actual-size',
        maxBytes: 100,
      }),
    ).rejects.toThrow(/exceeds/);

    expect(fsImpl.writeFile).not.toHaveBeenCalled();
  });
});

// ─── downloadSlackFile — fetch failure ────────────────────────────────────────

describe('downloadSlackFile — fetch failure', () => {
  it('throws a clean error when fetch rejects', async () => {
    const fsImpl = mockFs();
    const fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      downloadSlackFile({
        fileMeta: fileMeta(),
        ...BASE_OPTS,
        fetchImpl: fetch,
        fsImpl,
        root: '/tmp/test-fetch-fail',
      }),
    ).rejects.toThrow(/Fetch failed/);

    expect(fsImpl.writeFile).not.toHaveBeenCalled();
  });

  it('throws a clean error when fetch returns a non-OK response', async () => {
    const fsImpl = mockFs();
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => null },
    });

    await expect(
      downloadSlackFile({
        fileMeta: fileMeta(),
        ...BASE_OPTS,
        fetchImpl: fetch,
        fsImpl,
        root: '/tmp/test-fetch-403',
      }),
    ).rejects.toThrow(/HTTP 403/);

    expect(fsImpl.writeFile).not.toHaveBeenCalled();
  });
});

// ─── downloadSlackFile — token never logged ───────────────────────────────────

describe('downloadSlackFile — token never appears in logger calls', () => {
  it('does not pass the bot token to any logger.warn call', async () => {
    const warnSpy = vi.fn();
    const logger = { warn: warnSpy };

    // Trigger a fetch failure to exercise the logger.warn path.
    const fetch = vi.fn().mockRejectedValue(new Error('network error'));
    const fsImpl = mockFs();

    await expect(
      downloadSlackFile({
        fileMeta: fileMeta(),
        ...BASE_OPTS,
        botToken: 'xoxb-super-secret-token',
        fetchImpl: fetch,
        fsImpl,
        root: '/tmp/test-token-log',
        logger,
      }),
    ).rejects.toThrow();

    for (const call of warnSpy.mock.calls) {
      const msg = call.join(' ');
      expect(msg).not.toContain('xoxb-super-secret-token');
    }
  });
});
