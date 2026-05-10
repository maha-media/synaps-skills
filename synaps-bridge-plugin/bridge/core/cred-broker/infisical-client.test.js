/**
 * bridge/core/cred-broker/infisical-client.test.js
 *
 * Unit tests for InfisicalClient.
 * All external boundaries (fetch, fs.readFile, logger, now) are mocked via injection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InfisicalClient,
  InfisicalNotFoundError,
  InfisicalAuthError,
  InfisicalUpstreamError,
} from './infisical-client.js';

// ─── test constants ───────────────────────────────────────────────────────────

const BASE_URL    = 'https://infisical.internal';
const TOKEN_FILE  = '/run/secrets/infisical_token';
const FAKE_TOKEN  = 'st.abc123xyz.secret-service-token';
const INSTITUTION = 'inst_acme';
const USER_ID     = 'u_alice';
const KEY         = 'github.token';

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a mock fs object.  By default readFile resolves with FAKE_TOKEN + '\n'.
 */
function makeFsMock({ content = `${FAKE_TOKEN}\n`, rejects = null } = {}) {
  const readFile = rejects
    ? vi.fn().mockRejectedValue(rejects)
    : vi.fn().mockResolvedValue(content);
  return { readFile };
}

/**
 * Build a mock Response as returned by fetch.
 */
function makeResponse({ status = 200, body = null, jsonThrows = false } = {}) {
  const json = jsonThrows
    ? vi.fn().mockRejectedValue(new SyntaxError('Unexpected token'))
    : vi.fn().mockResolvedValue(body);
  return { status, json, headers: {} };
}

/**
 * Build a successful secret response body.
 */
function secretBody(value = 'ghp_abc123') {
  return { secret: { secretValue: value } };
}

/**
 * Convenience: construct an InfisicalClient with full mocks.
 */
function makeClient({
  baseUrl         = BASE_URL,
  tokenFile       = TOKEN_FILE,
  fetchMock       = vi.fn(),
  fsMock          = makeFsMock(),
  nowMock         = vi.fn().mockReturnValue(1_700_000_000_000),
  logger          = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  auditAttributeUser = true,
} = {}) {
  const client = new InfisicalClient({
    baseUrl,
    tokenFile,
    fetch:             fetchMock,
    fs:                fsMock,
    logger,
    now:               nowMock,
    auditAttributeUser,
  });
  return { client, fetchMock, fsMock, logger, nowMock };
}

// ─── Constructor ─────────────────────────────────────────────────────────────

describe('InfisicalClient — constructor', () => {
  it('throws TypeError when baseUrl is missing', () => {
    expect(() => new InfisicalClient({ tokenFile: TOKEN_FILE })).toThrow(
      TypeError,
    );
    expect(() => new InfisicalClient({ tokenFile: TOKEN_FILE })).toThrow(
      /baseUrl/,
    );
  });

  it('throws TypeError when tokenFile is missing', () => {
    expect(() => new InfisicalClient({ baseUrl: BASE_URL })).toThrow(TypeError);
    expect(() => new InfisicalClient({ baseUrl: BASE_URL })).toThrow(
      /tokenFile/,
    );
  });

  it('does NOT throw when both baseUrl and tokenFile are provided', () => {
    expect(
      () => new InfisicalClient({ baseUrl: BASE_URL, tokenFile: TOKEN_FILE }),
    ).not.toThrow();
  });

  it('does not perform any I/O in the constructor', () => {
    const fsMock = makeFsMock();
    // eslint-disable-next-line no-new
    new InfisicalClient({
      baseUrl:   BASE_URL,
      tokenFile: TOKEN_FILE,
      fs:        fsMock,
    });
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it('uses sensible defaults for fetch/fs/logger/now (no throw)', () => {
    // Just instantiate with the bare minimum; Node 20 has globalThis.fetch.
    expect(
      () => new InfisicalClient({ baseUrl: BASE_URL, tokenFile: TOKEN_FILE }),
    ).not.toThrow();
  });
});

// ─── Token file behaviour ─────────────────────────────────────────────────────

describe('InfisicalClient — token file', () => {
  it('reads token lazily: NOT on construction but on first getSecret()', async () => {
    const fsMock    = makeFsMock();
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fsMock, fetchMock });

    // Not yet read
    expect(fsMock.readFile).not.toHaveBeenCalled();

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    expect(fsMock.readFile).toHaveBeenCalledTimes(1);
    expect(fsMock.readFile).toHaveBeenCalledWith(TOKEN_FILE, 'utf8');
  });

  it('reads token only once across multiple getSecret() calls', async () => {
    const fsMock    = makeFsMock();
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fsMock, fetchMock });

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });
    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });
    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    expect(fsMock.readFile).toHaveBeenCalledTimes(1);
  });

  it('trims trailing newline from token', async () => {
    const fsMock    = makeFsMock({ content: `${FAKE_TOKEN}\n` });
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fsMock, fetchMock });

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    // The Authorization header must use the trimmed token
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(opts.headers.Authorization).not.toContain('\n');
  });

  it('throws InfisicalAuthError when token file is not found', async () => {
    const notFound = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fsMock   = makeFsMock({ rejects: notFound });
    const { client } = makeClient({ fsMock });

    await expect(
      client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY }),
    ).rejects.toBeInstanceOf(InfisicalAuthError);

    await expect(
      client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY }),
    ).rejects.toThrow(/failed to read token file/);
  });

  it('includes token file path in InfisicalAuthError message', async () => {
    const notFound   = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const customPath = '/custom/secret/token';
    const fsMock     = makeFsMock({ rejects: notFound });
    const { client } = makeClient({ fsMock, tokenFile: customPath });

    const err = await client
      .getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY })
      .catch((e) => e);

    expect(err.message).toContain(customPath);
  });

  it('reloadToken() forces a re-read from disk', async () => {
    const fsMock    = makeFsMock();
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fsMock, fetchMock });

    // First read
    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });
    expect(fsMock.readFile).toHaveBeenCalledTimes(1);

    // Reload should re-read
    await client.reloadToken();
    expect(fsMock.readFile).toHaveBeenCalledTimes(2);

    // Next getSecret should NOT read again (already cached from reload)
    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });
    expect(fsMock.readFile).toHaveBeenCalledTimes(2);
  });
});

