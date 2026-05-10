/**
 * @file helpers.mjs
 *
 * Shared utilities for the bridge e2e test harness.
 *
 * Exports:
 *   buildDaemon()   — construct BridgeDaemon with fake rpc + fake Bolt
 *   waitFor()       — poll until predicate is truthy
 *   findCalls()     — filter recorded Bolt calls
 *   tmpStateDir()   — create a temp dir for test isolation
 */

import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BridgeDaemon } from '../../bridge/index.js';
import { SlackAdapter } from '../../bridge/sources/slack/index.js';
import { SessionRouter } from '../../bridge/core/session-router.js';
import { SessionStore } from '../../bridge/core/session-store.js';
import { SynapsRpc } from '../../bridge/core/synaps-rpc.js';
import { ControlSocket } from '../../bridge/control-socket.js';
import { makeBoltAppFactory } from './fake-bolt-client.mjs';

// Resolve the fake rpc binary path.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_RPC_BINARY = path.join(__dirname, 'fake-synaps-rpc.mjs');

// ── resolveNodeBinary ─────────────────────────────────────────────────────────

/**
 * Find a real Node.js ELF binary that can be used with child_process.spawn()
 * when passing an .mjs file as the first argument.
 *
 * In the vitest vmThreads pool, process.execPath may be a shell wrapper
 * (/home/jr/.local/bin/node) whose shebang calls `exec ld-linux … /usr/bin/node`.
 * When child_process.spawn() uses that wrapper as the binary, ld-linux tries to
 * dlopen() the .mjs script as a shared library → "invalid ELF header".
 *
 * We detect ELF files by reading the first 4 bytes (magic = 0x7f 'E' 'L' 'F').
 *
 * @returns {string}
 */
function resolveNodeBinary() {
  const candidates = ['/usr/bin/node', '/usr/local/bin/node', process.execPath];
  for (const candidate of candidates) {
    try {
      const header = readFileSync(candidate, { flag: 'r' }).slice(0, 4);
      // ELF magic: 0x7F, 0x45 ('E'), 0x4C ('L'), 0x46 ('F')
      if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
        return candidate;
      }
    } catch { /* skip */ }
  }
  // Fallback — hope for the best.
  return process.execPath;
}

const NODE_BINARY = resolveNodeBinary();

// ── tmpStateDir ───────────────────────────────────────────────────────────────

/**
 * Create a unique temp directory for one test's state (sessions.json, control.sock).
 * @returns {string} Absolute path to the new directory.
 */
export function tmpStateDir() {
  const base = path.join(os.tmpdir(), 'synaps-bridge-e2e-');
  return mkdtempSync(base);
}

/**
 * Remove a temp state directory (best-effort, ignores errors).
 * @param {string} dir
 */
export function cleanupStateDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

// ── makeFakeRpcSpawn ──────────────────────────────────────────────────────────

/**
 * Build a custom _spawn function that ignores the real `synaps` binary and
 * instead spawns `node <fake-script> [original-flags-minus-rpc-positional]`.
 *
 * SynapsRpc calls: spawn(binPath, ['rpc', '--model', 'x', ...extra], opts)
 * We intercept and call: spawn(node, [fakeScript, '--model', 'x', ...extra], opts)
 *
 * @param {string} fakeScript  - Absolute path to fake-synaps-rpc.mjs.
 * @returns {Function}
 */
function makeFakeRpcSpawn(fakeScript) {
  return function fakeSpawn(_binPath, argv, opts) {
    // argv[0] is always 'rpc' (the positional from buildArgv in synaps-rpc.js).
    // Strip it; everything after is the real flags.
    const flags = argv.slice(1); // e.g. ['--model', 'fake-model']
    return spawn(NODE_BINARY, [fakeScript, ...flags], opts);
  };
}

// ── buildDaemon ───────────────────────────────────────────────────────────────

/**
 * Build and return a BridgeDaemon wired to:
 *  - The fake rpc binary (fake-synaps-rpc.mjs via Node.js)
 *  - A FakeBoltApp instance (no real Slack connection)
 *  - A unique tmp state dir (sessions.json + control.sock)
 *
 * @param {object}  [opts]
 * @param {string}  [opts.fakeRpcScript]   - Override the fake rpc script path.
 * @param {string}  [opts.stateDir]        - Tmp dir for sessions + socket.
 * @param {boolean} [opts.slackEnabled]    - Whether to enable the Slack source (default: true).
 * @param {string}  [opts.defaultModel]    - Default model name (default: 'fake-model').
 *
 * @returns {{ daemon: BridgeDaemon, fakeApp: import('./fake-bolt-client.mjs').FakeBoltApp, stateDir: string, sockPath: string }}
 */
