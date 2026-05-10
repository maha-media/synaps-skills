/**
 * control-cli-lib.test.mjs — vitest tests for control-cli-lib.mjs
 *
 * Tests use real Unix domain sockets in os.tmpdir() — no mocking of node:net.
 */

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  sendOp,
  formatThreadsTable,
  formatStatus,
  humanDuration,
  defaultSocketPath,
} from './control-cli-lib.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sockPath = null;
let server = null;

/**
 * Create a temporary UDS server for testing.
 * handler(line: string) → string  (the response to send, including "\n")
 */
function createServer(handler) {
  sockPath = path.join(os.tmpdir(), `test-bridge-${process.pid}-${Date.now()}.sock`);
  // Remove stale socket if it exists.
  try { fs.unlinkSync(sockPath); } catch {}

  server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const response = handler(line);
      conn.write(response);
      conn.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(sockPath, () => resolve(sockPath));
    server.once('error', reject);
  });
}

afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
  if (sockPath) {
    try { fs.unlinkSync(sockPath); } catch {}
    sockPath = null;
  }
});

// ---------------------------------------------------------------------------
// 1. sendOp — round-trip happy path
// ---------------------------------------------------------------------------

describe('sendOp — happy path round-trip', () => {
  it('sends op and receives parsed response', async () => {
    await createServer((line) => {
      const req = JSON.parse(line);
      expect(req.op).toBe('threads');
      return JSON.stringify({ ok: true, threads: [] }) + '\n';
    });

    const res = await sendOp({ socketPath: sockPath, op: 'threads' });
    expect(res).toEqual({ ok: true, threads: [] });
  });

  it('passes extra params in the request', async () => {
    await createServer((line) => {
      const req = JSON.parse(line);
      expect(req.op).toBe('model');
      expect(req.key).toBe('slack:C1:1234');
      expect(req.model).toBe('claude-opus-4-5');
      return JSON.stringify({ ok: true }) + '\n';
    });

    const res = await sendOp({
      socketPath: sockPath,
      op: 'model',
      params: { key: 'slack:C1:1234', model: 'claude-opus-4-5' },
    });
    expect(res.ok).toBe(true);
  });

  it('handles status op response with all fields', async () => {
    const payload = { ok: true, uptime_secs: 3600, sessions: 4, version: '0.1.0' };
    await createServer(() => JSON.stringify(payload) + '\n');

    const res = await sendOp({ socketPath: sockPath, op: 'status' });
    expect(res).toMatchObject(payload);
  });
});

// ---------------------------------------------------------------------------
// 2. sendOp — malformed JSON response → throws BAD_RESPONSE
// ---------------------------------------------------------------------------

