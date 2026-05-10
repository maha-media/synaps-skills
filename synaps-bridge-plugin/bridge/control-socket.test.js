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

// ─── Phase 6 op helpers ───────────────────────────────────────────────────────

import { NoopScheduler } from './core/scheduler.js';
import { NoopHookBus }   from './core/hook-bus.js';

/** Make a fake scheduler with all methods as vi.fn(). */
function makeFakeScheduler() {
  return {
    create: vi.fn(),
    list:   vi.fn(),
    remove: vi.fn(),
  };
}

/** Make a fake hookBus (enabled). */
function makeFakeHookBus() {
  return { emit: vi.fn() };
}

/** Make a fake hookRepo. */
function makeFakeHookRepo(hooks = []) {
  return {
    create:    vi.fn(async (data) => ({ _id: 'hook-1', ...data })),
    findById:  vi.fn(async (id) => hooks.find((h) => String(h._id) === String(id)) ?? null),
    listAll:   vi.fn(async () => hooks),
    listByEvent: vi.fn(async () => hooks),
    remove:    vi.fn(async () => true),
  };
}

/** Make a fake scheduledTaskRepo. */
function makeFakeScheduledTaskRepo(tasks = []) {
  return {
    findById: vi.fn(async (id) => tasks.find((t) => String(t._id) === String(id)) ?? null),
    create:   vi.fn(),
    remove:   vi.fn(async () => true),
    listByUser: vi.fn(async () => tasks),
  };
}

/** Make a fake heartbeatRepo. */
function makeFakeHeartbeatRepo() {
  return {
    record: vi.fn(async () => ({ component: 'workspace', id: 'ws-1', healthy: true, ts: new Date() })),
  };
}

/** Make a fake workspaceRepo. */
function makeFakeWorkspaceRepo(workspace = null) {
  return {
    byId:     vi.fn(async () => workspace),
    findById: vi.fn(async () => workspace),
  };
}

// ─── op: heartbeat_emit ───────────────────────────────────────────────────────

describe('ControlSocket — op: heartbeat_emit', () => {
  let socketPath, cs, heartbeatRepo, workspaceRepo, logger;

  beforeEach(async () => {
    socketPath    = tmpSocketPath();
    logger        = makeLogger();
    heartbeatRepo = makeFakeHeartbeatRepo();
    workspaceRepo = makeFakeWorkspaceRepo({ _id: 'ws-1', synaps_user_id: 'user-abc' });
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      heartbeatRepo,
      workspaceRepo,
      logger,
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('happy path workspace — returns ok:true with ts (ISO8601)', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'heartbeat_emit',
      component: 'workspace',
      id: 'ws-1',
      synaps_user_id: 'user-abc',
    });
    expect(resp.ok).toBe(true);
    expect(typeof resp.ts).toBe('string');
    expect(new Date(resp.ts).toISOString()).toBe(resp.ts);
    expect(heartbeatRepo.record).toHaveBeenCalledOnce();
  });

  it('happy path rpc — skips ownership check, records heartbeat', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'heartbeat_emit',
      component: 'rpc',
      id: 'sess-1',
      synaps_user_id: 'any-user',
    });
    expect(resp.ok).toBe(true);
    expect(heartbeatRepo.record).toHaveBeenCalledWith(expect.objectContaining({
      component: 'rpc',
      id: 'sess-1',
    }));
  });

  it('happy path agent — skips ownership check', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'heartbeat_emit',
      component: 'agent',
      id: 'agent-xyz',
      synaps_user_id: 'user-1',
    });
    expect(resp.ok).toBe(true);
    expect(heartbeatRepo.record).toHaveBeenCalledOnce();
  });

  it('missing heartbeatRepo — returns { ok:true, supervisor:"noop" }', async () => {
    const sp2 = tmpSocketPath();
    const cs2 = new ControlSocket({
      socketPath: sp2,
      sessionRouter: makeFakeRouter(),
      // heartbeatRepo omitted
      logger: makeLogger(),
    });
    await cs2.start();
    const resp = await sendRequest(sp2, {
      op: 'heartbeat_emit',
      component: 'workspace',
      id: 'ws-x',
      synaps_user_id: 'user-y',
    });
    expect(resp.ok).toBe(true);
    expect(resp.supervisor).toBe('noop');
    await cs2.stop();
  });

  it('workspace owner mismatch — returns code:unauthorized', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'heartbeat_emit',
      component: 'workspace',
      id: 'ws-1',
      synaps_user_id: 'wrong-user',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('unauthorized');
    expect(resp.error).toMatch(/mismatch/);
  });

  it('invalid component — returns code:invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'heartbeat_emit',
      component: 'bridge',  // not in allowed set
      id: 'ws-1',
      synaps_user_id: 'user-abc',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
  });

  it('missing id — returns code:invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'heartbeat_emit',
      component: 'workspace',
      synaps_user_id: 'user-abc',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
    expect(resp.error).toMatch(/id/);
  });

  it('missing synaps_user_id — returns code:invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'heartbeat_emit',
      component: 'workspace',
      id: 'ws-1',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
    expect(resp.error).toMatch(/synaps_user_id/);
  });

  it('heartbeatRepo.record throws — returns code:internal_error', async () => {
    heartbeatRepo.record.mockRejectedValueOnce(new Error('db down'));
    const resp = await sendRequest(socketPath, {
      op: 'heartbeat_emit',
      component: 'rpc',
      id: 'sess-1',
      synaps_user_id: 'user-abc',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('internal_error');
  });
});

