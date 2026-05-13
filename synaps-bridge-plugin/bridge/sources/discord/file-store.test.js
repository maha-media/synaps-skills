/**
 * @file file-store.test.js
 *
 * Tests for downloadDiscordFile and sanitizeFilename.
 * All I/O and network calls are fully mocked; no live filesystem writes.
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { downloadDiscordFile, sanitizeFilename } from './file-store.js';

// ─── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal Discord attachment object. */
function attachment(overrides = {}) {
  return {
    name:        'report.pdf',
    url:         'https://cdn.discordapp.com/attachments/123/456/report.pdf',
    contentType: 'application/pdf',
    size:        1024,
    ...overrides,
  };
}

/** Successful fetch mock returning the given bytes. */
function okFetch(bytes = new Uint8Array([1, 2, 3]).buffer) {
  return vi.fn().mockResolvedValue({
    ok:          true,
    status:      200,
    headers:     { get: (key) => (key === 'content-length' ? String(bytes.byteLength) : null) },
    arrayBuffer: () => Promise.resolve(bytes),
  });
}

/** Mock fs.promises — writes are recorded, not executed. */
function mockFs() {
  return {
    mkdir:     vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
}

const BASE_OPTS = {
  conversation: 'C123',
  thread:       '1234567890',
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
    const result = sanitizeFilename('file\x01name\x1Ftest.txt');
    // eslint-disable-next-line no-control-regex
    expect(result).not.toMatch(/[\x00-\x1F\x7F]/);
  });

  it('truncates names longer than 200 characters', () => {
    const long = 'a'.repeat(250) + '.txt';
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(200);
  });

  it('falls back to "attachment" for an empty string', () => {
    expect(sanitizeFilename('')).toBe('attachment');
  });

  it('falls back to "attachment" for non-string input', () => {
    expect(sanitizeFilename(null)).toBe('attachment');
    expect(sanitizeFilename(undefined)).toBe('attachment');
  });

  it('replaces filesystem-illegal characters (< > : " | ? *)', () => {
    expect(sanitizeFilename('file<name>:test|thing?.txt')).not.toMatch(/[<>:"|?*]/);
  });
});

// ─── downloadDiscordFile — happy path ─────────────────────────────────────────

describe('downloadDiscordFile — happy path', () => {
  it('returns { path, name, mime } with correct values', async () => {
    const result = await downloadDiscordFile({
      attachment: attachment(),
      ...BASE_OPTS,
      fetchImpl: okFetch(),
      fsImpl:    mockFs(),
      root:      '/tmp/discord-test-happy',
    });

    expect(result).toMatchObject({
      path: expect.stringContaining('report.pdf'),
      name: 'report.pdf',
      mime: 'application/pdf',
    });
  });

  it('writes to <root>/<conversation>/<thread>/<sanitizedName>', async () => {
    const fsImpl = mockFs();
    const root   = '/tmp/synaps-discord-root';

    const result = await downloadDiscordFile({
      attachment:   attachment({ name: 'my file.pdf' }),
      conversation: 'C999',
      thread:       '9876543210',
      fetchImpl:    okFetch(),
      fsImpl,
      root,
    });

    const expectedDir = path.join(root, 'C999', '9876543210');
    expect(fsImpl.mkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
    expect(result.path).toContain('C999');
    expect(result.path).toContain('9876543210');
  });

  it('writes the file with mode 0o600', async () => {
    const fsImpl = mockFs();

    await downloadDiscordFile({
      attachment: attachment(),
      ...BASE_OPTS,
      fetchImpl: okFetch(),
      fsImpl,
      root: '/tmp/discord-test-mode',
    });

    expect(fsImpl.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Buffer),
      expect.objectContaining({ mode: 0o600 }),
    );
  });

  it('uses attachment.contentType as mime', async () => {
    const result = await downloadDiscordFile({
      attachment: attachment({ contentType: 'image/png', name: 'shot.png' }),
      ...BASE_OPTS,
      fetchImpl: okFetch(),
      fsImpl:    mockFs(),
      root:      '/tmp/discord-test-mime',
    });

    expect(result.mime).toBe('image/png');
    expect(result.name).toBe('shot.png');
  });

  it('defaults mime to application/octet-stream when contentType is absent', async () => {
    const att = attachment();
    delete att.contentType;

    const result = await downloadDiscordFile({
      attachment: att,
      ...BASE_OPTS,
      fetchImpl: okFetch(),
      fsImpl:    mockFs(),
      root:      '/tmp/discord-test-mime-default',
    });

    expect(result.mime).toBe('application/octet-stream');
  });

  it('fetches with no Authorization header (CDN URLs are pre-signed)', async () => {
    const fetch = okFetch();

    await downloadDiscordFile({
      attachment: attachment(),
      ...BASE_OPTS,
      fetchImpl: fetch,
      fsImpl:    mockFs(),
      root:      '/tmp/discord-test-noauth',
    });

    // fetch must be called with only the URL — no options object at all, or
    // an options object whose headers do not include Authorization.
    const call = fetch.mock.calls[0];
    expect(call).toHaveLength(1); // only the URL argument
  });
});

