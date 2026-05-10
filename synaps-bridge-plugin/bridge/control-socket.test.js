/**
 * @file bridge/control-socket.test.js
 *
 * Tests for ControlSocket.
 *
 * We use real Unix stream sockets bound to tmp paths so we test the actual
 * framing — but all tests clean up after themselves.  No real SessionRouter
 * is used; we inject a fake.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import fs from 'node:fs';
import { ControlSocket, DEFAULT_SOCKET_PATH } from './control-socket.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

let socketCounter = 0;

function tmpSocketPath() {
  return path.join(os.tmpdir(), `ctrl-test-${process.pid}-${++socketCounter}.sock`);
}

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeFakeRouter(sessions = []) {
  return {
    liveSessions: vi.fn(() => sessions),
    listSessions: vi.fn(async () => sessions),
    closeSession: vi.fn(async () => {}),
  };
}

/**
 * Open a client connection, send a JSON request, read the JSON response.
 * @param {string} socketPath
 * @param {object} req
 * @returns {Promise<object>}
 */
function sendRequest(socketPath, req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';

    sock.on('connect', () => {
      sock.write(JSON.stringify(req) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    sock.on('end', () => {
      try {
        resolve(JSON.parse(buf.trim()));
      } catch (err) {
        reject(new Error(`Could not parse response: ${buf}`));
      }
    });
    sock.on('error', reject);
  });
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

describe('ControlSocket — lifecycle', () => {
  it('exports DEFAULT_SOCKET_PATH inside ~/.synaps-cli/bridge/', () => {
    expect(DEFAULT_SOCKET_PATH).toContain('.synaps-cli');
    expect(DEFAULT_SOCKET_PATH).toContain('control.sock');
  });

  it('start() creates the socket file', async () => {
    const socketPath = tmpSocketPath();
    const cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      logger: makeLogger(),
    });
    await cs.start();
    expect(fs.existsSync(socketPath)).toBe(true);
    await cs.stop();
  });

  it('stop() removes the socket file', async () => {
    const socketPath = tmpSocketPath();
    const cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      logger: makeLogger(),
    });
    await cs.start();
    await cs.stop();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('start() is idempotent — calling twice does not throw', async () => {
    const socketPath = tmpSocketPath();
    const cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      logger: makeLogger(),
    });
    await cs.start();
    await cs.start(); // second call is a no-op
    await cs.stop();
  });

  it('stop() is idempotent — calling twice does not throw', async () => {
    const socketPath = tmpSocketPath();
    const cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      logger: makeLogger(),
    });
    await cs.start();
    await cs.stop();
    await cs.stop(); // second call is a no-op
  });

  it('start() unlinks a stale socket file', async () => {
    const socketPath = tmpSocketPath();
    // Create a fake stale socket file.
    fs.writeFileSync(socketPath, 'stale');
    const cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      logger: makeLogger(),
    });
    await cs.start();
    // The file is now an actual socket (not the stale data).
    expect(fs.existsSync(socketPath)).toBe(true);
    await cs.stop();
  });

  it('start() chmods socket to 0o600', async () => {
    const socketPath = tmpSocketPath();
    const cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      logger: makeLogger(),
    });
    await cs.start();
    const stat = fs.statSync(socketPath);
    // Mode bits: 0o600 = owner rw, group/others none
    expect(stat.mode & 0o777).toBe(0o600);
    await cs.stop();
  });
});

// ─── op: threads ─────────────────────────────────────────────────────────────

describe('ControlSocket — op: threads', () => {
  let socketPath, cs;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    const sessions = [
      {
        key: 'slack:C123:T456',
        source: 'slack',
        conversation: 'C123',
        thread: 'T456',
        model: 'claude-sonnet-4-6',
        sessionId: 'sess-abc',
        lastActiveAt: 1000000,
        inFlight: false,
      },
    ];
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(sessions),
      logger: makeLogger(),
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('returns ok:true and threads array', async () => {
    const resp = await sendRequest(socketPath, { op: 'threads' });
    expect(resp.ok).toBe(true);
    expect(Array.isArray(resp.threads)).toBe(true);
    expect(resp.threads).toHaveLength(1);
  });

  it('thread entry has required fields', async () => {
    const resp = await sendRequest(socketPath, { op: 'threads' });
    const t = resp.threads[0];
    expect(t.key).toBe('slack:C123:T456');
    expect(t.source).toBe('slack');
    expect(t.conversation).toBe('C123');
    expect(t.thread).toBe('T456');
    expect(t.model).toBe('claude-sonnet-4-6');
    expect(t.sessionId).toBe('sess-abc');
    expect(typeof t.lastActiveAt).toBe('number');
    expect(typeof t.inFlight).toBe('boolean');
  });
});

// ─── op: model ────────────────────────────────────────────────────────────────

