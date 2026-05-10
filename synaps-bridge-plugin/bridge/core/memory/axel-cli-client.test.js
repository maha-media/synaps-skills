/**
 * bridge/core/memory/axel-cli-client.test.js
 *
 * Unit tests for AxelCliClient.
 * All external boundaries (execFile, fs) are mocked via injection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxelCliClient } from './axel-cli-client.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock fs/promises object.
 * By default access resolves (file exists) and mkdir resolves.
 */
function makeFsMock({ accessRejects = null, mkdirRejects = null } = {}) {
  const constants = { F_OK: 0 };

  const access = accessRejects
    ? vi.fn().mockRejectedValue(accessRejects)
    : vi.fn().mockResolvedValue(undefined);

  const mkdir = mkdirRejects
    ? vi.fn().mockRejectedValue(mkdirRejects)
    : vi.fn().mockResolvedValue(undefined);

  return { access, mkdir, constants };
}

/**
 * Build a mock execFile that resolves with the given stdout/stderr.
 */
function makeExecMock(stdout = '', stderr = '') {
  return vi.fn().mockResolvedValue({ stdout, stderr });
}

/**
 * Convenience: construct a client with full mocks.
 */
function makeClient({
  execFileMock = makeExecMock(),
  fsMock = makeFsMock(),
  defaultTimeoutMs = 30_000,
  logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
} = {}) {
  const client = new AxelCliClient({
    cliPath: 'axel',
    logger,
    execFile: execFileMock,
    fs: fsMock,
    defaultTimeoutMs,
  });
  return { client, execFileMock, fsMock, logger };
}

const BRAIN = '/absolute/path/brain.r8';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('AxelCliClient — brainPath validation', () => {
  it('throws TypeError for relative brainPath in init()', async () => {
    const { client } = makeClient();
    await expect(client.init('relative/brain.r8')).rejects.toThrow(
      TypeError,
    );
    await expect(client.init('relative/brain.r8')).rejects.toThrow(
      'brainPath must be an absolute path',
    );
  });

  it('throws TypeError for relative brainPath in search()', async () => {
    const { client } = makeClient();
    await expect(client.search('not/absolute.r8', 'query')).rejects.toThrow(
      TypeError,
    );
  });

  it('throws TypeError for relative brainPath in remember()', async () => {
    const { client } = makeClient();
    await expect(client.remember('not/absolute.r8', 'hello')).rejects.toThrow(
      TypeError,
    );
  });

  it('throws TypeError for relative brainPath in consolidate()', async () => {
    const { client } = makeClient();
    await expect(client.consolidate('not/absolute.r8')).rejects.toThrow(
      TypeError,
    );
  });

  it('throws TypeError for relative brainPath in exists()', async () => {
    const { client } = makeClient();
    await expect(client.exists('not/absolute.r8')).rejects.toThrow(TypeError);
  });
});

// ─── exists() ────────────────────────────────────────────────────────────────

describe('AxelCliClient — exists()', () => {
  it('returns true when fs.access resolves', async () => {
    const fsMock = makeFsMock(); // access resolves by default
    const { client } = makeClient({ fsMock });
    const result = await client.exists(BRAIN);
    expect(result).toBe(true);
    expect(fsMock.access).toHaveBeenCalledWith(BRAIN, fsMock.constants.F_OK);
  });

  it('returns false when fs.access rejects with ENOENT', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fsMock = makeFsMock({ accessRejects: enoent });
    const { client } = makeClient({ fsMock });
    const result = await client.exists(BRAIN);
    expect(result).toBe(false);
  });

  it('re-throws non-ENOENT errors from fs.access', async () => {
    const permErr = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const fsMock = makeFsMock({ accessRejects: permErr });
    const { client } = makeClient({ fsMock });
    await expect(client.exists(BRAIN)).rejects.toThrow('EACCES');
  });
});

// ─── init() ──────────────────────────────────────────────────────────────────