// ─── getSecret() happy path ───────────────────────────────────────────────────

describe('InfisicalClient — getSecret() happy path', () => {
  it('returns { value, fetchedAt } on a 200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody('ghp_abc123') }),
    );
    const nowMock = vi.fn().mockReturnValue(1_700_000_000_123);
    const { client } = makeClient({ fetchMock, nowMock });

    const result = await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    expect(result).toEqual({ value: 'ghp_abc123', fetchedAt: 1_700_000_000_123 });
  });

  it('sends Authorization: Bearer <token> header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fetchMock });

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('sends User-Agent synaps-cred-broker/<synapsUserId> when auditAttributeUser=true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fetchMock, auditAttributeUser: true });

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['User-Agent']).toBe(`synaps-cred-broker/${USER_ID}`);
  });

  it('sends generic User-Agent without userId when auditAttributeUser=false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fetchMock, auditAttributeUser: false });

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['User-Agent']).toBe('synaps-cred-broker');
    expect(opts.headers['User-Agent']).not.toContain(USER_ID);
  });

  it('URL contains workspaceId=<institutionId>', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fetchMock });

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain(`workspaceId=${INSTITUTION}`);
  });

  it('URL contains secretPath=/users/<synapsUserId>', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fetchMock });

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    const [url] = fetchMock.mock.calls[0];
    // URLSearchParams encodes / as %2F
    expect(url).toContain(`secretPath=%2Fusers%2F${USER_ID}`);
  });

  it('URL contains secretName=<key>', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fetchMock });

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain(`secretName=${encodeURIComponent(KEY)}`);
  });

  it('URL contains type=shared', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fetchMock });

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('type=shared');
  });

  it('encodes dots in key (e.g. slack.bot.token)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody('xoxb-bot') }),
    );
    const { client } = makeClient({ fetchMock });

    await client.getSecret({
      institutionId: INSTITUTION,
      synapsUserId:  USER_ID,
      key:           'slack.bot.token',
    });

    const [url] = fetchMock.mock.calls[0];
    // URLSearchParams encodes dots as-is (dots are safe in query values), but
    // what matters is the name is present in the URL at all.
    expect(url).toContain('slack.bot.token');
  });

  it('percent-encodes special chars in synapsUserId', async () => {
    const specialId = 'user@domain+test';
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fetchMock });

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: specialId, key: KEY });

    const [url] = fetchMock.mock.calls[0];
    // URLSearchParams encodes @ → %40, + → %2B, / → %2F
    // The secretPath param must contain the encoded userId within the encoded path
    expect(url).toContain('secretPath=');
    // Raw @ and + must not appear literally in the URL query string
    const queryString = url.split('?')[1] ?? '';
    expect(queryString).not.toContain('user@domain+test');
    // The encoded form of @ (%40) must be present
    expect(queryString).toContain('%40');
  });

  it('uses GET method', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fetchMock });

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe('GET');
  });
});

// ─── getSecret() error mapping ────────────────────────────────────────────────

