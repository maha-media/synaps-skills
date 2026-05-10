/**
 * @file tests/scp-phase-1/00-config-modes.test.mjs
 *
 * Integration-layer config tests: verifies loadBridgeConfig() round-trips
 * from real temp TOML files written to os.tmpdir().  This complements the
 * unit tests in bridge/config.test.js (which inject a fake fsImpl) by
 * exercising the real fs.promises path.
 *
 * Covers:
 *   - Empty/missing file → mode='bridge' default
 *   - [platform] mode = "scp" is parsed correctly
 *   - Invalid [platform] mode = "nonsense" falls back with a warning
 *   - All new sections ([workspace], [web], [mongodb]) round-trip correctly
 *   - The full combined SCP config round-trips
 *
 * Constraints:
 *   - ESM only (.mjs)
 *   - No top-level await
 *   - vitest describe/it/expect/vi
 *   - Uses real fs (node:fs/promises) + os.tmpdir()
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadBridgeConfig, BRIDGE_CONFIG_DEFAULTS } from '../../bridge/config.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Tracked temp files so afterEach can clean up. */
const tempFiles = [];

/**
 * Write `content` to a uniquely-named file in os.tmpdir() and return the path.
 * Tracks the path for cleanup.
 *
 * @param {string} content  TOML content
 * @returns {Promise<string>}
 */
async function writeTempToml(content) {
  const file = path.join(os.tmpdir(), `scp-phase1-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}.toml`);
  await fs.writeFile(file, content, 'utf8');
  tempFiles.push(file);
  return file;
}

/** Silent logger for tests — captures warn calls for assertions. */
function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

afterEach(async () => {
  // Clean up any temp files written during the test
  for (const f of tempFiles.splice(0)) {
    await fs.unlink(f).catch(() => {});
  }
});

// ─── 1. Missing file → bridge mode default ───────────────────────────────────

describe('loadBridgeConfig integration — missing file', () => {
  it('returns platform.mode="bridge" when the config file does not exist', async () => {
    const nonExistent = path.join(os.tmpdir(), `no-such-file-${Date.now()}.toml`);
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: nonExistent, logger });

    expect(config.platform.mode).toBe('bridge');
    // No warnings expected for a simply-absent file
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns all top-level section defaults when file is absent', async () => {
    const nonExistent = path.join(os.tmpdir(), `no-such-file-${Date.now()}.toml`);
    const config = await loadBridgeConfig({ path: nonExistent });

    expect(config.bridge.log_level).toBe(BRIDGE_CONFIG_DEFAULTS.bridge.log_level);
    expect(config.rpc.binary).toBe(BRIDGE_CONFIG_DEFAULTS.rpc.binary);
    expect(config.workspace.image).toBe(BRIDGE_CONFIG_DEFAULTS.workspace.image);
    expect(config.web.enabled).toBe(BRIDGE_CONFIG_DEFAULTS.web.enabled);
    expect(config.mongodb.uri).toBe(BRIDGE_CONFIG_DEFAULTS.mongodb.uri);
  });
});

// ─── 2. [platform] mode = "scp" ──────────────────────────────────────────────

describe('loadBridgeConfig integration — platform.mode = "scp"', () => {
  it('parses mode = "scp" from a real file', async () => {
    const toml = `[platform]\nmode = "scp"\n`;
    const filePath = await writeTempToml(toml);
    const config = await loadBridgeConfig({ path: filePath });

    expect(config.platform.mode).toBe('scp');
  });

  it('result.platform is frozen when mode = "scp"', async () => {
    const filePath = await writeTempToml('[platform]\nmode = "scp"\n');
    const config = await loadBridgeConfig({ path: filePath });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.platform)).toBe(true);
  });

  it('platform.mode = "scp" does not affect other sections', async () => {
    const filePath = await writeTempToml('[platform]\nmode = "scp"\n');
    const config = await loadBridgeConfig({ path: filePath });

    // Other sections should still have defaults
    expect(config.bridge.log_level).toBe('info');
    expect(config.rpc.binary).toBe('synaps');
  });
});

// ─── 3. Invalid mode falls back to "bridge" with a warning ───────────────────

