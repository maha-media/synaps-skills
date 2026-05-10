/**
 * @file bridge/config.js
 *
 * Bridge.toml loader.  Reads `~/.synaps-cli/bridge/bridge.toml` (or an
 * override path), merges with defaults, validates, and returns a frozen
 * NormalizedConfig object.
 *
 * No I/O in module scope — all side effects are inside loadBridgeConfig().
 * No top-level await.
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fsDefault } from 'node:fs';
import TOML from '@iarna/toml';

// ─── defaults ────────────────────────────────────────────────────────────────

export const BRIDGE_CONFIG_DEFAULTS = Object.freeze({
  bridge: Object.freeze({
    log_level: 'info',
    session_idle_timeout_secs: 86400,
    session_dir: '~/.synaps-cli/bridge',
  }),
  rpc: Object.freeze({
    binary: 'synaps',
    default_model: 'claude-sonnet-4-6',
    default_profile: '',
  }),
  sources: Object.freeze({
    slack: Object.freeze({
      enabled: true,
      bot_token_env: 'SLACK_BOT_TOKEN',
      app_token_env: 'SLACK_APP_TOKEN',
      trigger_word: '@synaps',
      respond_to_dms: true,
      respond_to_mentions: true,
      thread_replies: true,
    }),
  }),
  platform: Object.freeze({
    mode: 'bridge',  // 'bridge' | 'scp'
  }),
  workspace: Object.freeze({
    image: 'synaps/workspace:0.1.0',
    docker_socket: '/var/run/docker.sock',
    volume_root: '/efs/agents',
    default_cpu: 1.0,
    default_mem_mb: 2048,
    default_pids: 256,
    idle_reap_minutes: 30,
  }),
  web: Object.freeze({
    enabled: false,
    http_port: 0,                       // 0 = pick free port; production sets explicit
    bind: '127.0.0.1',
    trust_proxy_header: 'x-synaps-user-id',
    allowed_origin: '',                 // empty = no CORS allowance
  }),
  mongodb: Object.freeze({
    uri: 'mongodb://localhost/priadb',
  }),
});

/** Default config file path. */
export const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.synaps-cli',
  'bridge',
  'bridge.toml',
);

/** Valid log levels in ascending order. */
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Expand a leading `~` to the user's home directory.
 * Non-string values are returned unchanged.
 *
 * @param {*} p
 * @returns {*}
 */
export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// ─── loadBridgeConfig ─────────────────────────────────────────────────────────

/**
 * @typedef {object} NormalizedConfig
 * @property {{ log_level: string, session_idle_timeout_secs: number, session_dir: string }} bridge
 * @property {{ binary: string, default_model: string, default_profile: string }} rpc
 * @property {{ slack: { enabled: boolean, bot_token_env: string, app_token_env: string, trigger_word: string, respond_to_dms: boolean, respond_to_mentions: boolean, thread_replies: boolean } }} sources
 * @property {{ mode: string }} platform
 * @property {{ image: string, docker_socket: string, volume_root: string, default_cpu: number, default_mem_mb: number, default_pids: number, idle_reap_minutes: number }} workspace
 * @property {{ enabled: boolean, http_port: number, bind: string, trust_proxy_header: string, allowed_origin: string }} web
 * @property {{ uri: string }} mongodb
 */

/**
 * Load and normalise bridge.toml.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.path]     - Override the config file path.
 * @param {object}   [opts.fsImpl]   - fs.promises implementation (injectable for tests).
 * @param {object}   [opts.env]      - process.env equivalent (not used for reading secrets;
 *                                     kept for future expansion / test injection).
 * @param {object}   [opts.logger]   - Logger (default: console).
 * @returns {Promise<NormalizedConfig>}
 */
export async function loadBridgeConfig({
  path: configPath = DEFAULT_CONFIG_PATH,
  fsImpl = fsDefault,
  env = process.env,   // eslint-disable-line no-unused-vars — reserved for future use
  logger = console,
} = {}) {
  const resolvedPath = expandHome(configPath);

  // ── read file ─────────────────────────────────────────────────────────────
  let raw;
  try {
    raw = await fsImpl.readFile(resolvedPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Missing file → return defaults silently.
      return _buildConfig({}, logger);
    }
    throw new Error(`bridge/config: cannot read ${resolvedPath}: ${err.message}`);
  }

  // ── parse TOML ────────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = TOML.parse(raw);
  } catch (err) {
    throw new Error(`bridge/config: malformed TOML in ${resolvedPath}: ${err.message}`);
  }

  return _buildConfig(parsed, logger);
}

// ─── internal: normalise + freeze ────────────────────────────────────────────