// ─── op: scheduled_task_create ────────────────────────────────────────────────

describe('ControlSocket — op: scheduled_task_create', () => {
  let socketPath, cs, scheduler, logger;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    logger     = makeLogger();
    scheduler  = makeFakeScheduler();
    scheduler.create.mockResolvedValue({
      id: 'task-1',
      agenda_job_id: 'agenda-1',
      next_run: new Date('2025-01-01T09:00:00Z'),
    });
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      scheduler,
      logger,
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('happy path — returns ok:true with id, agenda_job_id, next_run', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'scheduled_task_create',
      synaps_user_id: 'user-1',
      institution_id: 'inst-1',
      name: 'Test Task',
      cron: '0 9 * * MON',
      channel: '#dev',
      prompt: 'Post digest',
    });
    expect(resp.ok).toBe(true);
    expect(resp.id).toBe('task-1');
    expect(resp.agenda_job_id).toBe('agenda-1');
    expect(scheduler.create).toHaveBeenCalledWith({
      synapsUserId: 'user-1',
      institutionId: 'inst-1',
      name: 'Test Task',
      cron: '0 9 * * MON',
      channel: '#dev',
      prompt: 'Post digest',
    });
  });

  it('NoopScheduler — returns code:scheduler_disabled', async () => {
    const sp2 = tmpSocketPath();
    const cs2 = new ControlSocket({
      socketPath: sp2,
      sessionRouter: makeFakeRouter(),
      scheduler: new NoopScheduler(),
      logger: makeLogger(),
    });
    await cs2.start();
    const resp = await sendRequest(sp2, {
      op: 'scheduled_task_create',
      synaps_user_id: 'user-1',
      institution_id: 'inst-1',
      name: 'n',
      cron: '* * * * *',
      channel: 'c',
      prompt: 'p',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('scheduler_disabled');
    await cs2.stop();
  });

  it('missing scheduler — returns code:scheduler_disabled', async () => {
    const sp3 = tmpSocketPath();
    const cs3 = new ControlSocket({
      socketPath: sp3,
      sessionRouter: makeFakeRouter(),
      logger: makeLogger(),
    });
    await cs3.start();
    const resp = await sendRequest(sp3, {
      op: 'scheduled_task_create',
      synaps_user_id: 'u',
      institution_id: 'i',
      name: 'n',
      cron: '* * * * *',
      channel: 'c',
      prompt: 'p',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('scheduler_disabled');
    await cs3.stop();
  });

  it('missing synaps_user_id — code:invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'scheduled_task_create',
      institution_id: 'inst-1',
      name: 'n',
      cron: '* * * * *',
      channel: 'c',
      prompt: 'p',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
  });

  it('missing cron — code:invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'scheduled_task_create',
      synaps_user_id: 'u',
      institution_id: 'i',
      name: 'n',
      channel: 'c',
      prompt: 'p',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
  });
});

