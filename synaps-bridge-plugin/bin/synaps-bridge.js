#!/usr/bin/env node
/**
 * @file bin/synaps-bridge.js
 *
 * Daemon entrypoint for synaps-bridge.
 *
 * Parses CLI flags, loads bridge.toml, builds a structured logger, constructs
 * and starts BridgeDaemon, then installs signal / uncaught-exception handlers.
 *
 * Top-level await is intentional here — this is the process root, not a library.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadBridgeConfig } from '../bridge/config.js';
import { BridgeDaemon } from '../bridge/index.js';

// ─── package.json version ────────────────────────────────────────────────────

// ESM-friendly way to read package.json without top-level await on fs.
const _require = createRequire(import.meta.url);
const pkg = _require('../package.json');
const VERSION = pkg.version ?? '0.1.0';

// ─── CLI arg parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { configPath: null, logLevel: null, help: false, version: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { result.help = true; }
    else if (a === '--version' || a === '-v') { result.version = true; }
    else if (a === '--config') { result.configPath = args[++i] ?? null; }
    else if (a === '--log-level') { result.logLevel = args[++i] ?? null; }
  }
  return result;
}

const cliArgs = parseArgs(process.argv);

if (cliArgs.version) {
  process.stdout.write(`synaps-bridge ${VERSION}\n`);
  process.exit(0);
}

if (cliArgs.help) {
  process.stdout.write(`\
synaps-bridge ${VERSION}
Multi-source, multi-thread conversation bridge daemon.

Usage:
  synaps-bridge [options]

Options:
  --config <path>      Path to bridge.toml (default: ~/.synaps-cli/bridge/bridge.toml)
  --log-level <level>  Override log level: debug | info | warn | error
  --version, -v        Print version and exit
  --help, -h           Print this help and exit
`);
  process.exit(0);
}

// ─── load config ─────────────────────────────────────────────────────────────

const config = await loadBridgeConfig({
  path: cliArgs.configPath ?? undefined,
  logger: console,
});

// ─── structured logger ───────────────────────────────────────────────────────

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };

const effectiveLevel = cliArgs.logLevel ?? config.bridge.log_level;
const levelThreshold = LEVEL_ORDER[effectiveLevel] ?? LEVEL_ORDER.info;

/**
 * Format a timestamp as ISO-8601 (no fractional seconds).
 * @returns {string}
 */
function ts() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function makeLogger() {
  const fmt = (parts) =>
    parts
      .map((p) => {
        if (p instanceof Error) return p.stack || p.message;
        if (typeof p === 'string') return p;
        try { return JSON.stringify(p); } catch { return String(p); }
      })
      .join(' ');

  const write = (level, ...parts) => {
    if ((LEVEL_ORDER[level] ?? 0) < levelThreshold) return;
    const line = `[${ts()}] [${level}] ${fmt(parts)}`;
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  };

  return {
    debug: (...a) => write('debug', ...a),
    info:  (...a) => write('info',  ...a),
    warn:  (...a) => write('warn',  ...a),
    error: (...a) => write('error', ...a),
  };
}

const logger = makeLogger();

// ─── daemon ───────────────────────────────────────────────────────────────────

const daemon = new BridgeDaemon({
  config,
  logger,
  env: process.env,
});

// ─── signal handlers ─────────────────────────────────────────────────────────

async function gracefulShutdown(signal) {
  logger.info(`Received ${signal} — shutting down`);
  try {
    await daemon.stop({ signal });
  } catch (err) {
    logger.error(`Error during shutdown: ${err.message}`);
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', async (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  try {
    await daemon.stop({ signal: 'uncaughtException' });
  } catch {
    // best-effort
  }
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error(`Unhandled rejection: ${msg}`);
  try {
    await daemon.stop({ signal: 'unhandledRejection' });
  } catch {
    // best-effort
  }
  process.exit(1);
});

// ─── start ───────────────────────────────────────────────────────────────────

logger.info(`synaps-bridge ${VERSION} starting`);
try {
  await daemon.start();
  logger.info('synaps-bridge ready');
} catch (err) {
  logger.error(`Failed to start daemon: ${err.message}`);
  process.exit(1);
}