describe('loadBridgeConfig integration — invalid platform.mode', () => {
  it('falls back to "bridge" and logs a warning for mode = "nonsense"', async () => {
    const filePath = await writeTempToml('[platform]\nmode = "nonsense"\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });

    expect(config.platform.mode).toBe('bridge');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('platform.mode'),
    );
  });

  it('falls back for mode = "cluster" (another unknown value)', async () => {
    const filePath = await writeTempToml('[platform]\nmode = "cluster"\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });

    expect(config.platform.mode).toBe('bridge');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('falls back for mode = "" (empty string)', async () => {
    const filePath = await writeTempToml('[platform]\nmode = ""\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });

    expect(config.platform.mode).toBe('bridge');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('platform.mode'),
    );
  });
});

// ─── 4. [workspace] section round-trips ──────────────────────────────────────

describe('loadBridgeConfig integration — [workspace] round-trip', () => {
  it('parses all workspace fields from a real file', async () => {
    const toml = `
[workspace]
image             = "synaps/workspace:dev"
docker_socket     = "/var/run/docker.sock"
volume_root       = "/tmp/scp-smoke/agents"
default_cpu       = 2.0
default_mem_mb    = 4096
default_pids      = 512
idle_reap_minutes = 60
`;
    const filePath = await writeTempToml(toml);
    const config = await loadBridgeConfig({ path: filePath });
    const ws = config.workspace;

    expect(ws.image).toBe('synaps/workspace:dev');
    expect(ws.docker_socket).toBe('/var/run/docker.sock');
    expect(ws.volume_root).toBe('/tmp/scp-smoke/agents');
    expect(ws.default_cpu).toBe(2.0);
    expect(ws.default_mem_mb).toBe(4096);
    expect(ws.default_pids).toBe(512);
    expect(ws.idle_reap_minutes).toBe(60);
  });

  it('workspace section is frozen', async () => {
    const filePath = await writeTempToml('[workspace]\nimage = "synaps/workspace:dev"\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(Object.isFrozen(config.workspace)).toBe(true);
  });

  it('invalid idle_reap_minutes falls back to default and warns', async () => {
    const filePath = await writeTempToml('[workspace]\nidle_reap_minutes = -1\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });
    expect(config.workspace.idle_reap_minutes).toBe(BRIDGE_CONFIG_DEFAULTS.workspace.idle_reap_minutes);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('idle_reap_minutes'));
  });
});

// ─── 5. [web] section round-trips ────────────────────────────────────────────

describe('loadBridgeConfig integration — [web] round-trip', () => {
  it('parses all web fields from a real file', async () => {
    const toml = `
[web]
enabled             = true
bind                = "127.0.0.1"
http_port           = 8723
trust_proxy_header  = "x-synaps-user-id"
allowed_origin      = ""
`;
    const filePath = await writeTempToml(toml);
    const config = await loadBridgeConfig({ path: filePath });
    const web = config.web;

    expect(web.enabled).toBe(true);
    expect(web.bind).toBe('127.0.0.1');
    expect(web.http_port).toBe(8723);
    expect(web.trust_proxy_header).toBe('x-synaps-user-id');
    expect(web.allowed_origin).toBe('');
  });

  it('web section is frozen', async () => {
    const filePath = await writeTempToml('[web]\nenabled = true\nhttp_port = 8080\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(Object.isFrozen(config.web)).toBe(true);
  });

  it('invalid http_port falls back to 0 and warns', async () => {
    const filePath = await writeTempToml('[web]\nhttp_port = 99999\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });
    expect(config.web.http_port).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('http_port'));
  });
});

// ─── 6. [mongodb] section round-trips ────────────────────────────────────────

describe('loadBridgeConfig integration — [mongodb] round-trip', () => {
  it('parses mongodb:// URI from a real file', async () => {
    const filePath = await writeTempToml('[mongodb]\nuri = "mongodb://localhost/priadb_dev"\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.mongodb.uri).toBe('mongodb://localhost/priadb_dev');
  });

  it('parses mongodb+srv:// URI from a real file', async () => {
    const filePath = await writeTempToml('[mongodb]\nuri = "mongodb+srv://user:pass@cluster.example.com/mydb"\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.mongodb.uri).toBe('mongodb+srv://user:pass@cluster.example.com/mydb');
  });

  it('mongodb section is frozen', async () => {
    const filePath = await writeTempToml('[mongodb]\nuri = "mongodb://localhost/test"\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(Object.isFrozen(config.mongodb)).toBe(true);
  });

  it('invalid (non-mongodb) URI falls back to default and warns', async () => {
    const filePath = await writeTempToml('[mongodb]\nuri = "postgres://localhost/test"\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });
    expect(config.mongodb.uri).toBe(BRIDGE_CONFIG_DEFAULTS.mongodb.uri);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mongodb.uri'));
  });
});

// ─── 7. Full SCP config round-trip ───────────────────────────────────────────

describe('loadBridgeConfig integration — full SCP config round-trip', () => {
  it('parses a combined SCP bridge.toml correctly', async () => {
    const toml = `
[platform]
mode = "scp"

[mongodb]
uri = "mongodb://localhost/priadb_dev"

[workspace]
image              = "synaps/workspace:dev"
docker_socket      = "/var/run/docker.sock"
volume_root        = "/tmp/scp-smoke/agents"
idle_reap_minutes  = 30

[web]
enabled   = true
bind      = "127.0.0.1"
http_port = 8723

[bridge]
log_level = "debug"

[sources.slack]
enabled        = true
bot_token_env  = "SLACK_BOT_TOKEN"
app_token_env  = "SLACK_APP_TOKEN"
respond_to_dms = true
`;
    const filePath = await writeTempToml(toml);
    const config = await loadBridgeConfig({ path: filePath });

    expect(config.platform.mode).toBe('scp');
    expect(config.mongodb.uri).toBe('mongodb://localhost/priadb_dev');
    expect(config.workspace.image).toBe('synaps/workspace:dev');
    expect(config.workspace.idle_reap_minutes).toBe(30);
    expect(config.web.enabled).toBe(true);
    expect(config.web.http_port).toBe(8723);
    expect(config.bridge.log_level).toBe('debug');
    expect(config.sources.slack.enabled).toBe(true);
    expect(config.sources.slack.bot_token_env).toBe('SLACK_BOT_TOKEN');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('mode="bridge" (default) co-exists with scp-only sections without error', async () => {
    // [workspace] and [mongodb] are valid even in bridge mode — they are just unused
    const toml = `
[platform]
mode = "bridge"

[mongodb]
uri = "mongodb://localhost/priadb"

[workspace]
image = "synaps/workspace:0.1.0"

[web]
enabled = false
`;
    const filePath = await writeTempToml(toml);
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });

    expect(config.platform.mode).toBe('bridge');
    // No warnings (all values are valid)
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