// ─── op: scheduled_task_list ──────────────────────────────────────────────────

describe('ControlSocket — op: scheduled_task_list', () => {
  let socketPath, cs, scheduler;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    scheduler  = makeFakeScheduler();
    scheduler.list.mockResolvedValue([
      { _id: 'task-1', name: 'Task 1', cron: '* * * * *' },
    ]);
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      scheduler,
      logger: makeLogger(),
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('happy path — returns ok:true with tasks array', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'scheduled_task_list',
      synaps_user_id: 'user-1',
    });
    expect(resp.ok).toBe(true);
    expect(Array.isArray(resp.tasks)).toBe(true);
    expect(resp.tasks).toHaveLength(1);
    expect(scheduler.list).toHaveBeenCalledWith({ synapsUserId: 'user-1' });
  });

  it('NoopScheduler — returns code:scheduler_disabled', async () => {
    const sp2 = tmpSocketPath();
    const cs2 = new ControlSocket({
      socketPath: sp2,
      sessionRouter: makeFakeRouter(),
      scheduler: new NoopScheduler(),
      logger: makeLogger(),
    });
    await cs2.start();
    const resp = await sendRequest(sp2, {
      op: 'scheduled_task_list',
      synaps_user_id: 'u',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('scheduler_disabled');
    await cs2.stop();
  });

  it('missing synaps_user_id — code:invalid_request', async () => {
    const resp = await sendRequest(socketPath, { op: 'scheduled_task_list' });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
  });
});

// ─── op: scheduled_task_remove ────────────────────────────────────────────────

describe('ControlSocket — op: scheduled_task_remove', () => {
  let socketPath, cs, scheduler, scheduledTaskRepo;

  beforeEach(async () => {
    socketPath         = tmpSocketPath();
    scheduler          = makeFakeScheduler();
    scheduler.remove.mockResolvedValue({ ok: true });
    scheduledTaskRepo  = makeFakeScheduledTaskRepo([
      { _id: 'task-1', synaps_user_id: 'user-1', name: 'My Task' },
    ]);
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      scheduler,
      scheduledTaskRepo,
      logger: makeLogger(),
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('happy path — returns ok:true', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'scheduled_task_remove',
      id: 'task-1',
      synaps_user_id: 'user-1',
    });
    expect(resp.ok).toBe(true);
    expect(scheduler.remove).toHaveBeenCalledWith('task-1');
  });

  it('task not found — returns code:not_found', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'scheduled_task_remove',
      id: 'unknown-task',
      synaps_user_id: 'user-1',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('not_found');
  });

  it('ownership mismatch — returns code:unauthorized', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'scheduled_task_remove',
      id: 'task-1',
      synaps_user_id: 'wrong-user',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('unauthorized');
  });

  it('missing id — code:invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'scheduled_task_remove',
      synaps_user_id: 'user-1',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
  });

  it('scheduler disabled — code:scheduler_disabled', async () => {
    const sp2 = tmpSocketPath();
    const cs2 = new ControlSocket({
      socketPath: sp2,
      sessionRouter: makeFakeRouter(),
      scheduler: new NoopScheduler(),
      logger: makeLogger(),
    });
    await cs2.start();
    const resp = await sendRequest(sp2, {
      op: 'scheduled_task_remove',
      id: 'task-1',
      synaps_user_id: 'user-1',
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('scheduler_disabled');
    await cs2.stop();
  });
});

// ─── op: hook_create ─────────────────────────────────────────────────────────

