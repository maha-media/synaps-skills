/**
 * @file bridge/core/vnc-proxy.test.js
 *
 * Tests for VncProxy — reverse-proxy for KasmVNC workspaces.
 *
 * Uses vi.fn() / injectable httpRequestFn to avoid real network I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { VncProxy } from './vnc-proxy.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Build a minimal fake WorkspaceRepo.
 * @param {object|null} workspace - What byId() should return.
 * @param {Error|null}  [error]   - If set, byId() rejects with this error.
 */
function makeRepo(workspace = null, error = null) {
  return {
    byId: vi.fn(async () => {
      if (error) throw error;
      return workspace;
    }),
  };
}

/**
 * Build a minimal fake IncomingMessage-like request.
 */
function makeReq({ url = '/vnc/ws-1', method = 'GET', headers = {} } = {}) {
  const req = new EventEmitter();
  req.url     = url;
  req.method  = method;
  req.headers = headers;
  req.httpVersion = '1.1';
  req.pipe = vi.fn((dest) => dest);
  return req;
}

/**
 * Build a minimal fake ServerResponse-like object.
 */
function makeRes() {
  const res = {
    headersSent:  false,
    statusCode:   null,
    headers:      {},
    body:         '',
    writeHead:    vi.fn(function (code, hdrs) {
      this.statusCode  = code;
      this.headers     = hdrs || {};
      this.headersSent = true;
    }),
    end:          vi.fn(function (body) { this.body = body || ''; }),
    write:        vi.fn(),
  };
  return res;
}

/**
 * Build a minimal fake net.Socket-like object.
 */
function makeSocket() {
  const s = new EventEmitter();
  s.write   = vi.fn();
  s.destroy = vi.fn();
  s.pipe    = vi.fn((dest) => dest);
  return s;
}

/**
 * Build a fake http.request that immediately emits 'error'.
 */
function makeErrRequestFn(errMsg = 'ECONNREFUSED') {
  return vi.fn((_opts, _cb) => {
    const req = new EventEmitter();
    req.end  = vi.fn();
    req.write = vi.fn();
    setImmediate(() => req.emit('error', new Error(errMsg)));
    return req;
  });
}

/**
 * Build a fake http.request that calls back with a successful response.
 * @param {number} statusCode
 * @param {object} headers
 * @param {string} body
 */
function makeOkRequestFn(statusCode = 200, headers = { 'content-type': 'text/html' }, body = 'hello') {
  return vi.fn((opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers    = headers;
    res.pipe = vi.fn((dest) => {
      // Simulate piping: push data, then end
      setImmediate(() => {
        dest.write && dest.write(body);
        dest.end   && dest.end();
      });
      return dest;
    });
    setImmediate(() => cb(res));
    const req = new EventEmitter();
    req.end  = vi.fn();
    req.write = vi.fn();
    return req;
  });
}

// ─── VncProxy.parsePath ───────────────────────────────────────────────────────

