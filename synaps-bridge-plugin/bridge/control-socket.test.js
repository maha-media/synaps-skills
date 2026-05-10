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