describe('ControlSocket — op: hook_create', () => {
  let socketPath, cs, hookBus, hookRepo;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    hookBus    = makeFakeHookBus();
    hookRepo   = makeFakeHookRepo();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      hookBus,
      hookRepo,
      logger: makeLogger(),
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  const goodHookReq = {
    op: 'hook_create',
    scope: { type: 'user', id: 'user-1' },
    event: 'pre_tool',
    action: { type: 'webhook', config: { url: 'https://example.com/hook', secret: 'mysecret' } },
    enabled: true,
  };

  it('happy path — returns ok:true with id', async () => {
    const resp = await sendRequest(socketPath, goodHookReq);
    expect(resp.ok).toBe(true);
    expect(typeof resp.id).toBe('string');
    expect(hookRepo.create).toHaveBeenCalledOnce();
  });

  it('NoopHookBus — returns code:hooks_disabled', async () => {
    const sp2 = tmpSocketPath();
    const cs2 = new ControlSocket({
      socketPath: sp2,
      sessionRouter: makeFakeRouter(),
      hookBus: new NoopHookBus(),
      hookRepo,
      logger: makeLogger(),
    });
    await cs2.start();
    const resp = await sendRequest(sp2, goodHookReq);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('hooks_disabled');
    await cs2.stop();
  });

  it('missing hookBus — returns code:hooks_disabled', async () => {
    const sp3 = tmpSocketPath();
    const cs3 = new ControlSocket({
      socketPath: sp3,
      sessionRouter: makeFakeRouter(),
      hookRepo,
      logger: makeLogger(),
    });
    await cs3.start();
    const resp = await sendRequest(sp3, goodHookReq);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('hooks_disabled');
    await cs3.stop();
  });

  it('missing event — code:invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'hook_create',
      scope: { type: 'global' },
      action: { type: 'webhook', config: {} },
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
    expect(resp.error).toMatch(/event/);
  });

  it('missing scope — code:invalid_request', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'hook_create',
      event: 'pre_tool',
      action: { type: 'webhook', config: {} },
    });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
    expect(resp.error).toMatch(/scope/);
  });
});

// ─── op: hook_list ───────────────────────────────────────────────────────────

describe('ControlSocket — op: hook_list', () => {
  let socketPath, cs, hookBus, hookRepo;
  const SECRET = 'super-secret-do-not-leak';

  const fakeHooks = [
    {
      _id: 'hook-1',
      scope: { type: 'user', id: 'user-1' },
      event: 'pre_tool',
      action: {
        type: 'webhook',
        config: { url: 'https://example.com/hook', secret: SECRET },
      },
      enabled: true,
    },
  ];

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    hookBus    = makeFakeHookBus();
    hookRepo   = makeFakeHookRepo(fakeHooks);
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      hookBus,
      hookRepo,
      logger: makeLogger(),
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('returns ok:true with hooks array', async () => {
    const resp = await sendRequest(socketPath, { op: 'hook_list' });
    expect(resp.ok).toBe(true);
    expect(Array.isArray(resp.hooks)).toBe(true);
    expect(resp.hooks).toHaveLength(1);
  });

  it('SANITIZATION: action.config.secret is redacted to "<redacted>"', async () => {
    const resp = await sendRequest(socketPath, { op: 'hook_list' });
    expect(resp.ok).toBe(true);
    const hook = resp.hooks[0];
    expect(hook.action.config.secret).toBe('<redacted>');
  });

  it('SANITIZATION: secret literal value never appears anywhere in response', async () => {
    const resp = await sendRequest(socketPath, { op: 'hook_list' });
    // Deep-search the entire response string for the secret.
    const responseStr = JSON.stringify(resp);
    expect(responseStr).not.toContain(SECRET);
  });

  it('NoopHookBus — code:hooks_disabled', async () => {
    const sp2 = tmpSocketPath();
    const cs2 = new ControlSocket({
      socketPath: sp2,
      sessionRouter: makeFakeRouter(),
      hookBus: new NoopHookBus(),
      hookRepo,
      logger: makeLogger(),
    });
    await cs2.start();
    const resp = await sendRequest(sp2, { op: 'hook_list' });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('hooks_disabled');
    await cs2.stop();
  });
});

// ─── op: hook_remove ─────────────────────────────────────────────────────────

