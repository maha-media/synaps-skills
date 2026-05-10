/**
 * @file tests/scp-phase-3/02-control-socket-chat-stream.test.mjs
 *
 * Acceptance tests for the ControlSocket `chat_stream_start` streaming op.
 *
 * Strategy
 * ────────
 * • Inject a fake SessionRouter whose getOrCreateSession() returns a fake
 *   session object with:
 *     - sendUserPrompt()  — async function that emits fake events on `rpc`
 *     - rpc              — EventEmitter that fires 'chunk', 'agent_end', 'error'
 * • ControlSocket is started on a tmp UDS (no real Mongo needed).
 * • Tests connect via net.createConnection, send chat_stream_start, and
 *   collect the sequence of JSONL frames written back before the socket closes.
 *
 * Scenarios (~5 tests)
 * ─────────────────────
 * 1. Fake chunks emitted → socket receives matching {kind:'chunk', chunk} lines
 * 2. agent_end emitted → socket receives {kind:'done'} then closes
 * 3. Error emitted → {kind:'error', message} then closes
 * 4. Client disconnect mid-stream → no listener leaks (rpc.listenerCount === 0)
 * 5. Missing text field → {kind:'error', message:'missing text'}
 *
 * Constraints
 * ───────────
 * • ESM only (.mjs)
 * • No mongo / no real sessions — pure socket + EventEmitter fake
 * • No top-level await
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { ControlSocket } from '../../bridge/control-socket.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function tmpSocket() {
  return path.join(
    os.tmpdir(),
    `scp-p3-stream-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

/**
 * Minimal fake SessionRouter — getOrCreateSession returns a fake rpc that
 * the test drives by calling rpc.emit(…) after the prompt is sent.
 */
function makeFakeSessionRouter(rpc) {
  return {
    async start() {},
    async stop() {},
    async listSessions() { return []; },
    liveSessions() { return []; },
    async closeSession() {},
    async getOrCreateSession() { return rpc; },
  };
}

/**
 * Build a fake RPC object:
 *   rpc.sendUserPrompt(text)   — fulfils immediately (no actual LLM call).
 *   rpc inherits EventEmitter  — tests call rpc.emit('chunk', …) etc.
 */
function makeFakeRpc() {
  const rpc = new EventEmitter();
  rpc.sendUserPrompt = async (_text) => { /* no-op */ };
  return rpc;
}

/**
 * Connect to the UDS, send a JSON request, collect all response lines until
 * the socket closes.  Returns an array of parsed JSON objects.
 */
function streamRequest(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = '';
    const lines = [];

    sock.setEncoding('utf8');
    sock.on('data', (chunk) => { buf += chunk; });
    sock.on('end', () => {
      // Parse each non-empty line.
      for (const line of buf.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          lines.push(JSON.parse(trimmed));
        } catch {
          reject(new Error(`Unparseable line: ${trimmed}`));
          return;
        }
      }
      resolve(lines);
    });
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload) + '\n');
    });
  });
}

// ─── Per-test setup ───────────────────────────────────────────────────────────

let cs;
let socketPath;
let fakeRpc;

beforeEach(async () => {
  socketPath = tmpSocket();
  fakeRpc    = makeFakeRpc();

  cs = new ControlSocket({
    socketPath,
    sessionRouter: makeFakeSessionRouter(fakeRpc),
    logger: silent,
  });
  await cs.start();
});