export function buildDaemon({
  fakeRpcScript = FAKE_RPC_BINARY,
  stateDir = tmpStateDir(),
  slackEnabled = true,
  defaultModel = 'fake-model',
} = {}) {
  // Ensure state dir exists.
  mkdirSync(stateDir, { recursive: true });

  const sockPath = path.join(stateDir, 'control.sock');
  const storePath = path.join(stateDir, 'sessions.json');

  const fakeSpawn = makeFakeRpcSpawn(fakeRpcScript);

  // ── fake bolt factory ─────────────────────────────────────────────────────
  const { factory: boltAppFactory, fakeApp } = makeBoltAppFactory();

  // ── build a minimal config ────────────────────────────────────────────────
  const config = Object.freeze({
    bridge: Object.freeze({
      log_level: 'warn',
      session_idle_timeout_secs: 86400,
      session_dir: stateDir,
    }),
    rpc: Object.freeze({
      binary: 'synaps',  // real binary name (ignored — overridden by _spawn)
      default_model: defaultModel,
      default_profile: '',
    }),
    sources: Object.freeze({
      slack: Object.freeze({
        enabled: slackEnabled,
        bot_token_env: 'SLACK_BOT_TOKEN',
        app_token_env: 'SLACK_APP_TOKEN',
        trigger_word: '@synaps',
        respond_to_dms: true,
        respond_to_mentions: true,
        thread_replies: true,
      }),
    }),
  });

  // Silence logger in tests unless BRIDGE_E2E_VERBOSE is set.
  const logger = process.env.BRIDGE_E2E_VERBOSE
    ? console
    : { debug() {}, info() {}, warn() {}, error() {} };

  // ── session router factory ────────────────────────────────────────────────
  function sessionRouterFactory(cfg, log) {
    const store = new SessionStore({ storePath, logger: log });
    return new SessionRouter({
      store,
      rpcFactory: ({ sessionId = null, model = null } = {}) =>
        new SynapsRpc({
          binPath: 'synaps',  // ignored — _spawn overrides
          sessionId,
          model: model ?? cfg.rpc.default_model,
          logger: log,
          commandTimeoutMs: 10_000,
          spawnTimeoutMs: 5_000,
          _spawn: fakeSpawn,
        }),
      idleTtlMs: cfg.bridge.session_idle_timeout_secs * 1000,
      logger: log,
    });
  }

  // ── slack adapter factory ─────────────────────────────────────────────────
  function slackAdapterFactory({ auth, sessionRouter, logger: log }) {
    return new SlackAdapter({
      boltAppFactory,
      sessionRouter,
      auth,
      logger: log,
    });
  }

  // ── control socket factory ────────────────────────────────────────────────
  function controlSocketFactory({ sessionRouter, logger: log, version }) {
    return new ControlSocket({
      socketPath: sockPath,
      sessionRouter,
      logger: log,
      version,
    });
  }

  // ── fake env (satisfy token validation in readSlackAuth) ─────────────────
  const fakeEnv = {
    ...process.env,
    SLACK_BOT_TOKEN: 'xoxb-fake-token-for-tests',
    SLACK_APP_TOKEN: 'xapp-fake-token-for-tests',
  };

  const daemon = new BridgeDaemon({
    config,
    logger,
    env: fakeEnv,
    sessionRouterFactory,
    slackAdapterFactory,
    controlSocketFactory,
  });

  return { daemon, fakeApp, stateDir, sockPath };
}

// ── waitFor ───────────────────────────────────────────────────────────────────

/**
 * Poll `predicate()` every `intervalMs` until it returns truthy or timeout.
 *
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=2000]
 * @param {number} [opts.intervalMs=20]
 * @param {string} [opts.message]
 * @returns {Promise<void>}
 */
export async function waitFor(predicate, {
  timeoutMs = 2000,
  intervalMs = 20,
  message = 'waitFor timed out',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`${message} (${timeoutMs} ms elapsed)`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── findCalls ─────────────────────────────────────────────────────────────────

/**
 * Return recorded Bolt calls matching a string or regex.
 *
 * @param {import('./fake-bolt-client.mjs').FakeBoltApp} app
 * @param {string|RegExp} pattern
 * @returns {Array<{ api: string, args: object }>}
 */
export function findCalls(app, pattern) {
  return app.findCalls(pattern);
}