describe('ControlSocket — op: hook_remove', () => {
  let socketPath, cs, hookBus, hookRepo;

  const fakeHooks = [{ _id: 'hook-1', event: 'pre_tool' }];

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    hookBus    = makeFakeHookBus();
    hookRepo   = makeFakeHookRepo(fakeHooks);
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      hookBus,
      hookRepo,
      logger: makeLogger(),
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('happy path — returns ok:true', async () => {
    const resp = await sendRequest(socketPath, { op: 'hook_remove', id: 'hook-1' });
    expect(resp.ok).toBe(true);
    expect(hookRepo.remove).toHaveBeenCalledWith('hook-1');
  });

  it('not found — returns code:not_found', async () => {
    const resp = await sendRequest(socketPath, { op: 'hook_remove', id: 'nonexistent' });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('not_found');
  });

  it('missing id — code:invalid_request', async () => {
    const resp = await sendRequest(socketPath, { op: 'hook_remove' });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('invalid_request');
    expect(resp.error).toMatch(/id/);
  });

  it('NoopHookBus — code:hooks_disabled', async () => {
    const sp2 = tmpSocketPath();
    const cs2 = new ControlSocket({
      socketPath: sp2,
      sessionRouter: makeFakeRouter(),
      hookBus: new NoopHookBus(),
      hookRepo,
      logger: makeLogger(),
    });
    await cs2.start();
    const resp = await sendRequest(sp2, { op: 'hook_remove', id: 'hook-1' });
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe('hooks_disabled');
    await cs2.stop();
  });
});

// ─── op: mcp_token_issue / mcp_token_list / mcp_token_revoke ─────────────────

import { createHash } from 'node:crypto';
import { hashToken }  from './core/mcp/mcp-token-resolver.js';

/**
 * Build a simple in-memory fake McpTokenRepo.
 *
 * Uses a plain Map so tests can inspect stored rows without needing Mongo.
 * Mirrors the real McpTokenRepo API.
 */
function makeFakeMcpTokenRepo() {
  const store = new Map(); // _id (string) → row
  let idCounter = 0;

  function nextId() { return `tok-id-${++idCounter}`; }

  return {
    _store: store,

    async create({ token_hash, synaps_user_id, institution_id, name, expires_at = null, scopes }) {
      const _id        = nextId();
      const created_at = new Date();
      const row = {
        _id, token_hash, synaps_user_id, institution_id, name,
        expires_at, scopes: scopes ?? ['*'],
        last_used_at: null, revoked_at: null, created_at,
      };
      store.set(_id, row);
      return { _id, name, expires_at, created_at };
    },

    async findActive(token_hash) {
      const now = Date.now();
      for (const row of store.values()) {
        if (row.token_hash !== token_hash) continue;
        if (row.revoked_at) continue;
        if (row.expires_at && row.expires_at.getTime() < now) continue;
        return { _id: row._id, synaps_user_id: row.synaps_user_id, institution_id: row.institution_id, name: row.name, scopes: row.scopes };
      }
      return null;
    },

    async list(q) {
      let rows = Array.from(store.values());
      if (q.synaps_user_id != null) rows = rows.filter((r) => r.synaps_user_id === q.synaps_user_id);
      if (q.institution_id != null) rows = rows.filter((r) => r.institution_id === q.institution_id);
      // Return without token_hash, sorted newest first
      return rows.map((r) => ({
        _id:          r._id,
        name:         r.name,
        last_used_at: r.last_used_at,
        expires_at:   r.expires_at,
        revoked_at:   r.revoked_at,
        created_at:   r.created_at,
      })).sort((a, b) => b.created_at - a.created_at);
    },

    async revoke(token_id) {
      const row = store.get(String(token_id));
      if (!row) return { ok: false };
      if (row.revoked_at) return { ok: true }; // idempotent
      row.revoked_at = new Date();
      return { ok: true };
    },

    async touch(token_id) {
      const row = store.get(String(token_id));
      if (row) row.last_used_at = new Date();
    },
  };
}