describe('AxelCliClient — init()', () => {
  it('calls execFile with init args when brain does NOT exist', async () => {
    // access rejects with ENOENT → file doesn't exist
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fsMock = makeFsMock({ accessRejects: enoent });
    const execFileMock = makeExecMock();
    const { client } = makeClient({ fsMock, execFileMock });

    const result = await client.init(BRAIN);

    expect(result).toEqual({ ok: true, created: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args] = execFileMock.mock.calls[0];
    expect(file).toBe('axel');
    expect(args).toEqual(['init', '--name', 'synaps-user']);
  });

  it('is idempotent: does NOT call execFile when brain already exists', async () => {
    const fsMock = makeFsMock(); // access resolves → exists
    const execFileMock = makeExecMock();
    const { client } = makeClient({ fsMock, execFileMock });

    const result = await client.init(BRAIN);

    expect(result).toEqual({ ok: true, created: false });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('calls mkdir with { recursive: true } on the parent directory', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fsMock = makeFsMock({ accessRejects: enoent });
    const { client } = makeClient({ fsMock });

    await client.init('/some/deep/dir/brain.r8');

    expect(fsMock.mkdir).toHaveBeenCalledWith('/some/deep/dir', {
      recursive: true,
    });
  });

  it('uses a custom name when provided', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fsMock = makeFsMock({ accessRejects: enoent });
    const execFileMock = makeExecMock();
    const { client } = makeClient({ fsMock, execFileMock });

    await client.init(BRAIN, { name: 'my-agent' });

    const [, args] = execFileMock.mock.calls[0];
    expect(args).toContain('--name');
    expect(args).toContain('my-agent');
  });

  it('sets AXEL_BRAIN env on init call', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fsMock = makeFsMock({ accessRejects: enoent });
    const execFileMock = makeExecMock();
    const { client } = makeClient({ fsMock, execFileMock });

    await client.init(BRAIN);

    const [, , opts] = execFileMock.mock.calls[0];
    expect(opts.env.AXEL_BRAIN).toBe(BRAIN);
  });
});

// ─── search() ────────────────────────────────────────────────────────────────

