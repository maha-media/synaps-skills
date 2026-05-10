/**
 * @file 04-control-socket-threads.test.mjs
 *
 * E2E test: after starting a session, query the control socket via
 * node:net for the 'threads' and 'status' ops.
 *
 * Verifies §5.6 / §10.3:
 *   - {"op":"threads"} → {ok:true, threads:[{key:"slack:…", model:…}]}
 *   - {"op":"status"}  → {ok:true, sessions:N, version:"0.1.0"}
 */

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { buildDaemon, waitFor, findCalls, tmpStateDir, cleanupStateDir } from './helpers.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Open a connection to the control socket, send one JSON op, receive a JSON
 * response, and close.
 *
 * @param {string} sockPath
 * @param {object} op
 * @returns {Promise<object>}
 */
function queryControlSocket(sockPath, op) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(sockPath, () => {
      client.write(JSON.stringify(op) + '\n');
    });

    let buf = '';
    client.setEncoding('utf8');
    client.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        client.destroy();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(new Error(`control socket returned malformed JSON: ${line}`));
        }
      }
    });

    client.on('error', reject);
    client.on('close', () => {
      if (buf.trim() && !buf.includes('\n')) {
        reject(new Error('connection closed before response'));
      }
    });
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('04 — control socket threads', () => {
  let daemon, fakeApp, stateDir, sockPath;

  afterEach(async () => {
    if (daemon) {
      await daemon.stop().catch(() => {});
      daemon = null;
    }
    if (stateDir) {
      cleanupStateDir(stateDir);
      stateDir = null;
    }
  });

  it('threads op lists active session; status op returns sessions count', async () => {
    stateDir = tmpStateDir();
    ({ daemon, fakeApp, sockPath } = buildDaemon({ stateDir, defaultModel: 'fake-ctrl-model' }));
    await daemon.start();

    // Inject a message to create a session.
    await fakeApp.injectEvent('message', {
      channel: 'C004',
      channel_type: 'im',
      ts: '444.001',
      thread_ts: '444.001',
      text: 'ack please',
      user: 'U004',
      files: [],
    });

    // Wait until the session is live in the router.
    await waitFor(
      () => daemon._sessionRouter.liveSessions().length >= 1,
      { timeoutMs: 2000, message: 'expected at least 1 live session' },
    );

    // ── op: threads ───────────────────────────────────────────────────────

    const threadsResp = await queryControlSocket(sockPath, { op: 'threads' });

    // 1. ok: true.
    expect(threadsResp.ok).toBe(true);

    // 2. threads array has at least one entry.
    expect(Array.isArray(threadsResp.threads)).toBe(true);
    expect(threadsResp.threads.length).toBeGreaterThanOrEqual(1);

    // 3. First entry has a key matching 'slack:C004:444.001'.
    const thread = threadsResp.threads.find((t) => t.key === 'slack:C004:444.001');
    expect(thread).toBeDefined();
    expect(thread.key).toBe('slack:C004:444.001');

    // ── op: status ────────────────────────────────────────────────────────

    const statusResp = await queryControlSocket(sockPath, { op: 'status' });

    // 4. ok: true, sessions >= 1, version matches.
    expect(statusResp.ok).toBe(true);
    expect(statusResp.sessions).toBeGreaterThanOrEqual(1);
    expect(statusResp.version).toBe('0.1.0');
  });
});
