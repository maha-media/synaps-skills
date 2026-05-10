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

// ─── Phase 3 helpers ──────────────────────────────────────────────────────────

/**
 * Read all newline-delimited JSON lines from a socket until it closes.
 * Returns an array of parsed objects (one per line).
 */
function readStreamLines(socketPath, req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    const lines = [];

    sock.on('connect', () => {
      sock.write(JSON.stringify(req) + '\n');
    });

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            lines.push(JSON.parse(line));
          } catch (e) {
            reject(new Error(`Could not parse stream line: ${line}`));
          }
        }
      }
    });

    sock.on('end', () => resolve(lines));
    sock.on('error', reject);
  });
}

/** Build a fake identityRouter with all methods as vi.fn(). */
function makeFakeIdentityRouter({ enabled = true } = {}) {
  return {
    get enabled() { return enabled; },
    issueLinkCode:   vi.fn(),
    redeemLinkCode:  vi.fn(),
    resolveWebUser:  vi.fn(),
    resolve:         vi.fn(),
  };
}

// ─── op: link_code_issue ──────────────────────────────────────────────────────

describe('ControlSocket — op: link_code_issue', () => {
  let socketPath, cs, identityRouter;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    identityRouter = makeFakeIdentityRouter({ enabled: true });
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      identityRouter,
      logger: makeLogger(),
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('happy path — returns ok:true, code, expires_at', async () => {
    const expires = new Date(Date.now() + 300_000);
    identityRouter.issueLinkCode.mockResolvedValue({
      code: 'ABC123',
      expires_at: expires,
      synaps_user_id: 'uid-1',
    });

    const resp = await sendRequest(socketPath, {
      op: 'link_code_issue',
      pria_user_id: 'pria-1',
      ttl_secs: 300,
    });

    expect(resp.ok).toBe(true);
    expect(resp.code).toBe('ABC123');
    expect(resp.expires_at).toBeDefined();
    expect(identityRouter.issueLinkCode).toHaveBeenCalledWith({
      pria_user_id:   'pria-1',
      institution_id: null,
      display_name:   null,
      ttl_ms:         300_000,
    });
  });

  it('when identity disabled → ok:false, error:"identity disabled"', async () => {
    const socketPath2 = tmpSocketPath();
    const disabledIR = makeFakeIdentityRouter({ enabled: false });
    const cs2 = new ControlSocket({
      socketPath: socketPath2,
      sessionRouter: makeFakeRouter(),
      identityRouter: disabledIR,
      logger: makeLogger(),
    });
    await cs2.start();

    const resp = await sendRequest(socketPath2, { op: 'link_code_issue', pria_user_id: 'x' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/identity disabled/);

    await cs2.stop();
  });

  it('missing pria_user_id → ok:false', async () => {
    const resp = await sendRequest(socketPath, { op: 'link_code_issue' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/missing pria_user_id/);
  });

  it('when identityRouter is null → ok:false', async () => {
    const socketPath3 = tmpSocketPath();
    const cs3 = new ControlSocket({
      socketPath: socketPath3,
      sessionRouter: makeFakeRouter(),
      identityRouter: null,
      logger: makeLogger(),
    });
    await cs3.start();

    const resp = await sendRequest(socketPath3, { op: 'link_code_issue', pria_user_id: 'x' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/identity disabled/);

    await cs3.stop();
  });

  it('forwards optional institution_id and display_name', async () => {
    identityRouter.issueLinkCode.mockResolvedValue({
      code: 'XY1234',
      expires_at: new Date(),
      synaps_user_id: 'uid-2',
    });

    await sendRequest(socketPath, {
      op: 'link_code_issue',
      pria_user_id:   'pria-2',
      institution_id: 'inst-7',
      display_name:   'Alice',
      ttl_secs:       120,
    });

    expect(identityRouter.issueLinkCode).toHaveBeenCalledWith({
      pria_user_id:   'pria-2',
      institution_id: 'inst-7',
      display_name:   'Alice',
      ttl_ms:         120_000,
    });
  });
});

// ─── op: link_code_redeem ─────────────────────────────────────────────────────

describe('ControlSocket — op: link_code_redeem', () => {
  let socketPath, cs, identityRouter;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    identityRouter = makeFakeIdentityRouter({ enabled: true });
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      identityRouter,
      logger: makeLogger(),
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('happy path — ok:true with synaps_user_id and was_relinked', async () => {
    identityRouter.redeemLinkCode.mockResolvedValue({
      ok: true,
      synaps_user_id: 'suid-99',
      was_relinked: false,
    });

    const resp = await sendRequest(socketPath, {
      op: 'link_code_redeem',
      code: 'ABC123',
      channel: 'slack',
      external_id: 'U001',
      external_team_id: 'T001',
      display_name: 'Bob',
    });

    expect(resp.ok).toBe(true);
    expect(resp.synaps_user_id).toBe('suid-99');
    expect(resp.was_relinked).toBe(false);
  });

  it('unknown code → ok:false, error:"unknown"', async () => {
    identityRouter.redeemLinkCode.mockResolvedValue({ ok: false, reason: 'unknown' });
    const resp = await sendRequest(socketPath, {
      op: 'link_code_redeem', code: 'ZZZZZZ', channel: 'slack', external_id: 'U1',
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/unknown/);
  });

  it('expired code → ok:false, error:"expired"', async () => {
    identityRouter.redeemLinkCode.mockResolvedValue({ ok: false, reason: 'expired' });
    const resp = await sendRequest(socketPath, {
      op: 'link_code_redeem', code: 'OLD000', channel: 'slack', external_id: 'U2',
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/expired/);
  });

  it('already_redeemed → ok:false, error:"already_redeemed"', async () => {
    identityRouter.redeemLinkCode.mockResolvedValue({ ok: false, reason: 'already_redeemed' });
    const resp = await sendRequest(socketPath, {
      op: 'link_code_redeem', code: 'USED00', channel: 'slack', external_id: 'U3',
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/already_redeemed/);
  });

  it('identity disabled → ok:false', async () => {
    const socketPath4 = tmpSocketPath();
    const disabledIR = makeFakeIdentityRouter({ enabled: false });
    const cs4 = new ControlSocket({
      socketPath: socketPath4,
      sessionRouter: makeFakeRouter(),
      identityRouter: disabledIR,
      logger: makeLogger(),
    });
    await cs4.start();

    const resp = await sendRequest(socketPath4, {
      op: 'link_code_redeem', code: 'X', channel: 'slack', external_id: 'U4',
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/identity disabled/);
    await cs4.stop();
  });
});

// ─── op: identity_resolve_web ─────────────────────────────────────────────────

describe('ControlSocket — op: identity_resolve_web', () => {
  let socketPath, cs, identityRouter;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    identityRouter = makeFakeIdentityRouter({ enabled: true });
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      identityRouter,
      logger: makeLogger(),
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('happy path — ok:true with synaps_user_id, is_new, memory_namespace', async () => {
    identityRouter.resolveWebUser.mockResolvedValue({
      synapsUser: {
        _id: 'obj-abc',
        memory_namespace: 'u_obj-abc',
      },
      isNew: true,
    });

    const resp = await sendRequest(socketPath, {
      op: 'identity_resolve_web',
      pria_user_id:   'pria-42',
      institution_id: 'inst-1',
      display_name:   'Carol',
    });

    expect(resp.ok).toBe(true);
    expect(resp.synaps_user_id).toBe('obj-abc');
    expect(resp.is_new).toBe(true);
    expect(resp.memory_namespace).toBe('u_obj-abc');
    expect(identityRouter.resolveWebUser).toHaveBeenCalledWith({
      pria_user_id:   'pria-42',
      institution_id: 'inst-1',
      display_name:   'Carol',
    });
  });

  it('existing user — is_new is false', async () => {
    identityRouter.resolveWebUser.mockResolvedValue({
      synapsUser: { _id: 'obj-xyz', memory_namespace: 'u_obj-xyz' },
      isNew: false,
    });

    const resp = await sendRequest(socketPath, {
      op: 'identity_resolve_web',
      pria_user_id: 'pria-43',
    });

    expect(resp.ok).toBe(true);
    expect(resp.is_new).toBe(false);
  });

  it('identity disabled → ok:false', async () => {
    const socketPath5 = tmpSocketPath();
    const disabledIR = makeFakeIdentityRouter({ enabled: false });
    const cs5 = new ControlSocket({
      socketPath: socketPath5,
      sessionRouter: makeFakeRouter(),
      identityRouter: disabledIR,
      logger: makeLogger(),
    });
    await cs5.start();

    const resp = await sendRequest(socketPath5, {
      op: 'identity_resolve_web',
      pria_user_id: 'pria-99',
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/identity disabled/);
    await cs5.stop();
  });

  it('missing pria_user_id → ok:false', async () => {
    const resp = await sendRequest(socketPath, { op: 'identity_resolve_web' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch(/missing pria_user_id/);
  });
});

// ─── backwards compat: existing ops still work ───────────────────────────────

describe('ControlSocket — backwards compatibility with new identityRouter param', () => {
  let socketPath, cs;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter([{ key: 'a', rpc: {} }, { key: 'b', rpc: {} }]),
      // identityRouter omitted — defaults to null
      logger: makeLogger(),
      version: '2.0.0',
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('status op still works', async () => {
    const resp = await sendRequest(socketPath, { op: 'status' });
    expect(resp.ok).toBe(true);
    expect(resp.version).toBe('2.0.0');
    expect(resp.sessions).toBe(2);
  });

  it('threads op still works', async () => {
    const resp = await sendRequest(socketPath, { op: 'threads' });
    expect(resp.ok).toBe(true);
    expect(Array.isArray(resp.threads)).toBe(true);
  });
});

// ─── op: chat_stream_start ────────────────────────────────────────────────────

import { EventEmitter as NodeEventEmitter } from 'node:events';

describe('ControlSocket — op: chat_stream_start', () => {
  let socketPath, cs;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
  });

  afterEach(async () => {
    if (cs) await cs.stop();
  });

  /**
   * Create a fake rpc EventEmitter that:
   * 1. emits `chunks` via 'chunk' events on sendUserPrompt
   * 2. terminates with 'agent_end' or 'error'
   *
   * sendUserPrompt is a vi.fn() that triggers the event emission asynchronously.
   */
  function buildFakeRpc({ chunks = [], endWith = 'agent_end', errorMsg = 'forced error' } = {}) {
    const rpc = new NodeEventEmitter();
    rpc.sendUserPrompt = vi.fn(async (_text) => {
      // Emit chunks then the terminal event on next tick.
      await Promise.resolve();
      for (const chunk of chunks) {
        rpc.emit('chunk', chunk);
      }
      if (endWith === 'agent_end') {
        rpc.emit('agent_end', {});
      } else {
        rpc.emit('error', new Error(errorMsg));
      }
    });
    return rpc;
  }

  it('streams chunk lines and ends with {kind:"done"}', async () => {
    const fakeRpc = buildFakeRpc({
      chunks: [
        { type: 'markdown_text', text: 'Hello!' },
        { type: 'task_update',   id: 'tool-1', state: 'in_progress', label: 'Thinking' },
      ],
      endWith: 'agent_end',
    });

    const fakeRouter = {
      liveSessions:   vi.fn(() => []),
      listSessions:   vi.fn(async () => []),
      closeSession:   vi.fn(async () => {}),
      getOrCreateSession: vi.fn(async () => fakeRpc),
    };

    cs = new ControlSocket({
      socketPath,
      sessionRouter: fakeRouter,
      logger: makeLogger(),
    });
    await cs.start();

    const lines = await readStreamLines(socketPath, {
      op: 'chat_stream_start',
      synaps_user_id: 'user-1',
      channel: 'web',
      thread_key: 'web:user-1:chat-1',
      text: 'Hello',
    });

    // Expect: 2 chunk lines + 1 done line
    expect(lines.length).toBeGreaterThanOrEqual(3);

    const chunkLines = lines.filter((l) => l.kind === 'chunk');
    const doneLine   = lines.find((l) => l.kind === 'done');

    expect(chunkLines.length).toBe(2);
    expect(chunkLines[0].chunk.type).toBe('markdown_text');
    expect(chunkLines[1].chunk.type).toBe('task_update');
    expect(doneLine).toBeDefined();
  });

  it('emits {kind:"error"} and closes on rpc error', async () => {
    const fakeRpc = buildFakeRpc({ endWith: 'error', errorMsg: 'stream exploded' });

    const fakeRouter = {
      liveSessions:   vi.fn(() => []),
      listSessions:   vi.fn(async () => []),
      closeSession:   vi.fn(async () => {}),
      getOrCreateSession: vi.fn(async () => fakeRpc),
    };

    cs = new ControlSocket({
      socketPath,
      sessionRouter: fakeRouter,
      logger: makeLogger(),
    });
    await cs.start();

    const lines = await readStreamLines(socketPath, {
      op: 'chat_stream_start',
      synaps_user_id: 'user-2',
      text: 'test',
    });

    const errLine = lines.find((l) => l.kind === 'error');
    expect(errLine).toBeDefined();
    expect(errLine.message).toMatch(/stream exploded/);
  });

  it('emits {kind:"error"} when getOrCreateSession throws', async () => {
    const fakeRouter = {
      liveSessions:   vi.fn(() => []),
      listSessions:   vi.fn(async () => []),
      closeSession:   vi.fn(async () => {}),
      getOrCreateSession: vi.fn(async () => { throw new Error('session factory failed'); }),
    };

    cs = new ControlSocket({
      socketPath,
      sessionRouter: fakeRouter,
      logger: makeLogger(),
    });
    await cs.start();

    const lines = await readStreamLines(socketPath, {
      op: 'chat_stream_start',
      synaps_user_id: 'user-3',
      text: 'hi',
    });

    const errLine = lines.find((l) => l.kind === 'error');
    expect(errLine).toBeDefined();
    expect(errLine.message).toMatch(/session factory failed/);
  });

  it('emits {kind:"error"} when synaps_user_id is missing', async () => {
    const fakeRouter = {
      liveSessions:   vi.fn(() => []),
      listSessions:   vi.fn(async () => []),
      closeSession:   vi.fn(async () => {}),
      getOrCreateSession: vi.fn(async () => buildFakeRpc()),
    };

    cs = new ControlSocket({
      socketPath,
      sessionRouter: fakeRouter,
      logger: makeLogger(),
    });
    await cs.start();

    const lines = await readStreamLines(socketPath, {
      op: 'chat_stream_start',
      text: 'hi',
      // synaps_user_id intentionally missing
    });

    const errLine = lines.find((l) => l.kind === 'error');
    expect(errLine).toBeDefined();
    expect(errLine.message).toMatch(/missing synaps_user_id/);
  });

  it('calls getOrCreateSession with correct params', async () => {
    const fakeRpc = buildFakeRpc({ chunks: [], endWith: 'agent_end' });

    const fakeRouter = {
      liveSessions:   vi.fn(() => []),
      listSessions:   vi.fn(async () => []),
      closeSession:   vi.fn(async () => {}),
      getOrCreateSession: vi.fn(async () => fakeRpc),
    };

    cs = new ControlSocket({
      socketPath,
      sessionRouter: fakeRouter,
      logger: makeLogger(),
    });
    await cs.start();

    await readStreamLines(socketPath, {
      op: 'chat_stream_start',
      synaps_user_id: 'suid-42',
      channel: 'web',
      thread_key: 'web:suid-42:chat-99',
      text: 'Ping',
      model: 'claude-sonnet-4-6',
    });

    expect(fakeRouter.getOrCreateSession).toHaveBeenCalledWith({
      source:       'web',
      conversation: 'suid-42',
      thread:       'web:suid-42:chat-99',
      model:        'claude-sonnet-4-6',
    });
    expect(fakeRpc.sendUserPrompt).toHaveBeenCalledWith('Ping');
  });

  it('no chunks → just {kind:"done"}', async () => {
    const fakeRpc = buildFakeRpc({ chunks: [], endWith: 'agent_end' });

    const fakeRouter = {
      liveSessions:   vi.fn(() => []),
      listSessions:   vi.fn(async () => []),
      closeSession:   vi.fn(async () => {}),
      getOrCreateSession: vi.fn(async () => fakeRpc),
    };

    cs = new ControlSocket({
      socketPath,
      sessionRouter: fakeRouter,
      logger: makeLogger(),
    });
    await cs.start();

    const lines = await readStreamLines(socketPath, {
      op: 'chat_stream_start',
      synaps_user_id: 'user-4',
      text: 'empty',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ kind: 'done' });
  });
});

// ─── op: cred_broker_use ──────────────────────────────────────────────────────

import {
  CredsValidationError,
  CredsUnavailableError,
  CredBrokerDisabledError,
} from './core/cred-broker.js';
import {
  InfisicalNotFoundError,
  InfisicalAuthError,
  InfisicalUpstreamError,
} from './core/cred-broker/infisical-client.js';

/**
 * Build a minimal fake credBroker whose `use()` is a vi.fn().
 * Caller can pass a resolved value or a rejection.
 */
function makeFakeCredBroker(resolvedValue = null) {
  return {
    use: vi.fn(async () => {
      if (resolvedValue instanceof Error) throw resolvedValue;
      return resolvedValue ?? {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"login":"octocat"}',
        cached: false,
        fetchedAt: 1735000000000,
      };
    }),
  };
}

/** Canonical happy-path request payload. */
const GOOD_REQ = {
  op:             'cred_broker_use',
  synaps_user_id: 'syn_abc123',
  institution_id: 'inst_xyz',
  key:            'github.token',
  request: {
    method:  'GET',
    url:     'https://api.github.com/user',
    headers: { Accept: 'application/vnd.github+json' },
    body:    null,
  },
};

describe('ControlSocket — cred_broker_use op', () => {
  let socketPath, cs, credBroker, logger;

  beforeEach(async () => {
    socketPath  = tmpSocketPath();
    logger      = makeLogger();
    credBroker  = makeFakeCredBroker();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      credBroker,
      logger,
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  // ── happy path ─────────────────────────────────────────────────────────────

  it('happy path — routes to credBroker.use() with camelCase args', async () => {
    const resp = await sendRequest(socketPath, GOOD_REQ);
    expect(resp.ok).toBe(true);
    expect(credBroker.use).toHaveBeenCalledOnce();

    const [callArgs] = credBroker.use.mock.calls[0];
    expect(callArgs.synapsUserId).toBe('syn_abc123');
    expect(callArgs.institutionId).toBe('inst_xyz');
    expect(callArgs.key).toBe('github.token');
    expect(callArgs.request.method).toBe('GET');
    expect(callArgs.request.url).toBe('https://api.github.com/user');
  });

  it('happy path — response shape has ok, status, headers, body, cached, fetched_at', async () => {
    credBroker.use.mockResolvedValueOnce({
      status:    200,
      headers:   { 'content-type': 'application/json' },
      body:      '{"login":"octocat"}',
      cached:    false,
      fetchedAt: 1735000000000,
    });

    const resp = await sendRequest(socketPath, GOOD_REQ);
    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(200);
    expect(resp.headers).toEqual({ 'content-type': 'application/json' });
    expect(resp.body).toBe('{"login":"octocat"}');
    expect(resp.cached).toBe(false);
    expect(resp.fetched_at).toBe(1735000000000);
  });

  it('synaps_user_id (snake) → synapsUserId (camel) translation to broker', async () => {
    await sendRequest(socketPath, { ...GOOD_REQ, synaps_user_id: 'syn_translated' });
    const [args] = credBroker.use.mock.calls[0];
    expect(args.synapsUserId).toBe('syn_translated');
    expect(args).not.toHaveProperty('synaps_user_id');
  });

  it('institution_id (snake) → institutionId (camel) translation to broker', async () => {
    await sendRequest(socketPath, { ...GOOD_REQ, institution_id: 'inst_translated' });
    const [args] = credBroker.use.mock.calls[0];
    expect(args.institutionId).toBe('inst_translated');
    expect(args).not.toHaveProperty('institution_id');
  });

  it('request.body: null → undefined passed to broker', async () => {
    const req = { ...GOOD_REQ, request: { ...GOOD_REQ.request, body: null } };
    await sendRequest(socketPath, req);
    const [args] = credBroker.use.mock.calls[0];
    expect(args.request.body).toBeUndefined();
  });

  it('cached:true is reflected in wire response', async () => {
    credBroker.use.mockResolvedValueOnce({
      status: 200, headers: {}, body: '{}', cached: true, fetchedAt: 1735000000001,
    });
    const resp = await sendRequest(socketPath, GOOD_REQ);
    expect(resp.ok).toBe(true);
    expect(resp.cached).toBe(true);
  });

  // ── wire-level validation errors ───────────────────────────────────────────

  it('missing synaps_user_id → code: invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'cred_broker_use', institution_id: 'inst_1', key: 'k',
      request: { method: 'GET', url: 'https://x.example' },
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
    expect(resp.error).toMatch(/synaps_user_id/);
  });

  it('empty synaps_user_id → code: invalid_request', async () => {
    const resp = await sendRequest(socketPath, { ...GOOD_REQ, synaps_user_id: '' });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
  });

  it('missing institution_id → code: invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'cred_broker_use', synaps_user_id: 'suid', key: 'k',
      request: { method: 'GET', url: 'https://x.example' },
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
    expect(resp.error).toMatch(/institution_id/);
  });

  it('missing key → code: invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'cred_broker_use', synaps_user_id: 'suid', institution_id: 'inst',
      request: { method: 'GET', url: 'https://x.example' },
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
    expect(resp.error).toMatch(/key/);
  });

  it('missing request object → code: invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'cred_broker_use', synaps_user_id: 'suid', institution_id: 'inst', key: 'k',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
    expect(resp.error).toMatch(/request/);
  });

  // ── broker error code mapping ─────────────────────────────────────────────

  it('CredsValidationError from broker → code: invalid_request', async () => {
    credBroker.use.mockRejectedValueOnce(new CredsValidationError('bad method'));
    const resp = await sendRequest(socketPath, GOOD_REQ);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
    expect(resp.error).toBe('bad method');
  });

  it('CredBrokerDisabledError from broker → code: creds_disabled', async () => {
    credBroker.use.mockRejectedValueOnce(new CredBrokerDisabledError('creds broker is disabled'));
    const resp = await sendRequest(socketPath, GOOD_REQ);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('creds_disabled');
    expect(resp.error).toBe('creds broker is disabled');
  });

  it('CredsUnavailableError from broker → code: creds_unavailable', async () => {
    credBroker.use.mockRejectedValueOnce(new CredsUnavailableError('infisical is down'));
    const resp = await sendRequest(socketPath, GOOD_REQ);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('creds_unavailable');
    expect(resp.error).toBe('infisical is down');
  });

  it('InfisicalNotFoundError → code: secret_not_found', async () => {
    credBroker.use.mockRejectedValueOnce(new InfisicalNotFoundError('secret not found: github.token'));
    const resp = await sendRequest(socketPath, GOOD_REQ);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('secret_not_found');
    expect(resp.error).toMatch(/secret not found/);
  });

  it('InfisicalAuthError → code: broker_auth_failed', async () => {
    credBroker.use.mockRejectedValueOnce(new InfisicalAuthError('infisical auth failed: 401'));
    const resp = await sendRequest(socketPath, GOOD_REQ);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('broker_auth_failed');
    expect(resp.error).toMatch(/auth failed/);
  });

  it('InfisicalUpstreamError → code: broker_upstream', async () => {
    credBroker.use.mockRejectedValueOnce(new InfisicalUpstreamError('network timeout'));
    const resp = await sendRequest(socketPath, GOOD_REQ);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('broker_upstream');
    expect(resp.error).toBe('network timeout');
  });

  it('generic Error → code: internal_error', async () => {
    credBroker.use.mockRejectedValueOnce(new Error('unexpected internal failure'));
    const resp = await sendRequest(socketPath, GOOD_REQ);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('internal_error');
    expect(resp.error).toBe('unexpected internal failure');
  });

  // ── no credBroker injected (defensive) ─────────────────────────────────────

  it('no credBroker injected — code: creds_disabled, "not configured" message (defensive guard)', async () => {
    const sp = tmpSocketPath();
    const cs2 = new ControlSocket({
      socketPath:    sp,
      sessionRouter: makeFakeRouter(),
      // credBroker intentionally omitted — should not happen in prod
      logger:        makeLogger(),
    });
    await cs2.start();

    const resp = await sendRequest(sp, GOOD_REQ);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('creds_disabled');
    expect(resp.error).toMatch(/not configured/);

    await cs2.stop();
  });

  // ── token never logged ─────────────────────────────────────────────────────

  it('token never appears in logger calls (log hygiene)', async () => {
    const SECRET_TOKEN = 'ghp_SUPERSECRET_TOKEN_MUST_NOT_LOG';

    // Simulate the broker returning a response where the token was used
    // internally.  The response itself must never contain it.
    credBroker.use.mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body:    '{"login":"octocat"}',
      cached:  false,
      fetchedAt: 1735000000000,
    });

    // Send a request with Authorization header containing the fake token.
    const reqWithAuth = {
      ...GOOD_REQ,
      request: {
        ...GOOD_REQ.request,
        headers: {
          ...GOOD_REQ.request.headers,
          Authorization: `Bearer ${SECRET_TOKEN}`,
        },
      },
    };

    await sendRequest(socketPath, reqWithAuth);

    // Collect all logger call arguments as a single flat string.
    const allLoggedArgs = [
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
      ...logger.debug.mock.calls,
    ]
      .flat(Infinity)
      .map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
      .join('\n');

    expect(allLoggedArgs).not.toContain(SECRET_TOKEN);
  });
});