afterEach(async () => {
  await cs.stop();
  fs.rmSync(socketPath, { force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ControlSocket chat_stream_start — chunk events', () => {
  it('forwards chunk events to the socket as {kind:"chunk", chunk} lines', async () => {
    const chunks = [
      { type: 'markdown_text', text: 'Hello ' },
      { type: 'markdown_text', text: 'world' },
      { type: 'task_update',   status: 'complete', label: 'done' },
    ];

    // Set up: after sendUserPrompt resolves, emit chunks then agent_end.
    fakeRpc.sendUserPrompt = async (_text) => {
      for (const c of chunks) {
        fakeRpc.emit('chunk', c);
      }
      fakeRpc.emit('agent_end');
    };

    const lines = await streamRequest(socketPath, {
      op: 'chat_stream_start',
      synaps_user_id: 'user-abc',
      thread_key: 'web:user-abc:chat-1',
      text: 'hi',
    });

    // Expect 3 chunk frames + 1 done frame.
    const chunkLines = lines.filter((l) => l.kind === 'chunk');
    const doneLines  = lines.filter((l) => l.kind === 'done');

    expect(chunkLines).toHaveLength(3);
    expect(chunkLines[0].chunk).toEqual(chunks[0]);
    expect(chunkLines[1].chunk).toEqual(chunks[1]);
    expect(chunkLines[2].chunk).toEqual(chunks[2]);
    expect(doneLines).toHaveLength(1);
  });
});

describe('ControlSocket chat_stream_start — agent_end terminates stream', () => {
  it('emitting agent_end produces a {kind:"done"} line then socket closes', async () => {
    fakeRpc.sendUserPrompt = async (_text) => {
      fakeRpc.emit('chunk', { type: 'markdown_text', text: 'partial' });
      fakeRpc.emit('agent_end');
    };

    const lines = await streamRequest(socketPath, {
      op: 'chat_stream_start',
      synaps_user_id: 'user-done',
      text: 'ping',
    });

    const last = lines[lines.length - 1];
    expect(last.kind).toBe('done');
    // No subsequent lines after done.
    const afterDone = lines.slice(lines.indexOf(last) + 1);
    expect(afterDone).toHaveLength(0);
  });
});

describe('ControlSocket chat_stream_start — error event', () => {
  it('emitting error produces {kind:"error", message} then socket closes', async () => {
    fakeRpc.sendUserPrompt = async (_text) => {
      fakeRpc.emit('error', new Error('RPC boom'));
    };

    const lines = await streamRequest(socketPath, {
      op: 'chat_stream_start',
      synaps_user_id: 'user-err',
      text: 'anything',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe('error');
    expect(lines[0].message).toBe('RPC boom');
  });
});

describe('ControlSocket chat_stream_start — listener leak prevention', () => {
  it('no listeners remain on fakeRpc after client disconnects mid-stream', async () => {
    // Use a prompt that never finishes naturally — the test will disconnect the
    // client socket before agent_end arrives.
    let promptResolve;
    fakeRpc.sendUserPrompt = () => new Promise((res) => { promptResolve = res; });

    const earlyDisconnect = () => new Promise((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.setEncoding('utf8');
      sock.on('error', reject);
      sock.on('connect', () => {
        sock.write(JSON.stringify({
          op: 'chat_stream_start',
          synaps_user_id: 'user-leak',
          text: 'start',
        }) + '\n');
        // Disconnect immediately after sending the request.
        setTimeout(() => sock.destroy(), 30);
      });
      sock.on('close', resolve);
    });

    await earlyDisconnect();

    // Give the server a tick to process the close event.
    await new Promise((r) => setTimeout(r, 50));

    // All three listeners (chunk, agent_end, error) should be cleaned up.
    expect(fakeRpc.listenerCount('chunk')).toBe(0);
    expect(fakeRpc.listenerCount('agent_end')).toBe(0);
    expect(fakeRpc.listenerCount('error')).toBe(0);

    // Allow the pending prompt to resolve so we don't leave a dangling promise.
    if (promptResolve) promptResolve();
  });
});

describe('ControlSocket chat_stream_start — validation', () => {
  it('missing text field → {kind:"error", message:"missing text"}', async () => {
    const lines = await streamRequest(socketPath, {
      op: 'chat_stream_start',
      synaps_user_id: 'user-xyz',
      // text deliberately omitted
    });

    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe('error');
    expect(lines[0].message).toMatch(/missing text/);
  });
});