describe('AxelCliClient — search()', () => {
  it('happy path: parses JSON array and returns it', async () => {
    const payload = [{ id: '1', content: 'foo', score: 0.9 }];
    const execFileMock = makeExecMock(JSON.stringify(payload));
    const { client } = makeClient({ execFileMock });

    const result = await client.search(BRAIN, 'rust async');
    expect(result).toEqual(payload);
  });

  it('returns [] when stdout is empty', async () => {
    const execFileMock = makeExecMock('');
    const { client } = makeClient({ execFileMock });

    const result = await client.search(BRAIN, 'anything');
    expect(result).toEqual([]);
  });

  it('returns [] when stdout is whitespace-only', async () => {
    const execFileMock = makeExecMock('   \n  ');
    const { client } = makeClient({ execFileMock });

    const result = await client.search(BRAIN, 'anything');
    expect(result).toEqual([]);
  });

  it('returns [] and calls logger.warn when stdout is invalid JSON', async () => {
    const execFileMock = makeExecMock('not-json');
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { client } = makeClient({ execFileMock, logger });

    const result = await client.search(BRAIN, 'anything');
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('builds default args correctly: [search, query, --limit, 8, --json]', async () => {
    const execFileMock = makeExecMock('[]');
    const { client } = makeClient({ execFileMock });

    await client.search(BRAIN, 'my query');

    const [file, args] = execFileMock.mock.calls[0];
    expect(file).toBe('axel');
    expect(args).toEqual(['search', 'my query', '--limit', '8', '--json']);
  });

  it('honours custom k: passes --limit 16', async () => {
    const execFileMock = makeExecMock('[]');
    const { client } = makeClient({ execFileMock });

    await client.search(BRAIN, 'query', { k: 16 });

    const [, args] = execFileMock.mock.calls[0];
    expect(args).toContain('--limit');
    expect(args).toContain('16');
    expect(args).not.toContain('8');
  });

  it('sets AXEL_BRAIN env on every search call', async () => {
    const execFileMock = makeExecMock('[]');
    const { client } = makeClient({ execFileMock });

    await client.search(BRAIN, 'query');

    const [, , opts] = execFileMock.mock.calls[0];
    expect(opts.env.AXEL_BRAIN).toBe(BRAIN);
  });
});

// ─── remember() ──────────────────────────────────────────────────────────────

describe('AxelCliClient — remember()', () => {
  it('happy path: calls execFile with [remember, content]', async () => {
    const execFileMock = makeExecMock('');
    const { client } = makeClient({ execFileMock });

    const result = await client.remember(BRAIN, 'My memory text');

    expect(result).toEqual({ ok: true });
    const [file, args] = execFileMock.mock.calls[0];
    expect(file).toBe('axel');
    expect(args[0]).toBe('remember');
    expect(args[1]).toBe('My memory text');
  });

  it('appends --category and --topic flags when provided', async () => {
    const execFileMock = makeExecMock('');
    const { client } = makeClient({ execFileMock });

    await client.remember(BRAIN, 'text', {
      category: 'prefs',
      topic: 'stack',
    });

    const [, args] = execFileMock.mock.calls[0];
    expect(args).toContain('--category');
    expect(args).toContain('prefs');
    expect(args).toContain('--topic');
    expect(args).toContain('stack');
  });

  it('throws TypeError synchronously for empty content string', async () => {
    const { client } = makeClient();
    await expect(client.remember(BRAIN, '')).rejects.toThrow(TypeError);
  });

  it('throws TypeError for whitespace-only content', async () => {
    const { client } = makeClient();
    await expect(client.remember(BRAIN, '   ')).rejects.toThrow(TypeError);
  });

  it('throws TypeError for non-string content', async () => {
    const { client } = makeClient();
    await expect(client.remember(BRAIN, 42)).rejects.toThrow(TypeError);
  });

  it('propagates axel non-zero exit as Error with code and stderr props', async () => {
    const execErr = Object.assign(new Error('axel failed'), {
      code: 1,
      stderr: 'some error output',
      stdout: '',
    });
    const execFileMock = vi.fn().mockRejectedValue(execErr);
    const { client } = makeClient({ execFileMock });

    const err = await client.remember(BRAIN, 'valid content').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/axel remember failed/);
    expect(err.message).toMatch(/exit 1/);
    expect(err.code).toBe(1);
    expect(err.stderr).toBe('some error output');
  });

  it('sets AXEL_BRAIN env on remember call', async () => {
    const execFileMock = makeExecMock('');
    const { client } = makeClient({ execFileMock });

    await client.remember(BRAIN, 'content');

    const [, , opts] = execFileMock.mock.calls[0];
    expect(opts.env.AXEL_BRAIN).toBe(BRAIN);
  });
});

// ─── consolidate() ───────────────────────────────────────────────────────────

describe('AxelCliClient — consolidate()', () => {
  it('happy path: parses JSON output into summary', async () => {
    const summaryData = { phases: 4, pruned: 2 };
    const execFileMock = makeExecMock(JSON.stringify(summaryData));
    const { client } = makeClient({ execFileMock });

    const result = await client.consolidate(BRAIN);

    expect(result).toEqual({ ok: true, summary: summaryData });
  });

  it('passes --dry-run flag when dryRun=true', async () => {
    const execFileMock = makeExecMock('{}');
    const { client } = makeClient({ execFileMock });

    await client.consolidate(BRAIN, { dryRun: true });

    const [, args] = execFileMock.mock.calls[0];
    expect(args).toContain('--dry-run');
  });

  it('does NOT pass --dry-run by default', async () => {
    const execFileMock = makeExecMock('{}');
    const { client } = makeClient({ execFileMock });

    await client.consolidate(BRAIN);

    const [, args] = execFileMock.mock.calls[0];
    expect(args).not.toContain('--dry-run');
  });

  it('always passes --json', async () => {
    const execFileMock = makeExecMock('{}');
    const { client } = makeClient({ execFileMock });

    await client.consolidate(BRAIN);

    const [, args] = execFileMock.mock.calls[0];
    expect(args).toContain('--json');
  });

  it('sets AXEL_BRAIN env on consolidate call', async () => {
    const execFileMock = makeExecMock('{}');
    const { client } = makeClient({ execFileMock });

    await client.consolidate(BRAIN);

    const [, , opts] = execFileMock.mock.calls[0];
    expect(opts.env.AXEL_BRAIN).toBe(BRAIN);
  });

  it('returns { ok: true } without summary when output is empty', async () => {
    const execFileMock = makeExecMock('');
    const { client } = makeClient({ execFileMock });

    const result = await client.consolidate(BRAIN);
    expect(result).toEqual({ ok: true });
  });
});

// ─── Timeout handling ─────────────────────────────────────────────────────────

describe('AxelCliClient — timeout', () => {
  it('surfaces SIGTERM rejection as "timed out" error on search', async () => {
    const timeoutErr = Object.assign(new Error('timeout'), {
      signal: 'SIGTERM',
    });
    const execFileMock = vi.fn().mockRejectedValue(timeoutErr);
    const { client } = makeClient({ execFileMock, defaultTimeoutMs: 5_000 });

    const err = await client.search(BRAIN, 'query').catch((e) => e);
    expect(err.message).toMatch(/timed out/);
    expect(err.message).toMatch(/5000ms/);
  });

  it('surfaces SIGTERM rejection as "timed out" error on remember', async () => {
    const timeoutErr = Object.assign(new Error('timeout'), {
      signal: 'SIGTERM',
    });
    const execFileMock = vi.fn().mockRejectedValue(timeoutErr);
    const { client } = makeClient({ execFileMock });

    const err = await client.remember(BRAIN, 'content').catch((e) => e);
    expect(err.message).toMatch(/timed out/);
  });

  it('surfaces SIGTERM rejection as "timed out" error on consolidate', async () => {
    const timeoutErr = Object.assign(new Error('timeout'), {
      signal: 'SIGTERM',
    });
    const execFileMock = vi.fn().mockRejectedValue(timeoutErr);
    const { client } = makeClient({ execFileMock });

    const err = await client.consolidate(BRAIN).catch((e) => e);
    expect(err.message).toMatch(/timed out/);
  });

  it('passes timeout option to execFile', async () => {
    const execFileMock = makeExecMock('[]');
    const { client } = makeClient({ execFileMock, defaultTimeoutMs: 12_345 });

    await client.search(BRAIN, 'q');

    const [, , opts] = execFileMock.mock.calls[0];
    expect(opts.timeout).toBe(12_345);
  });
});

// ─── Shell safety ─────────────────────────────────────────────────────────────

describe('AxelCliClient — shell safety', () => {
  it('does not set shell:true in execFile options', async () => {
    const execFileMock = makeExecMock('[]');
    const { client } = makeClient({ execFileMock });

    await client.search(BRAIN, 'query');

    const [, , opts] = execFileMock.mock.calls[0];
    expect(opts.shell).not.toBe(true);
  });

  it('does not include a shell property at all in options', async () => {
    const execFileMock = makeExecMock('[]');
    const { client } = makeClient({ execFileMock });

    await client.search(BRAIN, 'query');

    const [, , opts] = execFileMock.mock.calls[0];
    expect(Object.prototype.hasOwnProperty.call(opts, 'shell')).toBe(false);
  });
});

// ─── AXEL_BRAIN on every call ─────────────────────────────────────────────────

describe('AxelCliClient — AXEL_BRAIN env', () => {
  it('is set to brainPath on init', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fsMock = makeFsMock({ accessRejects: enoent });
    const execFileMock = makeExecMock('');
    const { client } = makeClient({ fsMock, execFileMock });

    await client.init(BRAIN);

    const [, , opts] = execFileMock.mock.calls[0];
    expect(opts.env.AXEL_BRAIN).toBe(BRAIN);
  });

  it('is set to brainPath on search', async () => {
    const execFileMock = makeExecMock('[]');
    const { client } = makeClient({ execFileMock });

    await client.search(BRAIN, 'q');

    const [, , opts] = execFileMock.mock.calls[0];
    expect(opts.env.AXEL_BRAIN).toBe(BRAIN);
  });

  it('is set to brainPath on remember', async () => {
    const execFileMock = makeExecMock('');
    const { client } = makeClient({ execFileMock });

    await client.remember(BRAIN, 'text');

    const [, , opts] = execFileMock.mock.calls[0];
    expect(opts.env.AXEL_BRAIN).toBe(BRAIN);
  });

  it('is set to brainPath on consolidate', async () => {
    const execFileMock = makeExecMock('{}');
    const { client } = makeClient({ execFileMock });

    await client.consolidate(BRAIN);

    const [, , opts] = execFileMock.mock.calls[0];
    expect(opts.env.AXEL_BRAIN).toBe(BRAIN);
  });
});