// ── MCP token ops ─────────────────────────────────────────────────────────────

describe('ControlSocket — MCP token ops — mcp_disabled (no repo)', () => {
  let socketPath, cs;

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      // mcpTokenRepo intentionally omitted → null
      logger: makeLogger(),
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('mcp_token_issue → ok:false error:mcp_disabled', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'u1', institution_id: 'i1', name: 'smoke',
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('mcp_disabled');
  });

  it('mcp_token_list → ok:false error:mcp_disabled', async () => {
    const resp = await sendRequest(socketPath, { op: 'mcp_token_list' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('mcp_disabled');
  });

  it('mcp_token_revoke → ok:false error:mcp_disabled', async () => {
    const resp = await sendRequest(socketPath, { op: 'mcp_token_revoke', token_id: 'abc' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('mcp_disabled');
  });
});

describe('ControlSocket — op: mcp_token_issue', () => {
  let socketPath, cs, mcpTokenRepo;

  beforeEach(async () => {
    socketPath   = tmpSocketPath();
    mcpTokenRepo = makeFakeMcpTokenRepo();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      mcpTokenRepo,
      logger: makeLogger(),
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('missing synaps_user_id → ok:false error:missing_fields', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'mcp_token_issue', institution_id: 'i1', name: 'smoke',
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('missing_fields');
  });

  it('missing institution_id → ok:false error:missing_fields', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'u1', name: 'smoke',
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('missing_fields');
  });

  it('missing name → ok:false error:missing_fields', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'u1', institution_id: 'i1',
    });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('missing_fields');
  });

  it('valid input → ok:true, token, _id, name, expires_at, created_at', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'u1', institution_id: 'i1', name: 'desktop',
    });
    expect(resp.ok).toBe(true);
    expect(typeof resp.token).toBe('string');
    expect(typeof resp._id).toBe('string');
    expect(resp.name).toBe('desktop');
    expect(resp.expires_at).toBeNull();
    expect(typeof resp.created_at).toBe('string'); // JSON serialised to ISO string
  });

  it('token is a 64-char hex string', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'u1', institution_id: 'i1', name: 'hex-check',
    });
    expect(resp.ok).toBe(true);
    expect(resp.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two calls with same input produce different tokens', async () => {
    const r1 = await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'u1', institution_id: 'i1', name: 'same',
    });
    const r2 = await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'u1', institution_id: 'i1', name: 'same',
    });
    expect(r1.token).not.toBe(r2.token);
  });

  it('stored row hash matches sha256(token)', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'u1', institution_id: 'i1', name: 'hash-check',
    });
    expect(resp.ok).toBe(true);
    const expectedHash = createHash('sha256').update(resp.token).digest('hex');
    // Also verify via hashToken helper
    expect(hashToken(resp.token)).toBe(expectedHash);
    // Verify repo can find the token with the expected hash
    const found = await mcpTokenRepo.findActive(expectedHash);
    expect(found).not.toBeNull();
    expect(String(found._id)).toBe(resp._id);
  });

  it('accepts expires_at ISO string and stores as Date', async () => {
    const expiresAt = new Date(Date.now() + 86400_000).toISOString();
    const resp = await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'u1', institution_id: 'i1', name: 'expiry-test',
      expires_at: expiresAt,
    });
    expect(resp.ok).toBe(true);
    // expires_at is returned in response (serialised as ISO string or null)
    expect(resp.expires_at).not.toBeNull();
    // Check the stored row in repo
    const row = Array.from(mcpTokenRepo._store.values()).find((r) => r.name === 'expiry-test');
    expect(row.expires_at).toBeInstanceOf(Date);
    expect(row.expires_at.toISOString()).toBe(expiresAt);
  });
});

