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
    host_mode: false,
    strict: false,
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
  memory: Object.freeze({
    enabled: false,
    transport: 'cli',
    cli_path: 'axel',
    brain_dir: '~/.local/share/synaps/memory',
    recall_k: 8,
    recall_min_score: 0.0,
    recall_max_chars: 2000,
    axel_socket: '/run/synaps/axel.sock',
    consolidation_cron: '0 3 * * *',
  }),
  identity: Object.freeze({
    enabled: false,                 // default off — Phase 2 behavior preserved
    link_code_ttl_secs: 300,        // 5 min
    default_institution_id: '',     // optional fallback for slack users without an inst
  }),
  creds: Object.freeze({
    enabled: false,                 // default off — preserves existing behavior
    broker: 'noop',                 // 'noop' | 'infisical'
    infisical_url: '',              // e.g. 'https://infisical.internal'
    infisical_token_file: '',       // path; secret read at start()
    cache_ttl_secs: 300,            // 5 min last-known-good cache
    audit_attribute_user: true,     // include synaps_user_id in Infisical metadata
  }),
  supervisor: Object.freeze({
    enabled:               false,        // default off
    heartbeat_interval_ms: 10_000,
    reaper_interval_ms:    60_000,
    workspace_stale_ms:    1_800_000,    // 30 min
    rpc_stale_ms:             300_000,   // 5 min
    scp_stale_ms:              30_000,   // 30 s (info only)
    bridge_critical_ms:        60_000,   // /health 503 threshold
  }),
  scheduler: Object.freeze({
    enabled:            false,
    process_every_secs: 30,
    max_concurrency:    5,
  }),
  hooks: Object.freeze({
    enabled:      false,
    timeout_ms:   5000,
    max_parallel: 16,
  }),
  inbox: Object.freeze({
    enabled:      false,
    dir_template: '',
  }),
  mcp: Object.freeze({
    enabled:           false,
    audit:             false,
    chat_timeout_ms:   120_000,
    max_body_bytes:    262_144,
    policy_name:       'synaps-control-plane',
    surface_rpc_tools: false,
    rate_limit: Object.freeze({
      enabled:          true,
      per_token_capacity: 60,
      per_token_refill:   1,
      per_ip_capacity:  120,
      per_ip_refill:      2,
    }),
    sse: Object.freeze({
      enabled:       false,
      stream_deltas: false,
    }),
    acl: Object.freeze({
      enabled: false,
    }),
    dcr: Object.freeze({
      enabled:             false,
      registration_secret: '',
      token_ttl_ms:        365 * 24 * 60 * 60 * 1_000,
    }),
    /**
     * [mcp.oauth] — OAuth 2.1 Authorization Code flow with PKCE.
     *
     * enabled                        – Feature flag; default false (opt-in).
     * issuer                         – Canonical issuer URL returned in RFC 8414 metadata.
     * authorize_path                 – Path for the authorization endpoint.
     * token_path                     – Path for the token endpoint.
     * code_ttl_ms                    – Authorization code lifetime in ms (default 10 min).
     *                                  Must be >= 60 000.
     * token_ttl_ms                   – Bearer token lifetime in ms (default 30 days).
     *                                  Must be >= 60 000.
     * max_body_bytes                 – Maximum POST body size for OAuth endpoints (default 16 384).
     * require_pkce                   – MUST stay true; setting false throws at startup.
     * allowed_redirect_uri_prefixes  – Array of allowed redirect_uri prefixes.
     *                                  Must be a non-empty array of strings.
     * test_auth_header_enabled       – Dev/smoke only; allow X-Synaps-Test-Auth header
     *                                  to bypass session resolution.  Never set true
     *                                  in production.
     */
    oauth: Object.freeze({
      enabled:                       false,
      issuer:                        'http://localhost:18080',
      authorize_path:                '/mcp/v1/authorize',
      token_path:                    '/mcp/v1/token',
      code_ttl_ms:                   600_000,         // 10 min
      token_ttl_ms:                  2_592_000_000,   // 30 days
      max_body_bytes:                16_384,
      require_pkce:                  true,
      allowed_redirect_uri_prefixes: ['http://localhost:', 'https://'],
      test_auth_header_enabled:      false,
    }),
  }),
  metrics: Object.freeze({
    enabled: false,
    path:    '/metrics',
    bind:    '127.0.0.1',
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
 * @property {{ enabled: boolean, transport: string, cli_path: string, brain_dir: string, recall_k: number, recall_min_score: number, recall_max_chars: number, axel_socket: string, consolidation_cron: string }} memory
 * @property {{ enabled: boolean, link_code_ttl_secs: number, default_institution_id: string }} identity
 * @property {{ enabled: boolean, broker: string, infisical_url: string, infisical_token_file: string, cache_ttl_secs: number, audit_attribute_user: boolean }} creds
 */

/**
 * @typedef {object} MCPConfig
 * @property {boolean} enabled
 * @property {boolean} audit
 * @property {number}  chat_timeout_ms
 * @property {number}  max_body_bytes
 * @property {string}  policy_name
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
  const knownTopLevel = new Set(['bridge', 'rpc', 'sources', 'platform', 'workspace', 'web', 'mongodb', 'memory', 'identity', 'creds', 'supervisor', 'scheduler', 'hooks', 'inbox', 'mcp', 'metrics']);
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
  const hostMode = rawRpc.host_mode !== undefined ? Boolean(rawRpc.host_mode) : D.rpc.host_mode;
  const rpcStrict = rawRpc.strict !== undefined ? Boolean(rawRpc.strict) : D.rpc.strict;

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

  // ── [memory] ──────────────────────────────────────────────────────────────
  const rawMemory = (parsed.memory && typeof parsed.memory === 'object') ? parsed.memory : {};
  const DMEM = D.memory;

  const memEnabled = rawMemory.enabled !== undefined ? Boolean(rawMemory.enabled) : DMEM.enabled;

  let memTransport = rawMemory.transport !== undefined ? rawMemory.transport : DMEM.transport;
  if (memTransport !== 'cli' && memTransport !== 'socket') {
    logger.warn(`bridge/config: invalid memory.transport "${memTransport}" — falling back to "${DMEM.transport}"`);
    memTransport = DMEM.transport;
  }

  let memCliPath = rawMemory.cli_path !== undefined ? rawMemory.cli_path : DMEM.cli_path;
  if (typeof memCliPath !== 'string' || memCliPath.length === 0) {
    logger.warn(`bridge/config: invalid memory.cli_path — falling back to "${DMEM.cli_path}"`);
    memCliPath = DMEM.cli_path;
  }

  let memBrainDir = rawMemory.brain_dir !== undefined ? rawMemory.brain_dir : DMEM.brain_dir;
  if (typeof memBrainDir !== 'string' || memBrainDir.length === 0) {
    logger.warn(`bridge/config: invalid memory.brain_dir — falling back to "${DMEM.brain_dir}"`);
    memBrainDir = DMEM.brain_dir;
  }

  let memRecallK = rawMemory.recall_k !== undefined ? rawMemory.recall_k : DMEM.recall_k;
  if (!Number.isInteger(memRecallK) || memRecallK < 1 || memRecallK > 50) {
    logger.warn(`bridge/config: invalid memory.recall_k "${memRecallK}" — falling back to ${DMEM.recall_k}`);
    memRecallK = DMEM.recall_k;
  }

  let memRecallMinScore = rawMemory.recall_min_score !== undefined ? rawMemory.recall_min_score : DMEM.recall_min_score;
  if (typeof memRecallMinScore !== 'number' || !isFinite(memRecallMinScore) || memRecallMinScore < 0 || memRecallMinScore > 1) {
    logger.warn(`bridge/config: invalid memory.recall_min_score "${memRecallMinScore}" — falling back to ${DMEM.recall_min_score}`);
    memRecallMinScore = DMEM.recall_min_score;
  }

  let memRecallMaxChars = rawMemory.recall_max_chars !== undefined ? rawMemory.recall_max_chars : DMEM.recall_max_chars;
  if (!Number.isInteger(memRecallMaxChars) || memRecallMaxChars < 100 || memRecallMaxChars > 50000) {
    logger.warn(`bridge/config: invalid memory.recall_max_chars "${memRecallMaxChars}" — falling back to ${DMEM.recall_max_chars}`);
    memRecallMaxChars = DMEM.recall_max_chars;
  }

  let memAxelSocket = rawMemory.axel_socket !== undefined ? rawMemory.axel_socket : DMEM.axel_socket;
  if (typeof memAxelSocket !== 'string' || memAxelSocket.length === 0) {
    logger.warn(`bridge/config: invalid memory.axel_socket — falling back to "${DMEM.axel_socket}"`);
    memAxelSocket = DMEM.axel_socket;
  }

  let memConsolidationCron = rawMemory.consolidation_cron !== undefined ? rawMemory.consolidation_cron : DMEM.consolidation_cron;
  if (typeof memConsolidationCron !== 'string' || memConsolidationCron.length === 0) {
    logger.warn(`bridge/config: invalid memory.consolidation_cron — falling back to "${DMEM.consolidation_cron}"`);
    memConsolidationCron = DMEM.consolidation_cron;
  }

  // ── [identity] ────────────────────────────────────────────────────────────
  const rawIdentity = (parsed.identity && typeof parsed.identity === 'object') ? parsed.identity : {};
  const DID = D.identity;

  const identityEnabled = rawIdentity.enabled !== undefined ? Boolean(rawIdentity.enabled) : DID.enabled;

  let identityLinkCodeTtlSecs = rawIdentity.link_code_ttl_secs !== undefined
    ? rawIdentity.link_code_ttl_secs
    : DID.link_code_ttl_secs;
  if (!Number.isInteger(identityLinkCodeTtlSecs) || identityLinkCodeTtlSecs < 60 || identityLinkCodeTtlSecs > 3600) {
    logger.warn(
      `bridge/config: invalid identity.link_code_ttl_secs "${identityLinkCodeTtlSecs}" — falling back to ${DID.link_code_ttl_secs}`,
    );
    identityLinkCodeTtlSecs = DID.link_code_ttl_secs;
  }

  let identityDefaultInstitutionId = rawIdentity.default_institution_id !== undefined
    ? String(rawIdentity.default_institution_id)
    : DID.default_institution_id;
  if (identityDefaultInstitutionId.length > 0 && !/^[0-9a-f]{24}$/.test(identityDefaultInstitutionId)) {
    logger.warn(
      `bridge/config: invalid identity.default_institution_id "${identityDefaultInstitutionId}" — must be empty or 24-char hex; resetting to ""`,
    );
    identityDefaultInstitutionId = '';
  }

  // Warn on unknown keys inside [identity].
  const knownIdentityKeys = new Set(['enabled', 'link_code_ttl_secs', 'default_institution_id']);
  for (const k of Object.keys(rawIdentity)) {
    if (!knownIdentityKeys.has(k)) {
      logger.warn(`bridge/config: unknown identity key "${k}" — ignoring`);
    }
  }

  // ── [creds] ───────────────────────────────────────────────────────────────
  const rawCreds = (parsed.creds && typeof parsed.creds === 'object') ? parsed.creds : {};
  const DCREDS = D.creds;

  const credsEnabled = rawCreds.enabled !== undefined ? Boolean(rawCreds.enabled) : DCREDS.enabled;

  const VALID_BROKERS = ['noop', 'infisical'];
  let credsBroker = rawCreds.broker !== undefined ? rawCreds.broker : DCREDS.broker;
  if (!VALID_BROKERS.includes(credsBroker)) {
    logger.warn(`bridge/config: invalid creds.broker "${credsBroker}" — falling back to "${DCREDS.broker}"`);
    credsBroker = DCREDS.broker;
  }

  const rawCredsInfisicalUrl = rawCreds.infisical_url !== undefined
    ? String(rawCreds.infisical_url)
    : DCREDS.infisical_url;

  const rawCredsInfisicalTokenFile = rawCreds.infisical_token_file !== undefined
    ? String(rawCreds.infisical_token_file)
    : DCREDS.infisical_token_file;
  const credsInfisicalTokenFile = expandHome(rawCredsInfisicalTokenFile);

  // Require non-empty url + token_file when enabled + infisical.
  if (credsEnabled && credsBroker === 'infisical') {
    if (!rawCredsInfisicalUrl) {
      throw new Error('bridge/config: creds.infisical_url must be non-empty when creds.enabled = true and creds.broker = "infisical"');
    }
    if (!rawCredsInfisicalTokenFile) {
      throw new Error('bridge/config: creds.infisical_token_file must be non-empty when creds.enabled = true and creds.broker = "infisical"');
    }
  }

  let credsCacheTtlSecs = rawCreds.cache_ttl_secs !== undefined
    ? rawCreds.cache_ttl_secs
    : DCREDS.cache_ttl_secs;
  if (!Number.isInteger(credsCacheTtlSecs) || credsCacheTtlSecs < 0) {
    logger.warn(`bridge/config: invalid creds.cache_ttl_secs "${credsCacheTtlSecs}" — falling back to ${DCREDS.cache_ttl_secs}`);
    credsCacheTtlSecs = DCREDS.cache_ttl_secs;
  }

  const credsAuditAttributeUser = rawCreds.audit_attribute_user !== undefined
    ? Boolean(rawCreds.audit_attribute_user)
    : DCREDS.audit_attribute_user;

  // Warn on unknown keys inside [creds].
  const knownCredsKeys = new Set(['enabled', 'broker', 'infisical_url', 'infisical_token_file', 'cache_ttl_secs', 'audit_attribute_user']);
  for (const k of Object.keys(rawCreds)) {
    if (!knownCredsKeys.has(k)) {
      logger.warn(`bridge/config: unknown creds key "${k}" — ignoring`);
    }
  }

  // ── [supervisor] ──────────────────────────────────────────────────────────
  const rawSupervisor = (parsed.supervisor && typeof parsed.supervisor === 'object') ? parsed.supervisor : {};
  const DSUP = D.supervisor;

  const supervisorEnabled = rawSupervisor.enabled !== undefined ? Boolean(rawSupervisor.enabled) : DSUP.enabled;

  // Helper: validate a non-negative integer ms field, warn + default on failure.
  function validateNonNegIntMs(rawVal, defaultVal, fieldName) {
    if (rawVal === undefined) return defaultVal;
    if (!Number.isInteger(rawVal) || rawVal < 0) {
      logger.warn(`bridge/config: invalid supervisor.${fieldName} "${rawVal}" — falling back to ${defaultVal}`);
      return defaultVal;
    }
    return rawVal;
  }

  const supHeartbeatIntervalMs = validateNonNegIntMs(rawSupervisor.heartbeat_interval_ms, DSUP.heartbeat_interval_ms, 'heartbeat_interval_ms');
  const supReaperIntervalMs    = validateNonNegIntMs(rawSupervisor.reaper_interval_ms,    DSUP.reaper_interval_ms,    'reaper_interval_ms');
  const supWorkspaceStaleMs    = validateNonNegIntMs(rawSupervisor.workspace_stale_ms,    DSUP.workspace_stale_ms,    'workspace_stale_ms');
  const supRpcStaleMs          = validateNonNegIntMs(rawSupervisor.rpc_stale_ms,          DSUP.rpc_stale_ms,          'rpc_stale_ms');
  const supScpStaleMs          = validateNonNegIntMs(rawSupervisor.scp_stale_ms,          DSUP.scp_stale_ms,          'scp_stale_ms');
  const supBridgeCriticalMs    = validateNonNegIntMs(rawSupervisor.bridge_critical_ms,    DSUP.bridge_critical_ms,    'bridge_critical_ms');

  // Warn on unknown keys inside [supervisor].
  const knownSupervisorKeys = new Set([
    'enabled',
    'heartbeat_interval_ms',
    'reaper_interval_ms',
    'workspace_stale_ms',
    'rpc_stale_ms',
    'scp_stale_ms',
    'bridge_critical_ms',
  ]);
  for (const k of Object.keys(rawSupervisor)) {
    if (!knownSupervisorKeys.has(k)) {
      logger.warn(`bridge/config: unknown supervisor key "${k}" — ignoring`);
    }
  }

  // ── [scheduler] ───────────────────────────────────────────────────────────
  const rawScheduler = (parsed.scheduler && typeof parsed.scheduler === 'object') ? parsed.scheduler : {};
  const DSCHED = D.scheduler;

  const schedulerEnabled = rawScheduler.enabled !== undefined ? Boolean(rawScheduler.enabled) : DSCHED.enabled;

  // Helper for integer ≥ 0.
  function validateNonNegInt(rawVal, defaultVal, sectionField) {
    if (rawVal === undefined) return defaultVal;
    if (!Number.isInteger(rawVal) || rawVal < 0) {
      logger.warn(`bridge/config: invalid ${sectionField} "${rawVal}" — falling back to ${defaultVal}`);
      return defaultVal;
    }
    return rawVal;
  }

  // Helper for integer ≥ 1.
  function validatePosInt(rawVal, defaultVal, sectionField) {
    if (rawVal === undefined) return defaultVal;
    if (!Number.isInteger(rawVal) || rawVal < 1) {
      logger.warn(`bridge/config: invalid ${sectionField} "${rawVal}" — falling back to ${defaultVal}`);
      return defaultVal;
    }
    return rawVal;
  }

  const schedulerProcessEverySecs = validateNonNegInt(
    rawScheduler.process_every_secs,
    DSCHED.process_every_secs,
    'scheduler.process_every_secs',
  );
  const schedulerMaxConcurrency = validatePosInt(
    rawScheduler.max_concurrency,
    DSCHED.max_concurrency,
    'scheduler.max_concurrency',
  );

  // Warn on unknown keys inside [scheduler].
  const knownSchedulerKeys = new Set(['enabled', 'process_every_secs', 'max_concurrency']);
  for (const k of Object.keys(rawScheduler)) {
    if (!knownSchedulerKeys.has(k)) {
      logger.warn(`bridge/config: unknown scheduler key "${k}" — ignoring`);
    }
  }

  // ── [hooks] ───────────────────────────────────────────────────────────────
  const rawHooks = (parsed.hooks && typeof parsed.hooks === 'object') ? parsed.hooks : {};
  const DHOOKS = D.hooks;

  const hooksEnabled = rawHooks.enabled !== undefined ? Boolean(rawHooks.enabled) : DHOOKS.enabled;

  const hooksTimeoutMs = validateNonNegInt(
    rawHooks.timeout_ms,
    DHOOKS.timeout_ms,
    'hooks.timeout_ms',
  );
  const hooksMaxParallel = validatePosInt(
    rawHooks.max_parallel,
    DHOOKS.max_parallel,
    'hooks.max_parallel',
  );

  // Warn on unknown keys inside [hooks].
  const knownHooksKeys = new Set(['enabled', 'timeout_ms', 'max_parallel']);
  for (const k of Object.keys(rawHooks)) {
    if (!knownHooksKeys.has(k)) {
      logger.warn(`bridge/config: unknown hooks key "${k}" — ignoring`);
    }
  }

  // ── [inbox] ───────────────────────────────────────────────────────────────
  const rawInbox = (parsed.inbox && typeof parsed.inbox === 'object') ? parsed.inbox : {};
  const DINBOX = D.inbox;

  const inboxEnabled = rawInbox.enabled !== undefined ? Boolean(rawInbox.enabled) : DINBOX.enabled;
  const inboxDirTemplate = rawInbox.dir_template !== undefined
    ? String(rawInbox.dir_template)
    : DINBOX.dir_template;

  // Warn on unknown keys inside [inbox].
  const knownInboxKeys = new Set(['enabled', 'dir_template']);
  for (const k of Object.keys(rawInbox)) {
    if (!knownInboxKeys.has(k)) {
      logger.warn(`bridge/config: unknown inbox key "${k}" — ignoring`);
    }
  }

  // ── [mcp] ─────────────────────────────────────────────────────────────────
  const rawMcp = (parsed.mcp && typeof parsed.mcp === 'object') ? parsed.mcp : {};
  const DMCP = D.mcp;

  const mcpEnabled = rawMcp.enabled !== undefined ? Boolean(rawMcp.enabled) : DMCP.enabled;
  const mcpAudit   = rawMcp.audit   !== undefined ? Boolean(rawMcp.audit)   : DMCP.audit;

  let mcpChatTimeoutMs = rawMcp.chat_timeout_ms !== undefined ? rawMcp.chat_timeout_ms : DMCP.chat_timeout_ms;
  if (!Number.isInteger(mcpChatTimeoutMs) || mcpChatTimeoutMs < 1000 || mcpChatTimeoutMs > 600_000) {
    throw new Error(
      `bridge/config: invalid mcp.chat_timeout_ms "${mcpChatTimeoutMs}" — must be integer between 1000 and 600000`,
    );
  }

  let mcpMaxBodyBytes = rawMcp.max_body_bytes !== undefined ? rawMcp.max_body_bytes : DMCP.max_body_bytes;
  if (!Number.isInteger(mcpMaxBodyBytes) || mcpMaxBodyBytes < 1024 || mcpMaxBodyBytes > 4_194_304) {
    throw new Error(
      `bridge/config: invalid mcp.max_body_bytes "${mcpMaxBodyBytes}" — must be integer between 1024 and 4194304`,
    );
  }

  let mcpPolicyName = rawMcp.policy_name !== undefined ? String(rawMcp.policy_name) : DMCP.policy_name;
  if (typeof mcpPolicyName !== 'string' || mcpPolicyName.length === 0) {
    throw new Error('bridge/config: invalid mcp.policy_name — must be a non-empty string');
  }

  // ── [mcp] surface_rpc_tools ────────────────────────────────────────────────
  const mcpSurfaceRpcTools = rawMcp.surface_rpc_tools !== undefined
    ? Boolean(rawMcp.surface_rpc_tools)
    : DMCP.surface_rpc_tools;

  // ── [mcp.rate_limit] ───────────────────────────────────────────────────────
  const rawRateLimit = (rawMcp.rate_limit && typeof rawMcp.rate_limit === 'object')
    ? rawMcp.rate_limit
    : {};
  const DMCP_RL = DMCP.rate_limit;

  const rlEnabled         = rawRateLimit.enabled !== undefined ? Boolean(rawRateLimit.enabled) : DMCP_RL.enabled;
  const rlPerTokenCapacity = rawRateLimit.per_token_capacity !== undefined
    ? rawRateLimit.per_token_capacity : DMCP_RL.per_token_capacity;
  const rlPerTokenRefill  = rawRateLimit.per_token_refill !== undefined
    ? rawRateLimit.per_token_refill : DMCP_RL.per_token_refill;
  const rlPerIpCapacity   = rawRateLimit.per_ip_capacity !== undefined
    ? rawRateLimit.per_ip_capacity : DMCP_RL.per_ip_capacity;
  const rlPerIpRefill     = rawRateLimit.per_ip_refill !== undefined
    ? rawRateLimit.per_ip_refill : DMCP_RL.per_ip_refill;

  // Validate rate_limit integers
  for (const [key, val] of [
    ['mcp.rate_limit.per_token_capacity', rlPerTokenCapacity],
    ['mcp.rate_limit.per_token_refill',   rlPerTokenRefill],
    ['mcp.rate_limit.per_ip_capacity',    rlPerIpCapacity],
    ['mcp.rate_limit.per_ip_refill',      rlPerIpRefill],
  ]) {
    if (!Number.isFinite(val) || val <= 0) {
      throw new Error(`bridge/config: invalid ${key} "${val}" — must be a positive number`);
    }
  }

  // Warn on unknown keys inside [mcp.rate_limit].
  const knownRlKeys = new Set(['enabled', 'per_token_capacity', 'per_token_refill', 'per_ip_capacity', 'per_ip_refill']);
  for (const k of Object.keys(rawRateLimit)) {
    if (!knownRlKeys.has(k)) {
      logger.warn(`bridge/config: unknown mcp.rate_limit key "${k}" — ignoring`);
    }
  }

  // ── [mcp.sse] ──────────────────────────────────────────────────────────────
  const rawSse = (rawMcp.sse && typeof rawMcp.sse === 'object') ? rawMcp.sse : {};
  const DMCP_SSE = DMCP.sse;

  const sseEnabled      = rawSse.enabled       !== undefined ? Boolean(rawSse.enabled)       : DMCP_SSE.enabled;
  const streamDeltas    = rawSse.stream_deltas  !== undefined ? Boolean(rawSse.stream_deltas) : DMCP_SSE.stream_deltas;

  // Warn on unknown keys inside [mcp.sse].
  const knownSseKeys = new Set(['enabled', 'stream_deltas']);
  for (const k of Object.keys(rawSse)) {
    if (!knownSseKeys.has(k)) {
      logger.warn(`bridge/config: unknown mcp.sse key "${k}" — ignoring`);
    }
  }

  // ── [mcp.acl] ─────────────────────────────────────────────────────────────
  const rawAcl = (rawMcp.acl && typeof rawMcp.acl === 'object') ? rawMcp.acl : {};
  const DMCP_ACL = DMCP.acl;

  const aclEnabled = rawAcl.enabled !== undefined ? Boolean(rawAcl.enabled) : DMCP_ACL.enabled;

  // Warn on unknown keys inside [mcp.acl].
  const knownAclKeys = new Set(['enabled']);
  for (const k of Object.keys(rawAcl)) {
    if (!knownAclKeys.has(k)) {
      logger.warn(`bridge/config: unknown mcp.acl key "${k}" — ignoring`);
    }
  }

  // ── [mcp.dcr] ─────────────────────────────────────────────────────────────
  const rawDcr = (rawMcp.dcr && typeof rawMcp.dcr === 'object') ? rawMcp.dcr : {};
  const DMCP_DCR = DMCP.dcr;

  const dcrEnabled            = rawDcr.enabled !== undefined ? Boolean(rawDcr.enabled) : DMCP_DCR.enabled;
  const dcrRegistrationSecret = rawDcr.registration_secret !== undefined
    ? String(rawDcr.registration_secret)
    : DMCP_DCR.registration_secret;

  let dcrTokenTtlMs = rawDcr.token_ttl_ms !== undefined ? rawDcr.token_ttl_ms : DMCP_DCR.token_ttl_ms;
  if (!Number.isInteger(dcrTokenTtlMs) || dcrTokenTtlMs < 60_000) {
    throw new Error(
      `bridge/config: invalid mcp.dcr.token_ttl_ms "${dcrTokenTtlMs}" — must be integer >= 60000`,
    );
  }

  // Warn on unknown keys inside [mcp.dcr].
  const knownDcrKeys = new Set(['enabled', 'registration_secret', 'token_ttl_ms']);
  for (const k of Object.keys(rawDcr)) {
    if (!knownDcrKeys.has(k)) {
      logger.warn(`bridge/config: unknown mcp.dcr key "${k}" — ignoring`);
    }
  }

  // ── [mcp.oauth] ───────────────────────────────────────────────────────────
  const rawOauth   = (rawMcp.oauth && typeof rawMcp.oauth === 'object') ? rawMcp.oauth : {};
  const DMCP_OAUTH = DMCP.oauth;

  const oauthEnabled = rawOauth.enabled !== undefined ? Boolean(rawOauth.enabled) : DMCP_OAUTH.enabled;

  // require_pkce MUST stay true — throw if explicitly set to false.
  if (rawOauth.require_pkce !== undefined && rawOauth.require_pkce !== true) {
    throw new Error(
      'bridge/config: mcp.oauth.require_pkce must be true — disabling PKCE is not allowed',
    );
  }

  const oauthIssuer = rawOauth.issuer !== undefined
    ? String(rawOauth.issuer)
    : DMCP_OAUTH.issuer;
  if (!oauthIssuer || oauthIssuer.length === 0) {
    throw new Error('bridge/config: mcp.oauth.issuer must be a non-empty string');
  }

  const oauthAuthorizePath = rawOauth.authorize_path !== undefined
    ? String(rawOauth.authorize_path)
    : DMCP_OAUTH.authorize_path;
  if (!oauthAuthorizePath.startsWith('/')) {
    throw new Error(`bridge/config: mcp.oauth.authorize_path "${oauthAuthorizePath}" must start with "/"`);
  }

  const oauthTokenPath = rawOauth.token_path !== undefined
    ? String(rawOauth.token_path)
    : DMCP_OAUTH.token_path;
  if (!oauthTokenPath.startsWith('/')) {
    throw new Error(`bridge/config: mcp.oauth.token_path "${oauthTokenPath}" must start with "/"`);
  }

  let oauthCodeTtlMs = rawOauth.code_ttl_ms !== undefined ? rawOauth.code_ttl_ms : DMCP_OAUTH.code_ttl_ms;
  if (!Number.isInteger(oauthCodeTtlMs) || oauthCodeTtlMs < 60_000) {
    throw new Error(
      `bridge/config: invalid mcp.oauth.code_ttl_ms "${oauthCodeTtlMs}" — must be integer >= 60000`,
    );
  }

  let oauthTokenTtlMs = rawOauth.token_ttl_ms !== undefined ? rawOauth.token_ttl_ms : DMCP_OAUTH.token_ttl_ms;
  if (!Number.isInteger(oauthTokenTtlMs) || oauthTokenTtlMs < 60_000) {
    throw new Error(
      `bridge/config: invalid mcp.oauth.token_ttl_ms "${oauthTokenTtlMs}" — must be integer >= 60000`,
    );
  }

  let oauthMaxBodyBytes = rawOauth.max_body_bytes !== undefined
    ? rawOauth.max_body_bytes
    : DMCP_OAUTH.max_body_bytes;
  if (!Number.isInteger(oauthMaxBodyBytes) || oauthMaxBodyBytes < 512) {
    logger.warn(
      `bridge/config: invalid mcp.oauth.max_body_bytes "${oauthMaxBodyBytes}" — falling back to ${DMCP_OAUTH.max_body_bytes}`,
    );
    oauthMaxBodyBytes = DMCP_OAUTH.max_body_bytes;
  }

  // allowed_redirect_uri_prefixes must be an array of strings.
  let oauthAllowedPrefixes = rawOauth.allowed_redirect_uri_prefixes !== undefined
    ? rawOauth.allowed_redirect_uri_prefixes
    : DMCP_OAUTH.allowed_redirect_uri_prefixes;
  if (!Array.isArray(oauthAllowedPrefixes)) {
    throw new Error(
      'bridge/config: mcp.oauth.allowed_redirect_uri_prefixes must be an array of strings',
    );
  }
  if (!oauthAllowedPrefixes.every((p) => typeof p === 'string')) {
    throw new Error(
      'bridge/config: mcp.oauth.allowed_redirect_uri_prefixes must be an array of strings',
    );
  }

  const oauthTestAuthHeaderEnabled = rawOauth.test_auth_header_enabled !== undefined
    ? Boolean(rawOauth.test_auth_header_enabled)
    : DMCP_OAUTH.test_auth_header_enabled;

  // Warn on unknown keys inside [mcp.oauth].
  const knownOauthKeys = new Set([
    'enabled', 'issuer', 'authorize_path', 'token_path', 'code_ttl_ms',
    'token_ttl_ms', 'max_body_bytes', 'require_pkce',
    'allowed_redirect_uri_prefixes', 'test_auth_header_enabled',
  ]);
  for (const k of Object.keys(rawOauth)) {
    if (!knownOauthKeys.has(k)) {
      logger.warn(`bridge/config: unknown mcp.oauth key "${k}" — ignoring`);
    }
  }

  // Warn on unknown keys inside [mcp].
  const knownMcpKeys = new Set([
    'enabled', 'audit', 'chat_timeout_ms', 'max_body_bytes', 'policy_name',
    'surface_rpc_tools', 'rate_limit', 'sse', 'acl', 'dcr', 'oauth',
  ]);
  for (const k of Object.keys(rawMcp)) {
    if (!knownMcpKeys.has(k)) {
      logger.warn(`bridge/config: unknown mcp key "${k}" — ignoring`);
    }
  }

  // ── [metrics] ─────────────────────────────────────────────────────────────
  const rawMetrics = (parsed.metrics && typeof parsed.metrics === 'object') ? parsed.metrics : {};
  const DMETRICS = D.metrics;

  const metricsEnabled = rawMetrics.enabled !== undefined ? Boolean(rawMetrics.enabled) : DMETRICS.enabled;

  let metricsPath = rawMetrics.path !== undefined ? String(rawMetrics.path) : DMETRICS.path;
  if (!metricsPath.startsWith('/')) {
    throw new Error(
      `bridge/config: invalid metrics.path "${metricsPath}" — must start with "/"`,
    );
  }

  let metricsBind = rawMetrics.bind !== undefined ? String(rawMetrics.bind) : DMETRICS.bind;
  if (typeof metricsBind !== 'string' || metricsBind.length === 0) {
    throw new Error(
      `bridge/config: invalid metrics.bind "${metricsBind}" — must be a non-empty string`,
    );
  }

  // Warn on unknown keys inside [metrics].
  const knownMetricsKeys = new Set(['enabled', 'path', 'bind']);
  for (const k of Object.keys(rawMetrics)) {
    if (!knownMetricsKeys.has(k)) {
      logger.warn(`bridge/config: unknown metrics key "${k}" — ignoring`);
    }
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
      host_mode: hostMode,
      strict: rpcStrict,
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
    memory: Object.freeze({
      enabled: memEnabled,
      transport: memTransport,
      cli_path: memCliPath,
      brain_dir: memBrainDir,
      recall_k: memRecallK,
      recall_min_score: memRecallMinScore,
      recall_max_chars: memRecallMaxChars,
      axel_socket: memAxelSocket,
      consolidation_cron: memConsolidationCron,
    }),
    identity: Object.freeze({
      enabled: identityEnabled,
      link_code_ttl_secs: identityLinkCodeTtlSecs,
      default_institution_id: identityDefaultInstitutionId,
    }),
    creds: Object.freeze({
      enabled: credsEnabled,
      broker: credsBroker,
      infisical_url: rawCredsInfisicalUrl,
      infisical_token_file: credsInfisicalTokenFile,
      cache_ttl_secs: credsCacheTtlSecs,
      audit_attribute_user: credsAuditAttributeUser,
    }),
    supervisor: Object.freeze({
      enabled:               supervisorEnabled,
      heartbeat_interval_ms: supHeartbeatIntervalMs,
      reaper_interval_ms:    supReaperIntervalMs,
      workspace_stale_ms:    supWorkspaceStaleMs,
      rpc_stale_ms:          supRpcStaleMs,
      scp_stale_ms:          supScpStaleMs,
      bridge_critical_ms:    supBridgeCriticalMs,
    }),
    scheduler: Object.freeze({
      enabled:            schedulerEnabled,
      process_every_secs: schedulerProcessEverySecs,
      max_concurrency:    schedulerMaxConcurrency,
    }),
    hooks: Object.freeze({
      enabled:      hooksEnabled,
      timeout_ms:   hooksTimeoutMs,
      max_parallel: hooksMaxParallel,
    }),
    inbox: Object.freeze({
      enabled:      inboxEnabled,
      dir_template: inboxDirTemplate,
    }),
    mcp: Object.freeze({
      enabled:           mcpEnabled,
      audit:             mcpAudit,
      chat_timeout_ms:   mcpChatTimeoutMs,
      max_body_bytes:    mcpMaxBodyBytes,
      policy_name:       mcpPolicyName,
      surface_rpc_tools: mcpSurfaceRpcTools,
      rate_limit: Object.freeze({
        enabled:            rlEnabled,
        per_token_capacity: rlPerTokenCapacity,
        per_token_refill:   rlPerTokenRefill,
        per_ip_capacity:    rlPerIpCapacity,
        per_ip_refill:      rlPerIpRefill,
      }),
      sse: Object.freeze({
        enabled:       sseEnabled,
        stream_deltas: streamDeltas,
      }),
      acl: Object.freeze({
        enabled: aclEnabled,
      }),
      dcr: Object.freeze({
        enabled:             dcrEnabled,
        registration_secret: dcrRegistrationSecret,
        token_ttl_ms:        dcrTokenTtlMs,
      }),
      oauth: Object.freeze({
        enabled:                       oauthEnabled,
        issuer:                        oauthIssuer,
        authorize_path:                oauthAuthorizePath,
        token_path:                    oauthTokenPath,
        code_ttl_ms:                   oauthCodeTtlMs,
        token_ttl_ms:                  oauthTokenTtlMs,
        max_body_bytes:                oauthMaxBodyBytes,
        require_pkce:                  true,
        allowed_redirect_uri_prefixes: Object.freeze(oauthAllowedPrefixes.slice()),
        test_auth_header_enabled:      oauthTestAuthHeaderEnabled,
      }),
    }),
    metrics: Object.freeze({
      enabled: metricsEnabled,
      path:    metricsPath,
      bind:    metricsBind,
    }),
  });
}