describe('VncProxy.parsePath', () => {
  it('parses basic /vnc/<id>', () => {
    const result = VncProxy.parsePath('/vnc/abc123');
    expect(result).toEqual({ workspaceId: 'abc123', restPath: '/' });
  });

  it('parses /vnc/<id>/ (trailing slash)', () => {
    const result = VncProxy.parsePath('/vnc/abc123/');
    expect(result).toEqual({ workspaceId: 'abc123', restPath: '/' });
  });

  it('parses /vnc/<id>/some/deeper/path', () => {
    const result = VncProxy.parsePath('/vnc/abc123/some/deeper/path');
    expect(result).toEqual({ workspaceId: 'abc123', restPath: '/some/deeper/path' });
  });

  it('preserves query string in restPath', () => {
    const result = VncProxy.parsePath('/vnc/abc123/frame?token=xyz&scale=1');
    expect(result).toEqual({ workspaceId: 'abc123', restPath: '/frame?token=xyz&scale=1' });
  });

  it('handles /vnc/<id> with query string but no sub-path', () => {
    const result = VncProxy.parsePath('/vnc/abc123?foo=bar');
    expect(result).toEqual({ workspaceId: 'abc123', restPath: '/?foo=bar' });
  });

  it('returns null for /vnc/ (no id)', () => {
    expect(VncProxy.parsePath('/vnc/')).toBeNull();
  });

  it('returns null for /vnc (no slash after)', () => {
    expect(VncProxy.parsePath('/vnc')).toBeNull();
  });

  it('returns null for unrelated path', () => {
    expect(VncProxy.parsePath('/health')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(VncProxy.parsePath('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(VncProxy.parsePath(null)).toBeNull();
    expect(VncProxy.parsePath(undefined)).toBeNull();
    expect(VncProxy.parsePath(42)).toBeNull();
  });

  it('handles ObjectId-style workspace_id', () => {
    const result = VncProxy.parsePath('/vnc/507f1f77bcf86cd799439011/vnc.html');
    expect(result).toEqual({ workspaceId: '507f1f77bcf86cd799439011', restPath: '/vnc.html' });
  });
});

// ─── middleware() — 401 when header missing ────────────────────────────────

describe('VncProxy.middleware — 401 when x-synaps-user-id missing', () => {
  it('returns 401 when header is absent, workspace exists', async () => {
    const workspace = { _id: 'ws-1', synaps_user_id: 'user-1', vnc_url: 'http://10.0.0.2:6901' };
    const proxy = new VncProxy({ repo: makeRepo(workspace), logger: makeLogger() });
    const handler = proxy.middleware();

    const req = makeReq({ url: '/vnc/ws-1', headers: {} });
    const res = makeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.error).toBe('unauthorized');
  });
});

// ─── middleware() — 404 for unknown workspace ──────────────────────────────

describe('VncProxy.middleware — 404 for unknown workspace', () => {
  it('returns 404 when repo.byId returns null', async () => {
    const proxy = new VncProxy({
      repo:   makeRepo(null),
      logger: makeLogger(),
    });
    const handler = proxy.middleware();

    const req = makeReq({
      url:     '/vnc/does-not-exist',
      headers: { 'x-synaps-user-id': 'user-1' },
    });
    const res  = makeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(res.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.error).toBe('not_found');
  });
});

// ─── middleware() — 403 when user doesn't own workspace ────────────────────

describe('VncProxy.middleware — 403 when claimed user != workspace owner', () => {
  it('returns 403 when x-synaps-user-id does not match workspace.synaps_user_id', async () => {
    const workspace = { _id: 'ws-1', synaps_user_id: 'owner-99', vnc_url: 'http://10.0.0.2:6901' };
    const proxy = new VncProxy({ repo: makeRepo(workspace), logger: makeLogger() });
    const handler = proxy.middleware();

    const req = makeReq({
      url:     '/vnc/ws-1',
      headers: { 'x-synaps-user-id': 'attacker-42' },
    });
    const res  = makeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('forbidden');
  });
});

// ─── middleware() — 502 when upstream fails ────────────────────────────────

describe('VncProxy.middleware — 502 when upstream request errors', () => {
  it('returns 502 when httpRequestFn emits error', async () => {
    const workspace = { _id: 'ws-1', synaps_user_id: 'user-1', vnc_url: 'http://10.0.0.2:6901' };
    const proxy = new VncProxy({
      repo:           makeRepo(workspace),
      logger:         makeLogger(),
      httpRequestFn:  makeErrRequestFn('ECONNREFUSED'),
    });
    const handler = proxy.middleware();

    const req = makeReq({
      url:     '/vnc/ws-1',
      headers: { 'x-synaps-user-id': 'user-1' },
    });
    const res  = makeRes();
    const next = vi.fn();

    await handler(req, res, next);
    // The error is async so we allow one tick
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('bad_gateway');
  });
});

// ─── middleware() — 200 happy path ────────────────────────────────────────

describe('VncProxy.middleware — 200 happy path', () => {
  it('pipes upstream response through when everything is valid', async () => {
    const workspace = { _id: 'ws-1', synaps_user_id: 'user-1', vnc_url: 'http://10.0.0.2:6901' };
    const reqFn = makeOkRequestFn(200, { 'content-type': 'text/html' }, '<html/>');
    const proxy = new VncProxy({
      repo:          makeRepo(workspace),
      logger:        makeLogger(),
      httpRequestFn: reqFn,
    });
    const handler = proxy.middleware();

    const req = makeReq({
      url:     '/vnc/ws-1/index.html',
      headers: { 'x-synaps-user-id': 'user-1' },
    });
    const res  = makeRes();
    const next = vi.fn();

    await handler(req, res, next);
    // Wait for async cb
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(200);
    expect(reqFn).toHaveBeenCalledTimes(1);
    // Verify the upstream path was computed correctly
    const callOpts = reqFn.mock.calls[0][0];
    expect(callOpts.hostname).toBe('10.0.0.2');
    expect(callOpts.path).toContain('/index.html');
  });

  it('passes through non-/vnc/* paths to next()', async () => {
    const proxy = new VncProxy({ repo: makeRepo(null), logger: makeLogger() });
    const handler = proxy.middleware();

    const req = makeReq({ url: '/health', headers: {} });
    const res  = makeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });
});

// ─── middleware() — 502 on repo error ─────────────────────────────────────

describe('VncProxy.middleware — 502 when repo throws', () => {
  it('returns 502 when repo.byId throws', async () => {
    const proxy = new VncProxy({
      repo:   makeRepo(null, new Error('DB connection lost')),
      logger: makeLogger(),
    });
    const handler = proxy.middleware();

    const req = makeReq({
      url:     '/vnc/ws-1',
      headers: { 'x-synaps-user-id': 'user-1' },
    });
    const res  = makeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('bad_gateway');
  });
});

// ─── constructor validation ───────────────────────────────────────────────────

describe('VncProxy constructor', () => {
  it('throws TypeError when repo is missing', () => {
    expect(() => new VncProxy({})).toThrow(TypeError);
    expect(() => new VncProxy({ repo: undefined })).toThrow(TypeError);
  });

  it('constructs successfully with a repo', () => {
    expect(() => new VncProxy({ repo: makeRepo() })).not.toThrow();
  });
});

// ─── upgrade() — auth + 404 ────────────────────────────────────────────────

describe('VncProxy.upgrade — auth and workspace checks', () => {
  it('destroys socket when header is missing', async () => {
    const workspace = { _id: 'ws-1', synaps_user_id: 'user-1', vnc_url: 'http://10.0.0.2:6901' };
    const proxy = new VncProxy({ repo: makeRepo(workspace), logger: makeLogger() });

    const req    = makeReq({ url: '/vnc/ws-1', headers: {} });
    const socket = makeSocket();

    await proxy.upgrade(req, socket, Buffer.alloc(0));

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('401'));
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('destroys socket for unknown workspace', async () => {
    const proxy = new VncProxy({ repo: makeRepo(null), logger: makeLogger() });

    const req    = makeReq({ url: '/vnc/unknown', headers: { 'x-synaps-user-id': 'user-1' } });
    const socket = makeSocket();

    await proxy.upgrade(req, socket, Buffer.alloc(0));

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('404'));
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('destroys socket when user does not own workspace', async () => {
    const workspace = { _id: 'ws-1', synaps_user_id: 'owner-99', vnc_url: 'http://10.0.0.2:6901' };
    const proxy = new VncProxy({ repo: makeRepo(workspace), logger: makeLogger() });

    const req    = makeReq({ url: '/vnc/ws-1', headers: { 'x-synaps-user-id': 'attacker' } });
    const socket = makeSocket();

    await proxy.upgrade(req, socket, Buffer.alloc(0));

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403'));
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('destroys socket for non-/vnc/* URL', async () => {
    const proxy = new VncProxy({ repo: makeRepo(null), logger: makeLogger() });

    const req    = makeReq({ url: '/other', headers: {} });
    const socket = makeSocket();

    await proxy.upgrade(req, socket, Buffer.alloc(0));

    expect(socket.destroy).toHaveBeenCalled();
  });
});