/**
 * Merge a parsed (possibly partial) TOML object with defaults,
 * validate fields, and return a frozen NormalizedConfig.
 *
 * @param {object} parsed
 * @param {object} logger
 * @returns {NormalizedConfig}
 */
function _buildConfig(parsed, logger) {
  const D = BRIDGE_CONFIG_DEFAULTS;

  // ── warn on unknown top-level keys ────────────────────────────────────────
  const knownTopLevel = new Set(['bridge', 'rpc', 'sources', 'platform', 'workspace', 'web', 'mongodb']);
  for (const k of Object.keys(parsed)) {
    if (!knownTopLevel.has(k)) {
      logger.warn(`bridge/config: unknown top-level key "${k}" — ignoring`);
    }
  }

  // ── [bridge] ──────────────────────────────────────────────────────────────
  const rawBridge = (parsed.bridge && typeof parsed.bridge === 'object') ? parsed.bridge : {};

  let logLevel = rawBridge.log_level !== undefined ? rawBridge.log_level : D.bridge.log_level;
  if (!VALID_LOG_LEVELS.includes(logLevel)) {
    logger.warn(`bridge/config: invalid log_level "${logLevel}" — falling back to "info"`);
    logLevel = 'info';
  }

  let idleTimeout = rawBridge.session_idle_timeout_secs !== undefined
    ? rawBridge.session_idle_timeout_secs
    : D.bridge.session_idle_timeout_secs;
  if (!Number.isInteger(idleTimeout) || idleTimeout <= 0) {
    logger.warn(
      `bridge/config: invalid session_idle_timeout_secs "${idleTimeout}" — falling back to ${D.bridge.session_idle_timeout_secs}`,
    );
    idleTimeout = D.bridge.session_idle_timeout_secs;
  }

  const rawSessionDir = rawBridge.session_dir !== undefined
    ? rawBridge.session_dir
    : D.bridge.session_dir;
  const sessionDir = expandHome(rawSessionDir);

  // ── [rpc] ─────────────────────────────────────────────────────────────────
  const rawRpc = (parsed.rpc && typeof parsed.rpc === 'object') ? parsed.rpc : {};

  const binary       = rawRpc.binary        !== undefined ? String(rawRpc.binary)        : D.rpc.binary;
  const defaultModel = rawRpc.default_model  !== undefined ? String(rawRpc.default_model) : D.rpc.default_model;
  const defaultProfile = rawRpc.default_profile !== undefined
    ? String(rawRpc.default_profile)
    : D.rpc.default_profile;

  // ── [sources.slack] ───────────────────────────────────────────────────────
  const rawSources = (parsed.sources && typeof parsed.sources === 'object') ? parsed.sources : {};
  const rawSlack   = (rawSources.slack && typeof rawSources.slack === 'object') ? rawSources.slack : {};
  const DS = D.sources.slack;

  const slack = Object.freeze({
    enabled:           rawSlack.enabled           !== undefined ? Boolean(rawSlack.enabled)           : DS.enabled,
    bot_token_env:     rawSlack.bot_token_env      !== undefined ? String(rawSlack.bot_token_env)      : DS.bot_token_env,
    app_token_env:     rawSlack.app_token_env      !== undefined ? String(rawSlack.app_token_env)      : DS.app_token_env,
    trigger_word:      rawSlack.trigger_word       !== undefined ? String(rawSlack.trigger_word)       : DS.trigger_word,
    respond_to_dms:    rawSlack.respond_to_dms     !== undefined ? Boolean(rawSlack.respond_to_dms)    : DS.respond_to_dms,
    respond_to_mentions: rawSlack.respond_to_mentions !== undefined ? Boolean(rawSlack.respond_to_mentions) : DS.respond_to_mentions,
    thread_replies:    rawSlack.thread_replies     !== undefined ? Boolean(rawSlack.thread_replies)    : DS.thread_replies,
  });

  // ── [platform] ────────────────────────────────────────────────────────────
  const rawPlatform = (parsed.platform && typeof parsed.platform === 'object') ? parsed.platform : {};
  const DP = D.platform;

  let platformMode = rawPlatform.mode !== undefined ? String(rawPlatform.mode) : DP.mode;
  if (platformMode !== 'bridge' && platformMode !== 'scp') {
    logger.warn(`bridge/config: invalid platform.mode "${platformMode}" — falling back to "bridge"`);
    platformMode = 'bridge';
  }

  // ── [workspace] ───────────────────────────────────────────────────────────
  const rawWorkspace = (parsed.workspace && typeof parsed.workspace === 'object') ? parsed.workspace : {};
  const DW = D.workspace;

  const wsImage        = rawWorkspace.image         !== undefined ? String(rawWorkspace.image)        : DW.image;
  const wsDockerSocket = rawWorkspace.docker_socket !== undefined ? String(rawWorkspace.docker_socket) : DW.docker_socket;
  const wsVolumeRoot   = rawWorkspace.volume_root   !== undefined ? String(rawWorkspace.volume_root)   : DW.volume_root;

  let wsDefaultCpu = rawWorkspace.default_cpu !== undefined ? Number(rawWorkspace.default_cpu) : DW.default_cpu;
  if (!(wsDefaultCpu > 0)) {
    logger.warn(`bridge/config: invalid workspace.default_cpu "${rawWorkspace.default_cpu}" — falling back to ${DW.default_cpu}`);
    wsDefaultCpu = DW.default_cpu;
  }

  const wsDefaultMemMb = rawWorkspace.default_mem_mb !== undefined ? Number(rawWorkspace.default_mem_mb) : DW.default_mem_mb;
  const wsDefaultPids  = rawWorkspace.default_pids   !== undefined ? Number(rawWorkspace.default_pids)   : DW.default_pids;

  let wsIdleReapMinutes = rawWorkspace.idle_reap_minutes !== undefined
    ? rawWorkspace.idle_reap_minutes
    : DW.idle_reap_minutes;
  if (!Number.isInteger(wsIdleReapMinutes) || wsIdleReapMinutes <= 0) {
    logger.warn(`bridge/config: invalid workspace.idle_reap_minutes "${wsIdleReapMinutes}" — falling back to ${DW.idle_reap_minutes}`);
    wsIdleReapMinutes = DW.idle_reap_minutes;
  }

  // ── [web] ─────────────────────────────────────────────────────────────────
  const rawWeb = (parsed.web && typeof parsed.web === 'object') ? parsed.web : {};
  const DWEB = D.web;

  const webEnabled           = rawWeb.enabled             !== undefined ? Boolean(rawWeb.enabled)             : DWEB.enabled;
  const webBind              = rawWeb.bind                !== undefined ? String(rawWeb.bind)                : DWEB.bind;
  const webTrustProxyHeader  = rawWeb.trust_proxy_header  !== undefined ? String(rawWeb.trust_proxy_header)  : DWEB.trust_proxy_header;
  const webAllowedOrigin     = rawWeb.allowed_origin      !== undefined ? String(rawWeb.allowed_origin)      : DWEB.allowed_origin;

  let webHttpPort = rawWeb.http_port !== undefined ? rawWeb.http_port : DWEB.http_port;
  if (!Number.isInteger(webHttpPort) || webHttpPort < 0 || webHttpPort > 65535) {
    logger.warn(`bridge/config: invalid web.http_port "${webHttpPort}" — falling back to ${DWEB.http_port}`);
    webHttpPort = DWEB.http_port;
  }

  // ── [mongodb] ─────────────────────────────────────────────────────────────
  const rawMongodb = (parsed.mongodb && typeof parsed.mongodb === 'object') ? parsed.mongodb : {};
  const DMDB = D.mongodb;

  let mongodbUri = rawMongodb.uri !== undefined ? String(rawMongodb.uri) : DMDB.uri;
  if (
    typeof mongodbUri !== 'string' ||
    mongodbUri.length === 0 ||
    (!mongodbUri.startsWith('mongodb://') && !mongodbUri.startsWith('mongodb+srv://'))
  ) {
    logger.warn(`bridge/config: invalid mongodb.uri — falling back to default`);
    mongodbUri = DMDB.uri;
  }

  return Object.freeze({
    bridge: Object.freeze({
      log_level: logLevel,
      session_idle_timeout_secs: idleTimeout,
      session_dir: sessionDir,
    }),
    rpc: Object.freeze({
      binary,
      default_model: defaultModel,
      default_profile: defaultProfile,
    }),
    sources: Object.freeze({ slack }),
    platform: Object.freeze({ mode: platformMode }),
    workspace: Object.freeze({
      image: wsImage,
      docker_socket: wsDockerSocket,
      volume_root: wsVolumeRoot,
      default_cpu: wsDefaultCpu,
      default_mem_mb: wsDefaultMemMb,
      default_pids: wsDefaultPids,
      idle_reap_minutes: wsIdleReapMinutes,
    }),
    web: Object.freeze({
      enabled: webEnabled,
      http_port: webHttpPort,
      bind: webBind,
      trust_proxy_header: webTrustProxyHeader,
      allowed_origin: webAllowedOrigin,
    }),
    mongodb: Object.freeze({ uri: mongodbUri }),
  });
}