describe('ControlSocket — op: model', () => {
  let socketPath, cs, fakeRpc;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    fakeRpc = { setModel: vi.fn(async () => ({ ok: true })) };
    const sessions = [{ key: 'slack:C1:T1', rpc: fakeRpc }];
    const router = {
      liveSessions: vi.fn(() => sessions),
      listSessions: vi.fn(async () => []),
      closeSession: vi.fn(async () => {}),
    };
    cs = new ControlSocket({ socketPath, sessionRouter: router, logger: makeLogger() });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('sets model on known key → {ok:true}', async () => {
    const resp = await sendRequest(socketPath, { op: 'model', key: 'slack:C1:T1', model: 'claude-opus-4-5' });
    expect(resp.ok).toBe(true);
    expect(fakeRpc.setModel).toHaveBeenCalledWith('claude-opus-4-5');
  });

  it('returns {ok:false, error:"unknown key"} for unknown key', async () => {
    const resp = await sendRequest(socketPath, { op: 'model', key: 'slack:X:X', model: 'x' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/unknown key/);
  });

  it('returns {ok:false} when setModel throws', async () => {
    fakeRpc.setModel.mockRejectedValueOnce(new Error('rpc error'));
    const resp = await sendRequest(socketPath, { op: 'model', key: 'slack:C1:T1', model: 'bad' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/rpc error/);
  });
});

// ─── op: reap ────────────────────────────────────────────────────────────────

describe('ControlSocket — op: reap', () => {
  let socketPath, cs, fakeRouter;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    const sessions = [{ key: 'slack:C2:T2', rpc: {} }];
    fakeRouter = {
      liveSessions: vi.fn(() => sessions),
      listSessions: vi.fn(async () => []),
      closeSession: vi.fn(async () => {}),
    };
    cs = new ControlSocket({ socketPath, sessionRouter: fakeRouter, logger: makeLogger() });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('closes known session → {ok:true}', async () => {
    const resp = await sendRequest(socketPath, { op: 'reap', key: 'slack:C2:T2' });
    expect(resp.ok).toBe(true);
    expect(fakeRouter.closeSession).toHaveBeenCalledWith({ source: 'slack', conversation: 'C2', thread: 'T2' });
  });

  it('returns {ok:false} for unknown key', async () => {
    const resp = await sendRequest(socketPath, { op: 'reap', key: 'slack:UNKNOWN:X' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/unknown key/);
  });
});

// ─── op: status ───────────────────────────────────────────────────────────────

describe('ControlSocket — op: status', () => {
  let socketPath, cs;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    const sessions = [{ key: 'a', rpc: {} }, { key: 'b', rpc: {} }];
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(sessions),
      logger: makeLogger(),
      version: '1.2.3',
      nowMs: () => 10000,
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('returns ok:true, version, sessions count, uptime_secs', async () => {
    const resp = await sendRequest(socketPath, { op: 'status' });
    expect(resp.ok).toBe(true);
    expect(resp.version).toBe('1.2.3');
    expect(resp.sessions).toBe(2);
    expect(typeof resp.uptime_secs).toBe('number');
  });
});

// ─── unknown op ───────────────────────────────────────────────────────────────

describe('ControlSocket — unknown op', () => {
  let socketPath, cs;
  beforeEach(async () => {
    socketPath = tmpSocketPath();
    cs = new ControlSocket({ socketPath, sessionRouter: makeFakeRouter(), logger: makeLogger() });
    await cs.start();
  });
  afterEach(async () => { await cs.stop(); });

  it('returns {ok:false, error:"unknown op: foo"}', async () => {
    const resp = await sendRequest(socketPath, { op: 'foo' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/unknown op: foo/);
  });
});

// ─── malformed JSON ───────────────────────────────────────────────────────────

describe('ControlSocket — malformed JSON', () => {
  let socketPath, cs;
  beforeEach(async () => {
    socketPath = tmpSocketPath();
    cs = new ControlSocket({ socketPath, sessionRouter: makeFakeRouter(), logger: makeLogger() });
    await cs.start();
  });
  afterEach(async () => { await cs.stop(); });

  it('returns {ok:false, error:"malformed request"} on bad JSON', async () => {
    const resp = await new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      let buf = '';
      sock.on('connect', () => { sock.write('not-valid-json\n'); });
      sock.on('data', (c) => { buf += c.toString(); });
      sock.on('end', () => {
        try { resolve(JSON.parse(buf.trim())); } catch (e) { reject(e); }
      });
      sock.on('error', reject);
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/malformed request/);
  });
});

// ─── multiple sequential connections ─────────────────────────────────────────

describe('ControlSocket — multiple sequential connections', () => {
  let socketPath, cs;
  beforeEach(async () => {
    socketPath = tmpSocketPath();
    cs = new ControlSocket({ socketPath, sessionRouter: makeFakeRouter(), logger: makeLogger(), version: '0.1.0' });
    await cs.start();
  });
  afterEach(async () => { await cs.stop(); });

  it('handles multiple sequential requests correctly', async () => {
    const r1 = await sendRequest(socketPath, { op: 'status' });
    const r2 = await sendRequest(socketPath, { op: 'threads' });
    const r3 = await sendRequest(socketPath, { op: 'status' });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.threads).toEqual([]);
    expect(r3.ok).toBe(true);
  });
});

// ─── request event ────────────────────────────────────────────────────────────

describe('ControlSocket — request event', () => {
  let socketPath, cs;
  beforeEach(async () => {
    socketPath = tmpSocketPath();
    cs = new ControlSocket({ socketPath, sessionRouter: makeFakeRouter(), logger: makeLogger() });
    await cs.start();
  });
  afterEach(async () => { await cs.stop(); });

  it('emits "request" event with parsed request object', async () => {
    const emitted = [];
    cs.on('request', (req) => emitted.push(req));
    await sendRequest(socketPath, { op: 'status' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].op).toBe('status');
  });
});