describe('InfisicalClient — getSecret() error mapping', () => {
  it('404 → InfisicalNotFoundError with secret name in message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ status: 404 }));
    const { client } = makeClient({ fetchMock });

    const err = await client
      .getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY })
      .catch((e) => e);

    expect(err).toBeInstanceOf(InfisicalNotFoundError);
    expect(err.code).toBe('secret_not_found');
    expect(err.message).toContain(KEY);
  });

  it('401 → InfisicalAuthError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ status: 401 }));
    const { client } = makeClient({ fetchMock });

    const err = await client
      .getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY })
      .catch((e) => e);

    expect(err).toBeInstanceOf(InfisicalAuthError);
    expect(err.code).toBe('broker_auth_failed');
    expect(err.message).toContain('401');
  });

  it('403 → InfisicalAuthError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ status: 403 }));
    const { client } = makeClient({ fetchMock });

    const err = await client
      .getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY })
      .catch((e) => e);

    expect(err).toBeInstanceOf(InfisicalAuthError);
    expect(err.code).toBe('broker_auth_failed');
    expect(err.message).toContain('403');
  });

  it('500 → InfisicalUpstreamError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ status: 500 }));
    const { client } = makeClient({ fetchMock });

    const err = await client
      .getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY })
      .catch((e) => e);

    expect(err).toBeInstanceOf(InfisicalUpstreamError);
    expect(err.code).toBe('broker_upstream');
  });

  it('502 → InfisicalUpstreamError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ status: 502 }));
    const { client } = makeClient({ fetchMock });

    const err = await client
      .getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY })
      .catch((e) => e);

    expect(err).toBeInstanceOf(InfisicalUpstreamError);
    expect(err.code).toBe('broker_upstream');
  });

  it('network error (fetch throws) → InfisicalUpstreamError', async () => {
    const netErr    = new Error('ECONNREFUSED');
    const fetchMock = vi.fn().mockRejectedValue(netErr);
    const { client } = makeClient({ fetchMock });

    const err = await client
      .getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY })
      .catch((e) => e);

    expect(err).toBeInstanceOf(InfisicalUpstreamError);
    expect(err.code).toBe('broker_upstream');
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('malformed JSON body → InfisicalUpstreamError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, jsonThrows: true }),
    );
    const { client } = makeClient({ fetchMock });

    const err = await client
      .getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY })
      .catch((e) => e);

    expect(err).toBeInstanceOf(InfisicalUpstreamError);
    expect(err.message).toContain('malformed response');
  });

  it('missing secret.secretValue in body → InfisicalUpstreamError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: { secret: {} } }),
    );
    const { client } = makeClient({ fetchMock });

    const err = await client
      .getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY })
      .catch((e) => e);

    expect(err).toBeInstanceOf(InfisicalUpstreamError);
    expect(err.message).toContain('malformed response');
  });

  it('null body → InfisicalUpstreamError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: null }),
    );
    const { client } = makeClient({ fetchMock });

    const err = await client
      .getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY })
      .catch((e) => e);

    expect(err).toBeInstanceOf(InfisicalUpstreamError);
  });
});

// ─── Logging — token-leak audit ───────────────────────────────────────────────

describe('InfisicalClient — logging token-leak audit', () => {
  /**
   * Collect every argument passed to any logger method into a flat string
   * so we can search for the raw token value.
   */
  function captureLogArgs(logger) {
    const allArgs = [];
    for (const method of ['info', 'warn', 'error', 'debug']) {
      vi.spyOn(logger, method).mockImplementation((...args) => {
        allArgs.push(JSON.stringify(args));
      });
    }
    return allArgs;
  }

  it('token value NEVER appears in any logger call', async () => {
    const logger    = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fetchMock, logger });
    const allArgs    = captureLogArgs(logger);

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    const combined = allArgs.join('\n');
    expect(combined).not.toContain(FAKE_TOKEN);
  });

  it('Authorization header (Bearer <token>) NEVER appears verbatim in logs', async () => {
    const logger    = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fetchMock, logger });
    const allArgs    = captureLogArgs(logger);

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    const combined = allArgs.join('\n');
    expect(combined).not.toContain(`Bearer ${FAKE_TOKEN}`);
  });

  it('token value NEVER appears in logs even on network error path', async () => {
    const logger    = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { client } = makeClient({ fetchMock, logger });
    const allArgs    = captureLogArgs(logger);

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY }).catch(() => {});

    const combined = allArgs.join('\n');
    expect(combined).not.toContain(FAKE_TOKEN);
  });

  it('uses <redacted:N chars> placeholder in Authorization log field', async () => {
    const logger    = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 200, body: secretBody() }),
    );
    const { client } = makeClient({ fetchMock, logger });
    const allArgs    = captureLogArgs(logger);

    await client.getSecret({ institutionId: INSTITUTION, synapsUserId: USER_ID, key: KEY });

    const combined = allArgs.join('\n');
    expect(combined).toContain('<redacted:');
    // Length should match actual token length
    expect(combined).toContain(`<redacted:${FAKE_TOKEN.length} chars>`);
  });
});

// ─── ping() ──────────────────────────────────────────────────────────────────

describe('InfisicalClient — ping()', () => {
  it('2xx → { ok: true, status: 200 }', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, headers: {} });
    const { client } = makeClient({ fetchMock });

    const result = await client.ping();

    expect(result).toEqual({ ok: true, status: 200 });
  });

  it('uses HEAD method to /api/status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, headers: {} });
    const { client } = makeClient({ fetchMock });

    await client.ping();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe('HEAD');
    expect(url).toBe(`${BASE_URL}/api/status`);
  });

  it('503 → { ok: false, status: 503, error: ... }', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 503, headers: {} });
    const { client } = makeClient({ fetchMock });

    const result = await client.ping();

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(typeof result.error).toBe('string');
  });

  it('network error → { ok: false, error: ... }', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { client } = makeClient({ fetchMock });

    const result = await client.ping();

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('ECONNREFUSED');
  });
});