// ─── downloadDiscordFile — size guard ─────────────────────────────────────────

describe('downloadDiscordFile — size guard', () => {
  it('rejects when attachment.size exceeds maxBytes (no fetch called)', async () => {
    const fetch = vi.fn();

    await expect(
      downloadDiscordFile({
        attachment: attachment({ size: 200 }),
        ...BASE_OPTS,
        fetchImpl: fetch,
        fsImpl:    mockFs(),
        root:      '/tmp/discord-test-size',
        maxBytes:  100,
      }),
    ).rejects.toThrow(/exceeds/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects when actual downloaded bytes exceed maxBytes', async () => {
    const bigBuf = new Uint8Array(500).buffer;
    const fetch  = vi.fn().mockResolvedValue({
      ok:          true,
      status:      200,
      headers:     { get: () => null },
      arrayBuffer: () => Promise.resolve(bigBuf),
    });

    await expect(
      downloadDiscordFile({
        attachment: attachment({ size: 0 }),
        ...BASE_OPTS,
        fetchImpl: fetch,
        fsImpl:    mockFs(),
        root:      '/tmp/discord-test-actual-size',
        maxBytes:  100,
      }),
    ).rejects.toThrow(/exceeds/);
  });
});

// ─── downloadDiscordFile — fetch failure ──────────────────────────────────────

describe('downloadDiscordFile — fetch failure', () => {
  it('throws a clean error when fetch rejects', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      downloadDiscordFile({
        attachment: attachment(),
        ...BASE_OPTS,
        fetchImpl: fetch,
        fsImpl:    mockFs(),
        root:      '/tmp/discord-test-fetch-fail',
      }),
    ).rejects.toThrow(/Fetch failed/);
  });

  it('throws a clean error on non-OK HTTP response', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok:      false,
      status:  403,
      headers: { get: () => null },
    });

    await expect(
      downloadDiscordFile({
        attachment: attachment(),
        ...BASE_OPTS,
        fetchImpl: fetch,
        fsImpl:    mockFs(),
        root:      '/tmp/discord-test-fetch-403',
      }),
    ).rejects.toThrow(/HTTP 403/);
  });
});

// ─── downloadDiscordFile — missing attachment fields ──────────────────────────

describe('downloadDiscordFile — missing attachment fields', () => {
  it('throws when attachment.url is missing', async () => {
    const att = attachment();
    delete att.url;

    await expect(
      downloadDiscordFile({
        attachment: att,
        ...BASE_OPTS,
        fetchImpl: vi.fn().mockRejectedValue(new TypeError("Failed to parse URL 'undefined'")),
        fsImpl:    mockFs(),
        root:      '/tmp/discord-missing-url',
      }),
    ).rejects.toThrow();
  });

  it('falls back to "attachment" filename when attachment.name is missing', async () => {
    const att = attachment();
    delete att.name;

    const result = await downloadDiscordFile({
      attachment: att,
      ...BASE_OPTS,
      fetchImpl: okFetch(),
      fsImpl:    mockFs(),
      root:      '/tmp/discord-missing-name',
    });

    expect(result.name).toBe('attachment');
  });
});