describe('ControlSocket — op: mcp_token_list', () => {
  let socketPath, cs, mcpTokenRepo;

  beforeEach(async () => {
    socketPath   = tmpSocketPath();
    mcpTokenRepo = makeFakeMcpTokenRepo();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      mcpTokenRepo,
      logger: makeLogger(),
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('returns ok:true, tokens:[] when none exist', async () => {
    const resp = await sendRequest(socketPath, { op: 'mcp_token_list' });
    expect(resp.ok).toBe(true);
    expect(resp.tokens).toEqual([]);
  });

  it('with synaps_user_id filter — returns only that user\'s tokens', async () => {
    // Issue tokens for two different users
    await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'user-A', institution_id: 'inst-1', name: 'a-tok',
    });
    await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'user-B', institution_id: 'inst-1', name: 'b-tok',
    });
    const resp = await sendRequest(socketPath, {
      op: 'mcp_token_list', synaps_user_id: 'user-A',
    });
    expect(resp.ok).toBe(true);
    expect(resp.tokens).toHaveLength(1);
    expect(resp.tokens[0].name).toBe('a-tok');
  });

  it('with institution_id filter — returns only that institution\'s tokens', async () => {
    await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'user-A', institution_id: 'inst-X', name: 'x-tok',
    });
    await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'user-A', institution_id: 'inst-Y', name: 'y-tok',
    });
    const resp = await sendRequest(socketPath, {
      op: 'mcp_token_list', institution_id: 'inst-X',
    });
    expect(resp.ok).toBe(true);
    expect(resp.tokens).toHaveLength(1);
    expect(resp.tokens[0].name).toBe('x-tok');
  });

  it('response rows do NOT include token_hash', async () => {
    await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'u1', institution_id: 'i1', name: 'no-hash',
    });
    const resp = await sendRequest(socketPath, { op: 'mcp_token_list' });
    expect(resp.ok).toBe(true);
    expect(resp.tokens).toHaveLength(1);
    expect(resp.tokens[0]).not.toHaveProperty('token_hash');
  });

  it('_id in response is a string (not ObjectId)', async () => {
    await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'u1', institution_id: 'i1', name: 'str-id',
    });
    const resp = await sendRequest(socketPath, { op: 'mcp_token_list' });
    expect(resp.ok).toBe(true);
    expect(typeof resp.tokens[0]._id).toBe('string');
  });
});

describe('ControlSocket — op: mcp_token_revoke', () => {
  let socketPath, cs, mcpTokenRepo;

  beforeEach(async () => {
    socketPath   = tmpSocketPath();
    mcpTokenRepo = makeFakeMcpTokenRepo();
    cs = new ControlSocket({
      socketPath,
      sessionRouter: makeFakeRouter(),
      mcpTokenRepo,
      logger: makeLogger(),
    });
    await cs.start();
  });

  afterEach(async () => { await cs.stop(); });

  it('missing token_id → ok:false error:missing_fields', async () => {
    const resp = await sendRequest(socketPath, { op: 'mcp_token_revoke' });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe('missing_fields');
  });

  it('valid token_id → ok:true', async () => {
    const issued = await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'u1', institution_id: 'i1', name: 'to-revoke',
    });
    const resp = await sendRequest(socketPath, {
      op: 'mcp_token_revoke', token_id: issued._id,
    });
    expect(resp.ok).toBe(true);
  });

  it('unknown token_id → ok:false', async () => {
    const resp = await sendRequest(socketPath, {
      op: 'mcp_token_revoke', token_id: 'nonexistent-id',
    });
    expect(resp.ok).toBe(false);
  });

  it('after revoke, findActive returns null for that token', async () => {
    const issued = await sendRequest(socketPath, {
      op: 'mcp_token_issue', synaps_user_id: 'u1', institution_id: 'i1', name: 'rev-check',
    });
    // Compute hash of the raw token
    const expectedHash = createHash('sha256').update(issued.token).digest('hex');
    // Confirm it's findable before revoke
    const beforeRevoke = await mcpTokenRepo.findActive(expectedHash);
    expect(beforeRevoke).not.toBeNull();

    await sendRequest(socketPath, { op: 'mcp_token_revoke', token_id: issued._id });

    // After revoke it should be null
    const afterRevoke = await mcpTokenRepo.findActive(expectedHash);
    expect(afterRevoke).toBeNull();
  });
});
