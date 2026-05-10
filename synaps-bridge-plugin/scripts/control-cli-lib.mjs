/**
 * control-cli-lib.mjs — pure socket I/O library for the synaps-bridge control socket.
 *
 * No top-level await. No console.log. Every I/O function is explicit and
 * returns a Promise. Formatting functions are pure (return strings).
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// defaultSocketPath
// ---------------------------------------------------------------------------

/**
 * Returns the path to the control socket.
 * Honours the SYNAPS_BRIDGE_SOCKET environment variable.
 * @returns {string}
 */
export function defaultSocketPath() {
  return (
    process.env.SYNAPS_BRIDGE_SOCKET ||
    path.join(os.homedir(), '.synaps-cli', 'bridge', 'control.sock')
  );
}

// ---------------------------------------------------------------------------
// sendOp
// ---------------------------------------------------------------------------

/**
 * Send a single operation to the daemon over the control Unix socket.
 *
 * @param {object} opts
 * @param {string} opts.socketPath  - Path to the Unix stream socket.
 * @param {string} opts.op          - Operation name (e.g. "threads", "status").
 * @param {object} [opts.params]    - Extra fields merged into the request object.
 * @param {number} [opts.timeoutMs] - Timeout in ms (default 5000).
 * @returns {Promise<object>}       - Parsed response object.
 */
export function sendOp({ socketPath, op, params = {}, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let socket = null;
    let buf = '';

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        socket.destroy();
      }
      reject(err);
    };

    const succeed = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        socket.destroy();
      }
      resolve(value);
    };

    timer = setTimeout(() => {
      const err = new Error(`Timed out waiting for daemon response after ${timeoutMs}ms`);
      err.code = 'DAEMON_TIMEOUT';
      fail(err);
    }, timeoutMs);

    socket = net.createConnection(socketPath);

    socket.once('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        const wrapped = new Error(
          `Cannot connect to synaps-bridge control socket at ${socketPath}: ${err.code}`
        );
        wrapped.code = 'DAEMON_NOT_RUNNING';
        fail(wrapped);
      } else {
        fail(err);
      }
    });

    socket.once('connect', () => {
      const request = JSON.stringify({ op, ...params }) + '\n';
      socket.write(request, 'utf8');
    });

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const newlineIdx = buf.indexOf('\n');
      if (newlineIdx === -1) return; // still waiting for a complete line

      const line = buf.slice(0, newlineIdx);
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        const err = new Error(`Malformed JSON response from daemon: ${JSON.stringify(line)}`);
        err.code = 'BAD_RESPONSE';
        fail(err);
        return;
      }
      succeed(parsed);
    });

    socket.once('end', () => {
      // If we got here without a newline, the daemon closed the connection
      // before we parsed a response.
      if (!settled) {
        if (buf.trim().length > 0) {
          let parsed;
          try {
            parsed = JSON.parse(buf.trim());
            succeed(parsed);
            return;
          } catch {
            // fall through
          }
        }
        const err = new Error('Daemon closed connection without sending a complete response');
        err.code = 'BAD_RESPONSE';
        fail(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// humanDuration
// ---------------------------------------------------------------------------

/**
 * Convert a duration in milliseconds to a human-readable "X ago" string.
 *
 * @param {number} ms
 * @returns {string}
 */
export function humanDuration(ms) {
  if (ms < 5000) return 'just now';

  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;

  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// formatThreadsTable
// ---------------------------------------------------------------------------

const COL_KEY      = 36;
const COL_MODEL    = 24;
const COL_ACTIVE   = 14;
const COL_INFLIGHT = 10;
const COL_MSGS     =  8;

function pad(str, width) {
  const s = String(str ?? '');
  return s.length >= width ? s.slice(0, width - 1) + '…' : s.padEnd(width);
}

function rpad(str, width) {
  const s = String(str ?? '');
  return s.length >= width ? s.slice(0, width) : s.padStart(width);
}

/**
 * Render a fixed-width text table of active bridge threads.
 *
 * @param {Array<object>} threads
 * @param {object} [opts]
 * @param {number} [opts.now] - Current timestamp in ms (default: Date.now())
 * @returns {string}
 */
export function formatThreadsTable(threads, { now = Date.now() } = {}) {
  if (!threads || threads.length === 0) {
    return '(no live sessions)';
  }

  const header =
    pad('KEY', COL_KEY) +
    pad('MODEL', COL_MODEL) +
    pad('LAST ACTIVE', COL_ACTIVE) +
    rpad('IN-FLIGHT', COL_INFLIGHT) +
    rpad('MESSAGES', COL_MSGS);

  const divider = '-'.repeat(COL_KEY + COL_MODEL + COL_ACTIVE + COL_INFLIGHT + COL_MSGS);

  const rows = threads.map((t) => {
    const lastActive = t.lastActiveAt
      ? humanDuration(now - new Date(t.lastActiveAt).getTime())
      : 'unknown';

    return (
      pad(t.key ?? '', COL_KEY) +
      pad(t.model ?? '', COL_MODEL) +
      pad(lastActive, COL_ACTIVE) +
      rpad(t.inFlight ? 'yes' : 'no', COL_INFLIGHT) +
      rpad(t.messages != null ? String(t.messages) : '-', COL_MSGS)
    );
  });

  return [header, divider, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// formatStatus
// ---------------------------------------------------------------------------

/**
 * Render a multi-line status block from the daemon's status response.
 *
 * @param {object} status
 * @param {number} status.uptime_secs
 * @param {number} status.sessions
 * @param {string} status.version
 * @returns {string}
 */
export function formatStatus(status) {
  const uptime = humanDuration((status.uptime_secs ?? 0) * 1000);
  const lines = [
    '─── synaps-bridge daemon ───────────────────────',
    `  version:  ${status.version ?? 'unknown'}`,
    `  uptime:   ${uptime}`,
    `  sessions: ${status.sessions ?? 0} active`,
    '─────────────────────────────────────────────────',
  ];
  return lines.join('\n');
}