describe('sendOp — malformed JSON response', () => {
  it('throws with code BAD_RESPONSE on garbage response', async () => {
    await createServer(() => 'not-json-at-all\n');

    await expect(
      sendOp({ socketPath: sockPath, op: 'threads' })
    ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});

// ---------------------------------------------------------------------------
// 3. sendOp — ENOENT → throws DAEMON_NOT_RUNNING
// ---------------------------------------------------------------------------

describe('sendOp — ENOENT', () => {
  it('throws with code DAEMON_NOT_RUNNING when socket does not exist', async () => {
    const missingPath = path.join(os.tmpdir(), `no-such-socket-${Date.now()}.sock`);

    await expect(
      sendOp({ socketPath: missingPath, op: 'status', timeoutMs: 2000 })
    ).rejects.toMatchObject({ code: 'DAEMON_NOT_RUNNING' });
  });
});

// ---------------------------------------------------------------------------
// 4. sendOp — timeout → throws DAEMON_TIMEOUT
// ---------------------------------------------------------------------------

describe('sendOp — timeout', () => {
  it('throws with code DAEMON_TIMEOUT when server never responds', async () => {
    sockPath = path.join(os.tmpdir(), `timeout-test-${process.pid}-${Date.now()}.sock`);
    try { fs.unlinkSync(sockPath); } catch {}

    // Server accepts connection but never sends anything back.
    server = net.createServer((_conn) => { /* deliberate no-op */ });
    await new Promise((resolve, reject) => {
      server.listen(sockPath, resolve);
      server.once('error', reject);
    });

    await expect(
      sendOp({ socketPath: sockPath, op: 'threads', timeoutMs: 200 })
    ).rejects.toMatchObject({ code: 'DAEMON_TIMEOUT' });
  }, 3000);
});

// ---------------------------------------------------------------------------
// 5. sendOp — server returns multiple lines, only first parsed
// ---------------------------------------------------------------------------

describe('sendOp — multiple lines in response', () => {
  it('parses only the first line and ignores the rest', async () => {
    await createServer(() => {
      return (
        JSON.stringify({ ok: true, threads: [{ key: 'a' }] }) +
        '\n' +
        JSON.stringify({ ok: false, extra: true }) +
        '\n'
      );
    });

    const res = await sendOp({ socketPath: sockPath, op: 'threads' });
    expect(res.ok).toBe(true);
    expect(res.threads).toHaveLength(1);
    // The second line must not have been parsed into the result.
    expect(res).not.toHaveProperty('extra');
  });
});

// ---------------------------------------------------------------------------
// 6. formatThreadsTable — empty list
// ---------------------------------------------------------------------------

describe('formatThreadsTable — empty list', () => {
  it('returns (no live sessions) for an empty array', () => {
    expect(formatThreadsTable([])).toBe('(no live sessions)');
  });

  it('returns (no live sessions) for null/undefined', () => {
    expect(formatThreadsTable(null)).toBe('(no live sessions)');
    expect(formatThreadsTable(undefined)).toBe('(no live sessions)');
  });
});

// ---------------------------------------------------------------------------
// 7. formatThreadsTable — rows align, headers present
// ---------------------------------------------------------------------------

describe('formatThreadsTable — structure', () => {
  const fixedNow = new Date('2026-05-09T12:00:00Z').getTime();
  const lastActive = new Date('2026-05-09T11:57:00Z').toISOString(); // 3 min ago

  const threads = [
    {
      key: 'slack:C123456:1234567890.123456',
      model: 'claude-sonnet-4-6',
      lastActiveAt: lastActive,
      inFlight: true,
      messages: 42,
    },
    {
      key: 'slack:C999:9999.0000',
      model: 'claude-opus-4-5',
      lastActiveAt: lastActive,
      inFlight: false,
      messages: 7,
    },
  ];

  it('includes KEY, MODEL, LAST ACTIVE, IN-FLIGHT, MESSAGES headers', () => {
    const table = formatThreadsTable(threads, { now: fixedNow });
    expect(table).toMatch(/KEY/);
    expect(table).toMatch(/MODEL/);
    expect(table).toMatch(/LAST ACTIVE/);
    expect(table).toMatch(/IN-FLIGHT/);
    expect(table).toMatch(/MESSAGES/);
  });

  it('includes a divider line', () => {
    const table = formatThreadsTable(threads, { now: fixedNow });
    const lines = table.split('\n');
    // Second line should be all dashes.
    expect(lines[1]).toMatch(/^-+$/);
  });

  it('includes the thread keys', () => {
    const table = formatThreadsTable(threads, { now: fixedNow });
    expect(table).toMatch(/slack:C123456/);
    expect(table).toMatch(/slack:C999/);
  });

  it('includes in-flight status', () => {
    const table = formatThreadsTable(threads, { now: fixedNow });
    expect(table).toMatch(/yes/);
    expect(table).toMatch(/no/);
  });

  it('includes message counts', () => {
    const table = formatThreadsTable(threads, { now: fixedNow });
    expect(table).toMatch(/42/);
    expect(table).toMatch(/7/);
  });

  it('includes humanized last-active', () => {
    const table = formatThreadsTable(threads, { now: fixedNow });
    expect(table).toMatch(/3m ago/);
  });

  it('all rows have the same number of lines', () => {
    const table = formatThreadsTable(threads, { now: fixedNow });
    const lines = table.split('\n');
    // header + divider + N rows = 2 + N
    expect(lines.length).toBe(2 + threads.length);
  });
});

// ---------------------------------------------------------------------------
// 8. formatStatus — includes uptime, sessions count, version
// ---------------------------------------------------------------------------

describe('formatStatus', () => {
  it('includes version', () => {
    const out = formatStatus({ ok: true, uptime_secs: 7200, sessions: 3, version: '0.1.0' });
    expect(out).toMatch(/0\.1\.0/);
  });

  it('includes sessions count', () => {
    const out = formatStatus({ ok: true, uptime_secs: 60, sessions: 5, version: '0.1.0' });
    expect(out).toMatch(/5/);
    expect(out).toMatch(/session/i);
  });

  it('includes uptime in human-readable form', () => {
    const out = formatStatus({ ok: true, uptime_secs: 7200, sessions: 1, version: '0.1.0' });
    // 7200 s = 2h
    expect(out).toMatch(/2h ago/);
  });

  it('handles missing fields gracefully', () => {
    const out = formatStatus({});
    expect(out).toMatch(/unknown/i);
    expect(out).toMatch(/0/);
  });
});

// ---------------------------------------------------------------------------
// 9. humanDuration — boundary conditions
// ---------------------------------------------------------------------------

describe('humanDuration', () => {
  it('returns "just now" for 0 ms', () => {
    expect(humanDuration(0)).toBe('just now');
  });

  it('returns "just now" for 4999 ms', () => {
    expect(humanDuration(4999)).toBe('just now');
  });

  it('returns seconds for 5000 ms', () => {
    expect(humanDuration(5000)).toBe('5s ago');
  });

  it('returns seconds for 30 000 ms', () => {
    expect(humanDuration(30_000)).toBe('30s ago');
  });

  it('returns minutes for 90 000 ms (1m)', () => {
    expect(humanDuration(90_000)).toBe('1m ago');
  });

  it('returns minutes for 180 000 ms (3m)', () => {
    expect(humanDuration(180_000)).toBe('3m ago');
  });

  it('returns hours for 3 600 000 ms (1h)', () => {
    expect(humanDuration(3_600_000)).toBe('1h ago');
  });

  it('returns hours for 7 200 000 ms (2h)', () => {
    expect(humanDuration(7_200_000)).toBe('2h ago');
  });

  it('returns days for 86 400 000 ms (1d)', () => {
    expect(humanDuration(86_400_000)).toBe('1d ago');
  });

  it('returns days for 172 800 000 ms (2d)', () => {
    expect(humanDuration(172_800_000)).toBe('2d ago');
  });
});

// ---------------------------------------------------------------------------
// 10. defaultSocketPath — honours SYNAPS_BRIDGE_SOCKET env override
// ---------------------------------------------------------------------------

describe('defaultSocketPath', () => {
  it('returns default path when env is not set', () => {
    const original = process.env.SYNAPS_BRIDGE_SOCKET;
    delete process.env.SYNAPS_BRIDGE_SOCKET;

    const result = defaultSocketPath();
    expect(result).toContain('.synaps-cli');
    expect(result).toContain('bridge');
    expect(result).toContain('control.sock');
    expect(path.isAbsolute(result)).toBe(true);

    if (original !== undefined) process.env.SYNAPS_BRIDGE_SOCKET = original;
  });

  it('returns override when SYNAPS_BRIDGE_SOCKET is set', () => {
    const override = '/tmp/my-custom-bridge.sock';
    process.env.SYNAPS_BRIDGE_SOCKET = override;

    const result = defaultSocketPath();
    expect(result).toBe(override);

    delete process.env.SYNAPS_BRIDGE_SOCKET;
  });
});
