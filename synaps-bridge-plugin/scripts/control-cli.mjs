#!/usr/bin/env node
/**
 * control-cli.mjs — thin CLI over the synaps-bridge control socket.
 *
 * Usage:
 *   control-cli.mjs <op> [positional...] [--socket=PATH] [--format=table|json|text]
 *
 * Ops:
 *   threads                  List active bridge sessions.
 *   status                   Show daemon status.
 *   model <key> <model>      Change the model for a session.
 *   reap  <key>              Forcibly reap a session.
 */

import {
  sendOp,
  defaultSocketPath,
  formatThreadsTable,
  formatStatus,
} from './control-cli-lib.mjs';

// ---------------------------------------------------------------------------
// Minimal argv parser
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function die(msg, exitCode = 1) {
  process.stderr.write(msg + '\n');
  process.exit(exitCode);
}

function handleError(err) {
  if (err.code === 'DAEMON_NOT_RUNNING') {
    die(
      'synaps-bridge daemon is not running. Start it with: synaps bridge start',
      2
    );
  }
  die(`error: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { positional, flags } = parseArgs(process.argv.slice(2));

const socketPath = flags['socket'] || defaultSocketPath();
const format = flags['format'] || null; // null = use per-op default

const [op, ...rest] = positional;

if (!op || op === 'help' || op === '--help' || op === '-h') {
  process.stdout.write(
    [
      'Usage: control-cli.mjs <op> [args] [--socket=PATH] [--format=table|json|text]',
      '',
      'Ops:',
      '  threads                  List active bridge sessions (default format: table)',
      '  status                   Show daemon status (default format: text)',
      '  model <key> <model>      Change model for a session',
      '  reap  <key>              Forcibly reap a session',
      '',
    ].join('\n')
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Op routing
// ---------------------------------------------------------------------------

(async () => {
  try {
    switch (op) {
      case 'threads': {
        const res = await sendOp({ socketPath, op: 'threads' });
        if (!res.ok) {
          die(`error: ${res.error || 'unknown error from daemon'}`);
        }
        const fmt = format || 'table';
        if (fmt === 'json') {
          process.stdout.write(JSON.stringify(res.threads, null, 2) + '\n');
        } else {
          process.stdout.write(formatThreadsTable(res.threads) + '\n');
        }
        break;
      }

      case 'status': {
        const res = await sendOp({ socketPath, op: 'status' });
        if (!res.ok) {
          die(`error: ${res.error || 'unknown error from daemon'}`);
        }
        const fmt = format || 'text';
        if (fmt === 'json') {
          process.stdout.write(JSON.stringify(res, null, 2) + '\n');
        } else {
          process.stdout.write(formatStatus(res) + '\n');
        }
        break;
      }

      case 'model': {
        const [key, model] = rest;
        if (!key || !model) {
          die('error: model requires two arguments: <key> <model>');
        }
        const res = await sendOp({ socketPath, op: 'model', params: { key, model } });
        if (!res.ok) {
          die(`error: ${res.error || 'unknown error from daemon'}`);
        }
        process.stdout.write('OK\n');
        break;
      }

      case 'reap': {
        const [key] = rest;
        if (!key) {
          die('error: reap requires one argument: <key>');
        }
        const res = await sendOp({ socketPath, op: 'reap', params: { key } });
        if (!res.ok) {
          die(`error: ${res.error || 'unknown error from daemon'}`);
        }
        process.stdout.write('OK\n');
        break;
      }

      default:
        die(`error: unknown op '${op}'. Run with --help for usage.`);
    }
  } catch (err) {
    handleError(err);
  }
})();
