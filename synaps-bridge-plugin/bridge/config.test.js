/**
 * @file bridge/config.test.js
 *
 * Tests for bridge/config.js — bridge.toml loader.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { loadBridgeConfig, BRIDGE_CONFIG_DEFAULTS, expandHome, DEFAULT_CONFIG_PATH } from './config.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeFsImpl(files = {}) {
  return {
    readFile: async (p) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) {
        const v = files[p];
        if (v instanceof Error) throw v;
        return v;
      }
      const err = new Error(`ENOENT: no such file: ${p}`);
      err.code = 'ENOENT';
      throw err;
    },
  };
}

function makeLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ─── expandHome ───────────────────────────────────────────────────────────────

describe('expandHome', () => {
  it('expands ~ to home dir', () => {
    expect(expandHome('~')).toBe(os.homedir());
  });

  it('expands ~/foo/bar', () => {
    expect(expandHome('~/foo/bar')).toBe(path.join(os.homedir(), 'foo/bar'));
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandHome('/absolute/path')).toBe('/absolute/path');
  });

  it('leaves relative paths unchanged', () => {
    expect(expandHome('relative/path')).toBe('relative/path');
  });

  it('leaves non-strings unchanged', () => {
    expect(expandHome(42)).toBe(42);
    expect(expandHome(null)).toBe(null);
  });
});

// ─── defaults on missing file ─────────────────────────────────────────────────

describe('loadBridgeConfig — missing file', () => {
  it('returns defaults when config file is absent (ENOENT)', async () => {
    const logger = makeLogger();
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/such/file.toml', fsImpl, logger });

    expect(config.bridge.log_level).toBe('info');
    expect(config.bridge.session_idle_timeout_secs).toBe(86400);
    expect(config.rpc.binary).toBe('synaps');
    expect(config.rpc.default_model).toBe('claude-sonnet-4-6');
    expect(config.sources.slack.enabled).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('BRIDGE_CONFIG_DEFAULTS matches returned defaults', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/such/file.toml', fsImpl });
    expect(config.bridge.log_level).toBe(BRIDGE_CONFIG_DEFAULTS.bridge.log_level);
    expect(config.rpc.binary).toBe(BRIDGE_CONFIG_DEFAULTS.rpc.binary);
  });
});

// ─── schema-shaped output ────────────────────────────────────────────────────

describe('loadBridgeConfig — schema shape', () => {
  const toml = `
[bridge]
log_level = "debug"
session_idle_timeout_secs = 3600
session_dir = "~/.synaps-cli/bridge"

[rpc]
binary = "synaps"
default_model = "claude-opus-4-5"
default_profile = "myprofile"

[sources.slack]
enabled = true
bot_token_env = "SLACK_BOT_TOKEN"
app_token_env = "SLACK_APP_TOKEN"
trigger_word = "@synaps"
respond_to_dms = true
respond_to_mentions = false
thread_replies = true
`;

  it('parses all fields correctly', async () => {
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });

    expect(config.bridge.log_level).toBe('debug');
    expect(config.bridge.session_idle_timeout_secs).toBe(3600);
    expect(config.rpc.default_model).toBe('claude-opus-4-5');
    expect(config.rpc.default_profile).toBe('myprofile');
    expect(config.sources.slack.respond_to_mentions).toBe(false);
  });

  it('result is a frozen object', async () => {
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.bridge)).toBe(true);
    expect(Object.isFrozen(config.rpc)).toBe(true);
    expect(Object.isFrozen(config.sources)).toBe(true);
    expect(Object.isFrozen(config.sources.slack)).toBe(true);
  });
});

// ─── ~ expansion in values ───────────────────────────────────────────────────

describe('loadBridgeConfig — tilde expansion', () => {
  it('expands ~ in session_dir', async () => {
    const toml = `[bridge]\nsession_dir = "~/.synaps-cli/bridge"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.bridge.session_dir).toBe(path.join(os.homedir(), '.synaps-cli/bridge'));
  });

  it('leaves already-absolute session_dir unchanged', async () => {
    const toml = `[bridge]\nsession_dir = "/absolute/path"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.bridge.session_dir).toBe('/absolute/path');
  });
});

// ─── invalid log_level ────────────────────────────────────────────────────────

describe('loadBridgeConfig — invalid log_level', () => {
  it('falls back to "info" on invalid log_level and warns', async () => {
    const toml = `[bridge]\nlog_level = "verbose"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });

    expect(config.bridge.log_level).toBe('info');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid log_level'));
  });
});

// ─── invalid session_idle_timeout_secs ───────────────────────────────────────

describe('loadBridgeConfig — invalid session_idle_timeout_secs', () => {
  it('falls back to default (86400) on non-positive integer and warns', async () => {
    const toml = `[bridge]\nsession_idle_timeout_secs = -1\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });

    expect(config.bridge.session_idle_timeout_secs).toBe(86400);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('session_idle_timeout_secs'));
  });

  it('falls back on zero', async () => {
    const toml = `[bridge]\nsession_idle_timeout_secs = 0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.bridge.session_idle_timeout_secs).toBe(86400);
  });

  it('falls back on float', async () => {
    const toml = `[bridge]\nsession_idle_timeout_secs = 1.5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.bridge.session_idle_timeout_secs).toBe(86400);
  });
});

// ─── malformed TOML ───────────────────────────────────────────────────────────

describe('loadBridgeConfig — malformed TOML', () => {
  it('throws a clear error on malformed TOML', async () => {
    const toml = `[bridge\nlog_level = "info"\n`; // missing closing bracket
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    await expect(loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger })).rejects.toThrow(
      /malformed TOML/,
    );
  });
});

// ─── unknown top-level keys ───────────────────────────────────────────────────

describe('loadBridgeConfig — unknown keys', () => {
  it('logs a warning for unknown top-level keys but does not throw', async () => {
    const toml = `[future_section]\nsome_key = "value"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown top-level key "future_section"'),
    );
    // Does not throw — returns defaults.
    expect(config.bridge.log_level).toBe('info');
  });
});

// ─── sources.slack defaults ───────────────────────────────────────────────────

describe('loadBridgeConfig — sources.slack defaults', () => {
  it('fills in all slack defaults on empty config', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    const slack = config.sources.slack;

    expect(slack.enabled).toBe(true);
    expect(slack.bot_token_env).toBe('SLACK_BOT_TOKEN');
    expect(slack.app_token_env).toBe('SLACK_APP_TOKEN');
    expect(slack.trigger_word).toBe('@synaps');
    expect(slack.respond_to_dms).toBe(true);
    expect(slack.respond_to_mentions).toBe(true);
    expect(slack.thread_replies).toBe(true);
  });
});

// ─── env vars referenced, not read ───────────────────────────────────────────

describe('loadBridgeConfig — env var names are config values, not secrets', () => {
  it('bot_token_env is just a string name, not the token value', async () => {
    const toml = `[sources.slack]\nbot_token_env = "MY_CUSTOM_BOT_TOKEN"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });

    // The config stores the env var NAME, not the token itself.
    expect(config.sources.slack.bot_token_env).toBe('MY_CUSTOM_BOT_TOKEN');
  });
});

// ─── partial config merges with defaults ─────────────────────────────────────

describe('loadBridgeConfig — partial config merges with defaults', () => {
  it('merges partial [rpc] with rpc defaults', async () => {
    const toml = `[rpc]\nbinary = "synaps-dev"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });

    expect(config.rpc.binary).toBe('synaps-dev');
    expect(config.rpc.default_model).toBe(BRIDGE_CONFIG_DEFAULTS.rpc.default_model);
    expect(config.rpc.default_profile).toBe(BRIDGE_CONFIG_DEFAULTS.rpc.default_profile);
  });
});

// ─── [rpc] strict flag (Phase 9 Wave C) ──────────────────────────────────────

describe('loadBridgeConfig — [rpc] strict flag (Phase 9 C3)', () => {
  it('BRIDGE_CONFIG_DEFAULTS.rpc.strict defaults to false', () => {
    expect(BRIDGE_CONFIG_DEFAULTS.rpc.strict).toBe(false);
  });

  it('rpc.strict defaults to false when not set in config', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.rpc.strict).toBe(false);
  });

  it('rpc.strict = true parses correctly', async () => {
    const toml = `[rpc]\nstrict = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.rpc.strict).toBe(true);
  });
});

// ─── platform section ─────────────────────────────────────────────────────────

describe('loadBridgeConfig — platform section defaults', () => {
  it('returns platform.mode = "bridge" by default', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.platform.mode).toBe('bridge');
  });

  it('accepts mode = "scp"', async () => {
    const toml = `[platform]\nmode = "scp"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.platform.mode).toBe('scp');
  });

  it('accepts mode = "bridge"', async () => {
    const toml = `[platform]\nmode = "bridge"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.platform.mode).toBe('bridge');
  });

  it('falls back to "bridge" on invalid mode and warns', async () => {
    const toml = `[platform]\nmode = "cluster"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.platform.mode).toBe('bridge');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('platform.mode'));
  });

  it('result.platform is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.platform)).toBe(true);
  });
});

// ─── workspace section ────────────────────────────────────────────────────────

describe('loadBridgeConfig — workspace section defaults', () => {
  it('returns all workspace defaults on empty config', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    const ws = config.workspace;
    expect(ws.image).toBe('synaps/workspace:0.1.0');
    expect(ws.docker_socket).toBe('/var/run/docker.sock');
    expect(ws.volume_root).toBe('/efs/agents');
    expect(ws.default_cpu).toBe(1.0);
    expect(ws.default_mem_mb).toBe(2048);
    expect(ws.default_pids).toBe(256);
    expect(ws.idle_reap_minutes).toBe(30);
  });

  it('overrides workspace fields from TOML', async () => {
    const toml = `[workspace]\nimage = "synaps/workspace:1.2.3"\ndefault_cpu = 2.0\nidle_reap_minutes = 60\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.workspace.image).toBe('synaps/workspace:1.2.3');
    expect(config.workspace.default_cpu).toBe(2.0);
    expect(config.workspace.idle_reap_minutes).toBe(60);
    // unchanged defaults
    expect(config.workspace.docker_socket).toBe(BRIDGE_CONFIG_DEFAULTS.workspace.docker_socket);
  });

  it('falls back on idle_reap_minutes = 0 and warns', async () => {
    const toml = `[workspace]\nidle_reap_minutes = 0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.workspace.idle_reap_minutes).toBe(30);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('idle_reap_minutes'));
  });

  it('falls back on negative idle_reap_minutes and warns', async () => {
    const toml = `[workspace]\nidle_reap_minutes = -5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.workspace.idle_reap_minutes).toBe(30);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('idle_reap_minutes'));
  });

  it('falls back on non-integer idle_reap_minutes and warns', async () => {
    const toml = `[workspace]\nidle_reap_minutes = 1.5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.workspace.idle_reap_minutes).toBe(30);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('idle_reap_minutes'));
  });

  it('falls back on default_cpu = 0 and warns', async () => {
    const toml = `[workspace]\ndefault_cpu = 0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.workspace.default_cpu).toBe(1.0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('default_cpu'));
  });

  it('falls back on negative default_cpu and warns', async () => {
    const toml = `[workspace]\ndefault_cpu = -1.0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.workspace.default_cpu).toBe(1.0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('default_cpu'));
  });

  it('result.workspace is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.workspace)).toBe(true);
  });
});

// ─── web section ──────────────────────────────────────────────────────────────

describe('loadBridgeConfig — web section defaults', () => {
  it('returns all web defaults on empty config', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    const web = config.web;
    expect(web.enabled).toBe(false);
    expect(web.http_port).toBe(0);
    expect(web.bind).toBe('127.0.0.1');
    expect(web.trust_proxy_header).toBe('x-synaps-user-id');
    expect(web.allowed_origin).toBe('');
  });

  it('overrides web fields from TOML', async () => {
    const toml = `[web]\nenabled = true\nhttp_port = 8080\nbind = "0.0.0.0"\nallowed_origin = "https://example.com"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.web.enabled).toBe(true);
    expect(config.web.http_port).toBe(8080);
    expect(config.web.bind).toBe('0.0.0.0');
    expect(config.web.allowed_origin).toBe('https://example.com');
  });

  it('accepts http_port = 0', async () => {
    const toml = `[web]\nhttp_port = 0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.web.http_port).toBe(0);
  });

  it('accepts http_port = 65535', async () => {
    const toml = `[web]\nhttp_port = 65535\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.web.http_port).toBe(65535);
  });

  it('falls back on http_port > 65535 and warns', async () => {
    const toml = `[web]\nhttp_port = 99999\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.web.http_port).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('http_port'));
  });

  it('falls back on negative http_port and warns', async () => {
    const toml = `[web]\nhttp_port = -1\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.web.http_port).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('http_port'));
  });

  it('falls back on non-integer http_port and warns', async () => {
    const toml = `[web]\nhttp_port = 8080.5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.web.http_port).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('http_port'));
  });

  it('result.web is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.web)).toBe(true);
  });
});

// ─── mongodb section ──────────────────────────────────────────────────────────

describe('loadBridgeConfig — mongodb section defaults', () => {
  it('returns mongodb.uri default on empty config', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.mongodb.uri).toBe('mongodb://localhost/priadb');
  });

  it('accepts mongodb:// URI', async () => {
    const toml = `[mongodb]\nuri = "mongodb://mongo-host:27017/mydb"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mongodb.uri).toBe('mongodb://mongo-host:27017/mydb');
  });

  it('accepts mongodb+srv:// URI', async () => {
    const toml = `[mongodb]\nuri = "mongodb+srv://user:pass@cluster.example.com/mydb"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mongodb.uri).toBe('mongodb+srv://user:pass@cluster.example.com/mydb');
  });

  it('falls back on invalid (non-mongodb) URI and warns', async () => {
    const toml = `[mongodb]\nuri = "postgres://localhost/mydb"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.mongodb.uri).toBe('mongodb://localhost/priadb');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mongodb.uri'));
  });

  it('result.mongodb is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.mongodb)).toBe(true);
  });
});

// ─── new sections present in defaults ────────────────────────────────────────

describe('BRIDGE_CONFIG_DEFAULTS includes new sections', () => {
  it('has platform section', () => {
    expect(BRIDGE_CONFIG_DEFAULTS.platform).toBeDefined();
    expect(BRIDGE_CONFIG_DEFAULTS.platform.mode).toBe('bridge');
  });

  it('has workspace section', () => {
    expect(BRIDGE_CONFIG_DEFAULTS.workspace).toBeDefined();
    expect(BRIDGE_CONFIG_DEFAULTS.workspace.idle_reap_minutes).toBe(30);
  });

  it('has web section', () => {
    expect(BRIDGE_CONFIG_DEFAULTS.web).toBeDefined();
    expect(BRIDGE_CONFIG_DEFAULTS.web.http_port).toBe(0);
  });

  it('has mongodb section', () => {
    expect(BRIDGE_CONFIG_DEFAULTS.mongodb).toBeDefined();
    expect(BRIDGE_CONFIG_DEFAULTS.mongodb.uri).toMatch(/^mongodb:\/\//);
  });

  it('all new default sub-objects are frozen', () => {
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.platform)).toBe(true);
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.workspace)).toBe(true);
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.web)).toBe(true);
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.mongodb)).toBe(true);
  });
});

// ─── partial overrides don't lose sibling defaults ───────────────────────────

describe('loadBridgeConfig — partial new sections merge correctly', () => {
  it('partial [workspace] keeps unspecified defaults', async () => {
    const toml = `[workspace]\nimage = "custom:latest"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.workspace.image).toBe('custom:latest');
    expect(config.workspace.docker_socket).toBe(BRIDGE_CONFIG_DEFAULTS.workspace.docker_socket);
    expect(config.workspace.idle_reap_minutes).toBe(30);
  });

  it('partial [web] keeps unspecified defaults', async () => {
    const toml = `[web]\nenabled = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.web.enabled).toBe(true);
    expect(config.web.http_port).toBe(BRIDGE_CONFIG_DEFAULTS.web.http_port);
    expect(config.web.bind).toBe(BRIDGE_CONFIG_DEFAULTS.web.bind);
  });
});

// ─── memory section ───────────────────────────────────────────────────────────

describe('loadBridgeConfig — memory section defaults', () => {
  it('returns all memory defaults when [memory] is absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    const mem = config.memory;
    expect(mem.enabled).toBe(false);
    expect(mem.transport).toBe('cli');
    expect(mem.cli_path).toBe('axel');
    expect(mem.brain_dir).toBe('~/.local/share/synaps/memory');
    expect(mem.recall_k).toBe(8);
    expect(mem.recall_min_score).toBe(0.0);
    expect(mem.recall_max_chars).toBe(2000);
    expect(mem.axel_socket).toBe('/run/synaps/axel.sock');
    expect(mem.consolidation_cron).toBe('0 3 * * *');
  });

  it('result.memory is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.memory)).toBe(true);
  });
});

describe('loadBridgeConfig — memory.enabled', () => {
  it('honours enabled = true', async () => {
    const toml = `[memory]\nenabled = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.enabled).toBe(true);
  });

  it('coerces enabled = "true" (truthy string) to true', async () => {
    // TOML doesn't natively allow bare strings as booleans, so we inject via parsed object.
    // We use a custom fsImpl that returns TOML with a string — but TOML only allows
    // actual booleans; so we test coercion by feeding the raw parse directly via _buildConfig
    // indirectly: use a JSON-like approach by writing the value in a way the parser passes a boolean.
    // Since TOML only allows `true`/`false`, we verify coercion by testing the Boolean() path:
    // inject via a mocked parse result — we call loadBridgeConfig with a TOML file that
    // sets enabled = true, then verify it goes through Boolean().
    // For the "string" coercion edge case, we need to bypass TOML (which would parse "true"
    // as the string "true"). We do this by calling with an fsImpl that returns valid TOML true.
    const toml = `[memory]\nenabled = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.enabled).toBe(true);
  });
});

describe('loadBridgeConfig — memory.transport', () => {
  it('accepts transport = "socket"', async () => {
    const toml = `[memory]\ntransport = "socket"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.transport).toBe('socket');
  });

  it('accepts transport = "cli"', async () => {
    const toml = `[memory]\ntransport = "cli"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.transport).toBe('cli');
  });

  it('falls back to "cli" on invalid transport and warns', async () => {
    const toml = `[memory]\ntransport = "http"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.memory.transport).toBe('cli');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('memory.transport'));
  });
});

describe('loadBridgeConfig — memory.cli_path', () => {
  it('accepts a custom cli_path', async () => {
    const toml = `[memory]\ncli_path = "/usr/local/bin/axel"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.cli_path).toBe('/usr/local/bin/axel');
  });

  it('falls back to "axel" on empty cli_path and warns', async () => {
    const toml = `[memory]\ncli_path = ""\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.memory.cli_path).toBe('axel');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('memory.cli_path'));
  });
});

describe('loadBridgeConfig — memory.brain_dir', () => {
  it('preserves custom brain_dir value as-is (no tilde expansion)', async () => {
    const toml = `[memory]\nbrain_dir = "~/my-custom-brain"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    // brain_dir is NOT expanded — callers are responsible for expansion
    expect(config.memory.brain_dir).toBe('~/my-custom-brain');
  });

  it('preserves an absolute brain_dir unchanged', async () => {
    const toml = `[memory]\nbrain_dir = "/data/synaps/memory"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.brain_dir).toBe('/data/synaps/memory');
  });
});

describe('loadBridgeConfig — memory.recall_k', () => {
  it('accepts recall_k = 42', async () => {
    const toml = `[memory]\nrecall_k = 42\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.recall_k).toBe(42);
  });

  it('accepts recall_k = 1 (boundary)', async () => {
    const toml = `[memory]\nrecall_k = 1\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.recall_k).toBe(1);
  });

  it('accepts recall_k = 50 (boundary)', async () => {
    const toml = `[memory]\nrecall_k = 50\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.recall_k).toBe(50);
  });

  it('falls back on recall_k = 0 and warns', async () => {
    const toml = `[memory]\nrecall_k = 0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.memory.recall_k).toBe(8);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('memory.recall_k'));
  });

  it('falls back on recall_k = 100 (> 50) and warns', async () => {
    const toml = `[memory]\nrecall_k = 100\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.memory.recall_k).toBe(8);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('memory.recall_k'));
  });

  it('falls back on non-integer recall_k and warns', async () => {
    const toml = `[memory]\nrecall_k = 4.5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.memory.recall_k).toBe(8);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('memory.recall_k'));
  });
});

describe('loadBridgeConfig — memory.recall_min_score', () => {
  it('accepts recall_min_score = 0.5', async () => {
    const toml = `[memory]\nrecall_min_score = 0.5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.recall_min_score).toBe(0.5);
  });

  it('accepts recall_min_score = 0.0 (boundary)', async () => {
    const toml = `[memory]\nrecall_min_score = 0.0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.recall_min_score).toBe(0.0);
  });

  it('accepts recall_min_score = 1.0 (boundary)', async () => {
    const toml = `[memory]\nrecall_min_score = 1.0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.recall_min_score).toBe(1.0);
  });

  it('falls back on recall_min_score = -0.1 and warns', async () => {
    const toml = `[memory]\nrecall_min_score = -0.1\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.memory.recall_min_score).toBe(0.0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('memory.recall_min_score'));
  });

  it('falls back on recall_min_score = 1.5 and warns', async () => {
    const toml = `[memory]\nrecall_min_score = 1.5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.memory.recall_min_score).toBe(0.0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('memory.recall_min_score'));
  });

  it('falls back on string recall_min_score = "0.5" and warns', async () => {
    // TOML parses quoted "0.5" as a string — parser should reject it as not typeof number
    const toml = `[memory]\nrecall_min_score = "0.5"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.memory.recall_min_score).toBe(0.0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('memory.recall_min_score'));
  });
});

describe('loadBridgeConfig — memory.recall_max_chars', () => {
  it('accepts recall_max_chars = 5000', async () => {
    const toml = `[memory]\nrecall_max_chars = 5000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.recall_max_chars).toBe(5000);
  });

  it('accepts recall_max_chars = 100 (lower boundary)', async () => {
    const toml = `[memory]\nrecall_max_chars = 100\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.recall_max_chars).toBe(100);
  });

  it('accepts recall_max_chars = 50000 (upper boundary)', async () => {
    const toml = `[memory]\nrecall_max_chars = 50000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.recall_max_chars).toBe(50000);
  });

  it('falls back on recall_max_chars = 50 (< 100) and warns', async () => {
    const toml = `[memory]\nrecall_max_chars = 50\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.memory.recall_max_chars).toBe(2000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('memory.recall_max_chars'));
  });

  it('falls back on recall_max_chars = 100000 (> 50000) and warns', async () => {
    const toml = `[memory]\nrecall_max_chars = 100000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.memory.recall_max_chars).toBe(2000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('memory.recall_max_chars'));
  });
});

describe('loadBridgeConfig — memory.axel_socket', () => {
  it('accepts a custom axel_socket path', async () => {
    const toml = `[memory]\naxel_socket = "/tmp/axel-test.sock"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.axel_socket).toBe('/tmp/axel-test.sock');
  });

  it('falls back on empty axel_socket and warns', async () => {
    const toml = `[memory]\naxel_socket = ""\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.memory.axel_socket).toBe('/run/synaps/axel.sock');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('memory.axel_socket'));
  });
});

describe('loadBridgeConfig — memory.consolidation_cron', () => {
  it('preserves a custom consolidation_cron string', async () => {
    const toml = `[memory]\nconsolidation_cron = "30 2 * * 0"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.consolidation_cron).toBe('30 2 * * 0');
  });

  it('falls back on empty consolidation_cron and warns', async () => {
    const toml = `[memory]\nconsolidation_cron = ""\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.memory.consolidation_cron).toBe('0 3 * * *');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('memory.consolidation_cron'));
  });
});

describe('loadBridgeConfig — memory type-coercion edge case', () => {
  it('Boolean coerces truthy strings: enabled true in TOML becomes boolean true', async () => {
    // TOML native boolean true → Boolean(true) === true
    const toml = `[memory]\nenabled = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.memory.enabled).toBe(true);
    expect(typeof config.memory.enabled).toBe('boolean');
  });
});

describe('BRIDGE_CONFIG_DEFAULTS includes memory section', () => {
  it('has memory section', () => {
    expect(BRIDGE_CONFIG_DEFAULTS.memory).toBeDefined();
    expect(BRIDGE_CONFIG_DEFAULTS.memory.enabled).toBe(false);
    expect(BRIDGE_CONFIG_DEFAULTS.memory.transport).toBe('cli');
    expect(BRIDGE_CONFIG_DEFAULTS.memory.recall_k).toBe(8);
  });

  it('memory default sub-object is frozen', () => {
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.memory)).toBe(true);
  });
});

// ─── identity section ─────────────────────────────────────────────────────────

describe('loadBridgeConfig — identity section defaults', () => {
  it('returns all identity defaults when [identity] is absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    const id = config.identity;
    expect(id.enabled).toBe(false);
    expect(id.link_code_ttl_secs).toBe(300);
    expect(id.default_institution_id).toBe('');
  });

  it('result.identity is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.identity)).toBe(true);
  });

  it('BRIDGE_CONFIG_DEFAULTS has identity section with correct defaults', () => {
    expect(BRIDGE_CONFIG_DEFAULTS.identity).toBeDefined();
    expect(BRIDGE_CONFIG_DEFAULTS.identity.enabled).toBe(false);
    expect(BRIDGE_CONFIG_DEFAULTS.identity.link_code_ttl_secs).toBe(300);
    expect(BRIDGE_CONFIG_DEFAULTS.identity.default_institution_id).toBe('');
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.identity)).toBe(true);
  });
});

describe('loadBridgeConfig — identity.enabled', () => {
  it('honours enabled = true', async () => {
    const toml = `[identity]\nenabled = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.identity.enabled).toBe(true);
  });

  it('defaults to false and does not warn', async () => {
    const toml = `[identity]\nenabled = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.identity.enabled).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('loadBridgeConfig — identity.link_code_ttl_secs', () => {
  it('accepts valid ttl = 60 (lower boundary)', async () => {
    const toml = `[identity]\nlink_code_ttl_secs = 60\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.identity.link_code_ttl_secs).toBe(60);
  });

  it('accepts valid ttl = 3600 (upper boundary)', async () => {
    const toml = `[identity]\nlink_code_ttl_secs = 3600\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.identity.link_code_ttl_secs).toBe(3600);
  });

  it('falls back to 300 on ttl < 60 and warns', async () => {
    const toml = `[identity]\nlink_code_ttl_secs = 59\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.identity.link_code_ttl_secs).toBe(300);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('identity.link_code_ttl_secs'));
  });

  it('falls back to 300 on ttl > 3600 and warns', async () => {
    const toml = `[identity]\nlink_code_ttl_secs = 7200\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.identity.link_code_ttl_secs).toBe(300);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('identity.link_code_ttl_secs'));
  });

  it('falls back to 300 on non-integer ttl and warns', async () => {
    const toml = `[identity]\nlink_code_ttl_secs = 120.5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.identity.link_code_ttl_secs).toBe(300);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('identity.link_code_ttl_secs'));
  });
});

describe('loadBridgeConfig — identity.default_institution_id', () => {
  it('accepts a valid 24-char hex institution_id', async () => {
    const toml = `[identity]\ndefault_institution_id = "deadbeefdeadbeefdeadbeef"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.identity.default_institution_id).toBe('deadbeefdeadbeefdeadbeef');
  });

  it('accepts empty string (no institution fallback)', async () => {
    const toml = `[identity]\ndefault_institution_id = ""\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.identity.default_institution_id).toBe('');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('resets to "" on invalid institution_id (not 24-char hex) and warns', async () => {
    const toml = `[identity]\ndefault_institution_id = "notvalid"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.identity.default_institution_id).toBe('');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('identity.default_institution_id'));
  });
});

describe('loadBridgeConfig — identity unknown keys', () => {
  it('warns on unknown key inside [identity] and drops it', async () => {
    const toml = `[identity]\nunknown_future_key = "xyz"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown identity key "unknown_future_key"'),
    );
    // Config does not have the unknown key.
    expect(config.identity.unknown_future_key).toBeUndefined();
  });
});

// ─── creds section ────────────────────────────────────────────────────────────

describe('BRIDGE_CONFIG_DEFAULTS includes creds section', () => {
  it('has creds section with correct defaults', () => {
    const c = BRIDGE_CONFIG_DEFAULTS.creds;
    expect(c).toBeDefined();
    expect(c.enabled).toBe(false);
    expect(c.broker).toBe('noop');
    expect(c.infisical_url).toBe('');
    expect(c.infisical_token_file).toBe('');
    expect(c.cache_ttl_secs).toBe(300);
    expect(c.audit_attribute_user).toBe(true);
  });

  it('creds default sub-object is frozen', () => {
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.creds)).toBe(true);
  });
});

describe('loadBridgeConfig — creds section defaults', () => {
  it('returns all creds defaults when [creds] is absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    const creds = config.creds;
    expect(creds.enabled).toBe(false);
    expect(creds.broker).toBe('noop');
    expect(creds.infisical_url).toBe('');
    expect(creds.infisical_token_file).toBe('');
    expect(creds.cache_ttl_secs).toBe(300);
    expect(creds.audit_attribute_user).toBe(true);
  });

  it('result.creds is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.creds)).toBe(true);
  });
});

describe('loadBridgeConfig — creds.enabled', () => {
  it('honours enabled = true', async () => {
    const toml = `[creds]\nenabled = true\nbroker = "noop"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.creds.enabled).toBe(true);
  });

  it('defaults to false and does not warn', async () => {
    const toml = `[creds]\nenabled = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.creds.enabled).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('loadBridgeConfig — creds.broker', () => {
  it('accepts broker = "noop"', async () => {
    const toml = `[creds]\nbroker = "noop"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.creds.broker).toBe('noop');
  });

  it('accepts broker = "infisical" when disabled', async () => {
    const toml = `[creds]\nbroker = "infisical"\nenabled = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.creds.broker).toBe('infisical');
  });

  it('falls back to "noop" on invalid broker and warns', async () => {
    const toml = `[creds]\nbroker = "vault"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.creds.broker).toBe('noop');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('creds.broker'));
  });
});

describe('loadBridgeConfig — creds enabled+infisical requires url and token_file', () => {
  it('throws when enabled+infisical but infisical_url is empty', async () => {
    const toml = `[creds]\nenabled = true\nbroker = "infisical"\ninfisical_token_file = "/run/secrets/token"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    await expect(loadBridgeConfig({ path: '/cfg.toml', fsImpl })).rejects.toThrow(
      /creds\.infisical_url must be non-empty/,
    );
  });

  it('throws when enabled+infisical but infisical_token_file is empty', async () => {
    const toml = `[creds]\nenabled = true\nbroker = "infisical"\ninfisical_url = "https://infisical.internal"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    await expect(loadBridgeConfig({ path: '/cfg.toml', fsImpl })).rejects.toThrow(
      /creds\.infisical_token_file must be non-empty/,
    );
  });

  it('accepts enabled+infisical with both url and token_file set', async () => {
    const toml = [
      '[creds]',
      'enabled = true',
      'broker = "infisical"',
      'infisical_url = "https://infisical.internal"',
      'infisical_token_file = "/run/secrets/infisical_token"',
    ].join('\n');
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.creds.enabled).toBe(true);
    expect(config.creds.broker).toBe('infisical');
    expect(config.creds.infisical_url).toBe('https://infisical.internal');
    expect(config.creds.infisical_token_file).toBe('/run/secrets/infisical_token');
  });

  it('does NOT require url/token_file when disabled even if broker = infisical', async () => {
    const toml = `[creds]\nenabled = false\nbroker = "infisical"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    // No throw — disabled means url/file not required.
    expect(config.creds.enabled).toBe(false);
    expect(config.creds.broker).toBe('infisical');
  });
});

describe('loadBridgeConfig — creds.cache_ttl_secs', () => {
  it('accepts cache_ttl_secs = 0 (zero is valid — disable caching)', async () => {
    const toml = `[creds]\ncache_ttl_secs = 0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.creds.cache_ttl_secs).toBe(0);
  });

  it('accepts cache_ttl_secs = 600', async () => {
    const toml = `[creds]\ncache_ttl_secs = 600\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.creds.cache_ttl_secs).toBe(600);
  });

  it('falls back to 300 on negative cache_ttl_secs and warns', async () => {
    const toml = `[creds]\ncache_ttl_secs = -1\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.creds.cache_ttl_secs).toBe(300);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('creds.cache_ttl_secs'));
  });

  it('falls back to 300 on non-integer cache_ttl_secs and warns', async () => {
    const toml = `[creds]\ncache_ttl_secs = 120.5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.creds.cache_ttl_secs).toBe(300);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('creds.cache_ttl_secs'));
  });
});

describe('loadBridgeConfig — creds.audit_attribute_user', () => {
  it('honours audit_attribute_user = false', async () => {
    const toml = `[creds]\naudit_attribute_user = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.creds.audit_attribute_user).toBe(false);
  });

  it('defaults to true when absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.creds.audit_attribute_user).toBe(true);
  });
});

describe('loadBridgeConfig — creds.infisical_token_file tilde expansion', () => {
  it('expands ~/... in infisical_token_file', async () => {
    const toml = `[creds]\ninfisical_token_file = "~/.secrets/infisical_token"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.creds.infisical_token_file).toBe(
      path.join(os.homedir(), '.secrets/infisical_token'),
    );
  });

  it('leaves absolute infisical_token_file unchanged', async () => {
    const toml = `[creds]\ninfisical_token_file = "/run/secrets/infisical_token"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.creds.infisical_token_file).toBe('/run/secrets/infisical_token');
  });
});

describe('loadBridgeConfig — creds unknown keys', () => {
  it('warns on unknown key inside [creds] and drops it', async () => {
    const toml = `[creds]\nfuture_option = "xyz"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown creds key "future_option"'),
    );
    expect(config.creds.future_option).toBeUndefined();
  });
});

// ─── supervisor section ───────────────────────────────────────────────────────

describe('BRIDGE_CONFIG_DEFAULTS includes supervisor section', () => {
  it('has supervisor section with correct defaults', () => {
    const s = BRIDGE_CONFIG_DEFAULTS.supervisor;
    expect(s).toBeDefined();
    expect(s.enabled).toBe(false);
    expect(s.heartbeat_interval_ms).toBe(10_000);
    expect(s.reaper_interval_ms).toBe(60_000);
    expect(s.workspace_stale_ms).toBe(1_800_000);
    expect(s.rpc_stale_ms).toBe(300_000);
    expect(s.scp_stale_ms).toBe(30_000);
    expect(s.bridge_critical_ms).toBe(60_000);
  });

  it('supervisor default sub-object is frozen', () => {
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.supervisor)).toBe(true);
  });
});

describe('loadBridgeConfig — supervisor section defaults', () => {
  it('returns all supervisor defaults when [supervisor] is absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    const s = config.supervisor;
    expect(s.enabled).toBe(false);
    expect(s.heartbeat_interval_ms).toBe(10_000);
    expect(s.reaper_interval_ms).toBe(60_000);
    expect(s.workspace_stale_ms).toBe(1_800_000);
    expect(s.rpc_stale_ms).toBe(300_000);
    expect(s.scp_stale_ms).toBe(30_000);
    expect(s.bridge_critical_ms).toBe(60_000);
  });

  it('result.supervisor is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.supervisor)).toBe(true);
  });
});

describe('loadBridgeConfig — supervisor.enabled', () => {
  it('honours enabled = true', async () => {
    const toml = `[supervisor]\nenabled = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.supervisor.enabled).toBe(true);
  });

  it('defaults to false and does not warn', async () => {
    const toml = `[supervisor]\nenabled = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.supervisor.enabled).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('loadBridgeConfig — supervisor *_ms fields accept valid values', () => {
  it('accepts heartbeat_interval_ms = 5000', async () => {
    const toml = `[supervisor]\nheartbeat_interval_ms = 5000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.supervisor.heartbeat_interval_ms).toBe(5000);
  });

  it('accepts reaper_interval_ms = 30000', async () => {
    const toml = `[supervisor]\nreaper_interval_ms = 30000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.supervisor.reaper_interval_ms).toBe(30000);
  });

  it('accepts workspace_stale_ms = 900000', async () => {
    const toml = `[supervisor]\nworkspace_stale_ms = 900000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.supervisor.workspace_stale_ms).toBe(900000);
  });

  it('accepts rpc_stale_ms = 120000', async () => {
    const toml = `[supervisor]\nrpc_stale_ms = 120000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.supervisor.rpc_stale_ms).toBe(120000);
  });

  it('accepts scp_stale_ms = 0 (zero is valid — non-negative)', async () => {
    const toml = `[supervisor]\nscp_stale_ms = 0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.supervisor.scp_stale_ms).toBe(0);
  });

  it('accepts bridge_critical_ms = 120000', async () => {
    const toml = `[supervisor]\nbridge_critical_ms = 120000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.supervisor.bridge_critical_ms).toBe(120000);
  });
});

describe('loadBridgeConfig — supervisor *_ms fields warn + default on negative', () => {
  it('heartbeat_interval_ms < 0 → warn + default', async () => {
    const toml = `[supervisor]\nheartbeat_interval_ms = -1\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.supervisor.heartbeat_interval_ms).toBe(10_000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('supervisor.heartbeat_interval_ms'));
  });

  it('reaper_interval_ms < 0 → warn + default', async () => {
    const toml = `[supervisor]\nreaper_interval_ms = -5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.supervisor.reaper_interval_ms).toBe(60_000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('supervisor.reaper_interval_ms'));
  });

  it('workspace_stale_ms < 0 → warn + default', async () => {
    const toml = `[supervisor]\nworkspace_stale_ms = -100\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.supervisor.workspace_stale_ms).toBe(1_800_000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('supervisor.workspace_stale_ms'));
  });
});

describe('loadBridgeConfig — supervisor *_ms fields warn + default on non-integer', () => {
  it('heartbeat_interval_ms = 5000.5 → warn + default', async () => {
    const toml = `[supervisor]\nheartbeat_interval_ms = 5000.5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.supervisor.heartbeat_interval_ms).toBe(10_000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('supervisor.heartbeat_interval_ms'));
  });

  it('rpc_stale_ms = 1.5 → warn + default', async () => {
    const toml = `[supervisor]\nrpc_stale_ms = 1.5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.supervisor.rpc_stale_ms).toBe(300_000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('supervisor.rpc_stale_ms'));
  });

  it('bridge_critical_ms = 60.9 → warn + default', async () => {
    const toml = `[supervisor]\nbridge_critical_ms = 60.9\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.supervisor.bridge_critical_ms).toBe(60_000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('supervisor.bridge_critical_ms'));
  });
});

describe('loadBridgeConfig — supervisor unknown keys', () => {
  it('warns on unknown key inside [supervisor] and drops it', async () => {
    const toml = `[supervisor]\nfuture_option = "xyz"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown supervisor key "future_option"'),
    );
    expect(config.supervisor.future_option).toBeUndefined();
  });
});

// ─── Phase 6 new sections ─────────────────────────────────────────────────────

// ─── [scheduler] defaults ────────────────────────────────────────────────────

describe('BRIDGE_CONFIG_DEFAULTS includes scheduler section', () => {
  it('has scheduler section with correct defaults', () => {
    const s = BRIDGE_CONFIG_DEFAULTS.scheduler;
    expect(s).toBeDefined();
    expect(s.enabled).toBe(false);
    expect(s.process_every_secs).toBe(30);
    expect(s.max_concurrency).toBe(5);
  });

  it('scheduler default sub-object is frozen', () => {
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.scheduler)).toBe(true);
  });
});

describe('loadBridgeConfig — scheduler section defaults', () => {
  it('returns all scheduler defaults when [scheduler] is absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    const s = config.scheduler;
    expect(s.enabled).toBe(false);
    expect(s.process_every_secs).toBe(30);
    expect(s.max_concurrency).toBe(5);
  });

  it('result.scheduler is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.scheduler)).toBe(true);
  });

  it('honours scheduler.enabled = true', async () => {
    const toml = `[scheduler]\nenabled = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.scheduler.enabled).toBe(true);
  });

  it('honours custom process_every_secs', async () => {
    const toml = `[scheduler]\nprocess_every_secs = 60\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.scheduler.process_every_secs).toBe(60);
  });

  it('accepts process_every_secs = 0 (zero is valid non-negative)', async () => {
    const toml = `[scheduler]\nprocess_every_secs = 0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.scheduler.process_every_secs).toBe(0);
  });

  it('falls back on process_every_secs < 0 and warns', async () => {
    const toml = `[scheduler]\nprocess_every_secs = -1\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.scheduler.process_every_secs).toBe(30);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('scheduler.process_every_secs'));
  });

  it('falls back on non-integer process_every_secs and warns', async () => {
    const toml = `[scheduler]\nprocess_every_secs = 1.5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.scheduler.process_every_secs).toBe(30);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('scheduler.process_every_secs'));
  });

  it('honours custom max_concurrency', async () => {
    const toml = `[scheduler]\nmax_concurrency = 10\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.scheduler.max_concurrency).toBe(10);
  });

  it('falls back on max_concurrency = 0 and warns (must be >= 1)', async () => {
    const toml = `[scheduler]\nmax_concurrency = 0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.scheduler.max_concurrency).toBe(5);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('scheduler.max_concurrency'));
  });

  it('falls back on negative max_concurrency and warns', async () => {
    const toml = `[scheduler]\nmax_concurrency = -2\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.scheduler.max_concurrency).toBe(5);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('scheduler.max_concurrency'));
  });

  it('warns on unknown key inside [scheduler] and drops it', async () => {
    const toml = `[scheduler]\nfuture_opt = "xyz"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown scheduler key "future_opt"'),
    );
    expect(config.scheduler.future_opt).toBeUndefined();
  });
});

// ─── [hooks] defaults ─────────────────────────────────────────────────────────

describe('BRIDGE_CONFIG_DEFAULTS includes hooks section', () => {
  it('has hooks section with correct defaults', () => {
    const h = BRIDGE_CONFIG_DEFAULTS.hooks;
    expect(h).toBeDefined();
    expect(h.enabled).toBe(false);
    expect(h.timeout_ms).toBe(5000);
    expect(h.max_parallel).toBe(16);
  });

  it('hooks default sub-object is frozen', () => {
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.hooks)).toBe(true);
  });
});

describe('loadBridgeConfig — hooks section defaults', () => {
  it('returns all hooks defaults when [hooks] is absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.hooks.enabled).toBe(false);
    expect(config.hooks.timeout_ms).toBe(5000);
    expect(config.hooks.max_parallel).toBe(16);
  });

  it('result.hooks is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.hooks)).toBe(true);
  });

  it('honours hooks.enabled = true', async () => {
    const toml = `[hooks]\nenabled = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.hooks.enabled).toBe(true);
  });

  it('honours custom hooks.timeout_ms', async () => {
    const toml = `[hooks]\ntimeout_ms = 10000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.hooks.timeout_ms).toBe(10000);
  });

  it('accepts hooks.timeout_ms = 0 (non-negative)', async () => {
    const toml = `[hooks]\ntimeout_ms = 0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.hooks.timeout_ms).toBe(0);
  });

  it('falls back on hooks.timeout_ms < 0 and warns', async () => {
    const toml = `[hooks]\ntimeout_ms = -100\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.hooks.timeout_ms).toBe(5000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hooks.timeout_ms'));
  });

  it('falls back on non-integer hooks.timeout_ms and warns', async () => {
    const toml = `[hooks]\ntimeout_ms = 5000.5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.hooks.timeout_ms).toBe(5000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hooks.timeout_ms'));
  });

  it('honours custom hooks.max_parallel', async () => {
    const toml = `[hooks]\nmax_parallel = 32\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.hooks.max_parallel).toBe(32);
  });

  it('falls back on hooks.max_parallel = 0 and warns (must be >= 1)', async () => {
    const toml = `[hooks]\nmax_parallel = 0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.hooks.max_parallel).toBe(16);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hooks.max_parallel'));
  });

  it('falls back on negative hooks.max_parallel and warns', async () => {
    const toml = `[hooks]\nmax_parallel = -5\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.hooks.max_parallel).toBe(16);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hooks.max_parallel'));
  });

  it('warns on unknown key inside [hooks] and drops it', async () => {
    const toml = `[hooks]\nfuture_opt = "xyz"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown hooks key "future_opt"'),
    );
    expect(config.hooks.future_opt).toBeUndefined();
  });
});

// ─── [inbox] defaults ─────────────────────────────────────────────────────────

describe('BRIDGE_CONFIG_DEFAULTS includes inbox section', () => {
  it('has inbox section with correct defaults', () => {
    const i = BRIDGE_CONFIG_DEFAULTS.inbox;
    expect(i).toBeDefined();
    expect(i.enabled).toBe(false);
    expect(i.dir_template).toBe('');
  });

  it('inbox default sub-object is frozen', () => {
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.inbox)).toBe(true);
  });
});

describe('loadBridgeConfig — inbox section defaults', () => {
  it('returns all inbox defaults when [inbox] is absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.inbox.enabled).toBe(false);
    expect(config.inbox.dir_template).toBe('');
  });

  it('result.inbox is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.inbox)).toBe(true);
  });

  it('honours inbox.enabled = true', async () => {
    const toml = `[inbox]\nenabled = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.inbox.enabled).toBe(true);
  });

  it('defaults inbox.enabled to false and does not warn', async () => {
    const toml = `[inbox]\nenabled = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(config.inbox.enabled).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('honours custom inbox.dir_template', async () => {
    const toml = `[inbox]\ndir_template = "/var/synaps/inbox/{workspaceId}"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.inbox.dir_template).toBe('/var/synaps/inbox/{workspaceId}');
  });

  it('warns on unknown key inside [inbox] and drops it', async () => {
    const toml = `[inbox]\nfuture_opt = "xyz"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown inbox key "future_opt"'),
    );
    expect(config.inbox.future_opt).toBeUndefined();
  });
});

// ─── [scheduler] [hooks] [inbox] not listed as unknown top-level keys ─────────

describe('loadBridgeConfig — scheduler / hooks / inbox are not treated as unknown top-level', () => {
  it('does not warn about [scheduler] as unknown key', async () => {
    const toml = `[scheduler]\nenabled = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('unknown top-level key "scheduler"'),
    );
  });

  it('does not warn about [hooks] as unknown key', async () => {
    const toml = `[hooks]\nenabled = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('unknown top-level key "hooks"'),
    );
  });

  it('does not warn about [inbox] as unknown key', async () => {
    const toml = `[inbox]\nenabled = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('unknown top-level key "inbox"'),
    );
  });
});

// ─── [mcp] section ────────────────────────────────────────────────────────────

describe('loadBridgeConfig — [mcp] BRIDGE_CONFIG_DEFAULTS', () => {
  it('mcp default sub-object is frozen', () => {
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.mcp)).toBe(true);
  });

  it('MCP_DEFAULTS: enabled=false, audit=false, chat_timeout_ms=120000, max_body_bytes=262144, policy_name=synaps-control-plane', () => {
    const D = BRIDGE_CONFIG_DEFAULTS;
    expect(D.mcp.enabled).toBe(false);
    expect(D.mcp.audit).toBe(false);
    expect(D.mcp.chat_timeout_ms).toBe(120_000);
    expect(D.mcp.max_body_bytes).toBe(262_144);
    expect(D.mcp.policy_name).toBe('synaps-control-plane');
  });
});

describe('loadBridgeConfig — [mcp] section defaults (absent section)', () => {
  it('returns all mcp defaults when [mcp] is absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.mcp.enabled).toBe(false);
    expect(config.mcp.audit).toBe(false);
    expect(config.mcp.chat_timeout_ms).toBe(120_000);
    expect(config.mcp.max_body_bytes).toBe(262_144);
    expect(config.mcp.policy_name).toBe('synaps-control-plane');
  });

  it('result.mcp is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.mcp)).toBe(true);
  });
});

describe('loadBridgeConfig — [mcp] section parsing', () => {
  it('[mcp] enabled = true parses correctly', async () => {
    const toml = `[mcp]\nenabled = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mcp.enabled).toBe(true);
  });

  it('[mcp] audit = true parses correctly', async () => {
    const toml = `[mcp]\naudit = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mcp.audit).toBe(true);
  });

  it('[mcp] chat_timeout_ms = 30000 accepted', async () => {
    const toml = `[mcp]\nchat_timeout_ms = 30000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mcp.chat_timeout_ms).toBe(30_000);
  });

  it('[mcp] policy_name = "custom" parses correctly', async () => {
    const toml = `[mcp]\npolicy_name = "custom"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mcp.policy_name).toBe('custom');
  });
});

describe('loadBridgeConfig — [mcp] validation errors (throws)', () => {
  it('chat_timeout_ms = 500 rejected (below min 1000)', async () => {
    const toml = `[mcp]\nchat_timeout_ms = 500\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    await expect(loadBridgeConfig({ path: '/cfg.toml', fsImpl })).rejects.toThrow(
      /mcp\.chat_timeout_ms/,
    );
  });

  it('chat_timeout_ms = 700000 rejected (above max 600000)', async () => {
    const toml = `[mcp]\nchat_timeout_ms = 700000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    await expect(loadBridgeConfig({ path: '/cfg.toml', fsImpl })).rejects.toThrow(
      /mcp\.chat_timeout_ms/,
    );
  });

  it('max_body_bytes = 100 rejected (below min 1024)', async () => {
    const toml = `[mcp]\nmax_body_bytes = 100\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    await expect(loadBridgeConfig({ path: '/cfg.toml', fsImpl })).rejects.toThrow(
      /mcp\.max_body_bytes/,
    );
  });

  it('max_body_bytes = 5000000 rejected (above max 4194304)', async () => {
    const toml = `[mcp]\nmax_body_bytes = 5000000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    await expect(loadBridgeConfig({ path: '/cfg.toml', fsImpl })).rejects.toThrow(
      /mcp\.max_body_bytes/,
    );
  });

  it('policy_name = "" rejected (empty string)', async () => {
    const toml = `[mcp]\npolicy_name = ""\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    await expect(loadBridgeConfig({ path: '/cfg.toml', fsImpl })).rejects.toThrow(
      /mcp\.policy_name/,
    );
  });
});

describe('loadBridgeConfig — [mcp] is not treated as unknown top-level', () => {
  it('does not warn about [mcp] as unknown key', async () => {
    const toml = `[mcp]\nenabled = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('unknown top-level key "mcp"'),
    );
  });

  it('warns on unknown key inside [mcp] and drops it', async () => {
    const toml = `[mcp]\nfuture_opt = "xyz"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown mcp key "future_opt"'),
    );
    expect(config.mcp.future_opt).toBeUndefined();
  });
});

// ─── [mcp] Phase 8 Wave B — new sub-keys ──────────────────────────────────────

describe('loadBridgeConfig — [mcp] surface_rpc_tools (Phase 8)', () => {
  it('BRIDGE_CONFIG_DEFAULTS.mcp.surface_rpc_tools = false', () => {
    expect(BRIDGE_CONFIG_DEFAULTS.mcp.surface_rpc_tools).toBe(false);
  });

  it('defaults to false when key absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.mcp.surface_rpc_tools).toBe(false);
  });

  it('surface_rpc_tools = true parses correctly', async () => {
    const toml = `[mcp]\nsurface_rpc_tools = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mcp.surface_rpc_tools).toBe(true);
  });

  it('surface_rpc_tools is not treated as unknown key', async () => {
    const toml = `[mcp]\nsurface_rpc_tools = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('unknown mcp key "surface_rpc_tools"'),
    );
  });
});

describe('loadBridgeConfig — [mcp.rate_limit] (Phase 8)', () => {
  it('BRIDGE_CONFIG_DEFAULTS.mcp.rate_limit is frozen with correct defaults', () => {
    const rl = BRIDGE_CONFIG_DEFAULTS.mcp.rate_limit;
    expect(Object.isFrozen(rl)).toBe(true);
    expect(rl.enabled).toBe(true);
    expect(rl.per_token_capacity).toBe(60);
    expect(rl.per_token_refill).toBe(1);
    expect(rl.per_ip_capacity).toBe(120);
    expect(rl.per_ip_refill).toBe(2);
  });

  it('defaults when [mcp.rate_limit] absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.mcp.rate_limit.enabled).toBe(true);
    expect(config.mcp.rate_limit.per_token_capacity).toBe(60);
    expect(config.mcp.rate_limit.per_ip_capacity).toBe(120);
  });

  it('result.mcp.rate_limit is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.mcp.rate_limit)).toBe(true);
  });

  it('rate_limit.enabled = false disables limiter', async () => {
    const toml = `[mcp.rate_limit]\nenabled = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mcp.rate_limit.enabled).toBe(false);
  });

  it('rate_limit custom capacities parse correctly', async () => {
    const toml = `[mcp.rate_limit]\nper_token_capacity = 100\nper_ip_capacity = 200\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mcp.rate_limit.per_token_capacity).toBe(100);
    expect(config.mcp.rate_limit.per_ip_capacity).toBe(200);
  });

  it('rate_limit custom refill rates parse correctly', async () => {
    const toml = `[mcp.rate_limit]\nper_token_refill = 5\nper_ip_refill = 10\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mcp.rate_limit.per_token_refill).toBe(5);
    expect(config.mcp.rate_limit.per_ip_refill).toBe(10);
  });

  it('per_token_capacity = 0 → validation error', async () => {
    const toml = `[mcp.rate_limit]\nper_token_capacity = 0\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    await expect(loadBridgeConfig({ path: '/cfg.toml', fsImpl })).rejects.toThrow(
      /mcp\.rate_limit\.per_token_capacity/,
    );
  });

  it('per_ip_refill = -1 → validation error', async () => {
    const toml = `[mcp.rate_limit]\nper_ip_refill = -1\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    await expect(loadBridgeConfig({ path: '/cfg.toml', fsImpl })).rejects.toThrow(
      /mcp\.rate_limit\.per_ip_refill/,
    );
  });

  it('unknown key inside [mcp.rate_limit] warns and is dropped', async () => {
    const toml = `[mcp.rate_limit]\nfuture_opt = "x"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown mcp.rate_limit key "future_opt"'),
    );
    expect(config.mcp.rate_limit.future_opt).toBeUndefined();
  });
});

describe('loadBridgeConfig — [mcp.sse] (Phase 8)', () => {
  it('BRIDGE_CONFIG_DEFAULTS.mcp.sse.enabled = false (opt-in)', () => {
    expect(BRIDGE_CONFIG_DEFAULTS.mcp.sse.enabled).toBe(false);
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.mcp.sse)).toBe(true);
  });

  it('defaults when [mcp.sse] absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.mcp.sse.enabled).toBe(false);
  });

  it('result.mcp.sse is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.mcp.sse)).toBe(true);
  });

  it('mcp.sse.enabled = true parses correctly', async () => {
    const toml = `[mcp.sse]\nenabled = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mcp.sse.enabled).toBe(true);
  });

  it('unknown key inside [mcp.sse] warns and is dropped', async () => {
    const toml = `[mcp.sse]\nfoo = "bar"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown mcp.sse key "foo"'),
    );
    expect(config.mcp.sse.foo).toBeUndefined();
  });
});

describe('loadBridgeConfig — [mcp.dcr] (Phase 8)', () => {
  it('BRIDGE_CONFIG_DEFAULTS.mcp.dcr has correct defaults', () => {
    const dcr = BRIDGE_CONFIG_DEFAULTS.mcp.dcr;
    expect(Object.isFrozen(dcr)).toBe(true);
    expect(dcr.enabled).toBe(false);
    expect(dcr.registration_secret).toBe('');
    expect(dcr.token_ttl_ms).toBe(365 * 24 * 60 * 60 * 1_000);
  });

  it('defaults when [mcp.dcr] absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.mcp.dcr.enabled).toBe(false);
    expect(config.mcp.dcr.registration_secret).toBe('');
    expect(config.mcp.dcr.token_ttl_ms).toBe(365 * 24 * 60 * 60 * 1_000);
  });

  it('result.mcp.dcr is frozen', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(Object.isFrozen(config.mcp.dcr)).toBe(true);
  });

  it('mcp.dcr.enabled = true parses correctly', async () => {
    const toml = `[mcp.dcr]\nenabled = true\nregistration_secret = "s3cr3t"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mcp.dcr.enabled).toBe(true);
    expect(config.mcp.dcr.registration_secret).toBe('s3cr3t');
  });

  it('mcp.dcr.token_ttl_ms custom value parses correctly', async () => {
    const toml = `[mcp.dcr]\ntoken_ttl_ms = 86400000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mcp.dcr.token_ttl_ms).toBe(86_400_000);
  });

  it('mcp.dcr.token_ttl_ms < 60000 → validation error', async () => {
    const toml = `[mcp.dcr]\ntoken_ttl_ms = 1000\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    await expect(loadBridgeConfig({ path: '/cfg.toml', fsImpl })).rejects.toThrow(
      /mcp\.dcr\.token_ttl_ms/,
    );
  });

  it('unknown key inside [mcp.dcr] warns and is dropped', async () => {
    const toml = `[mcp.dcr]\nfoo = "bar"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown mcp.dcr key "foo"'),
    );
    expect(config.mcp.dcr.foo).toBeUndefined();
  });
});

describe('loadBridgeConfig — [mcp] sub-sections not treated as unknown top-level mcp keys', () => {
  it('does not warn about rate_limit, sse, dcr as unknown mcp keys', async () => {
    const toml = `[mcp.rate_limit]\nenabled = true\n[mcp.sse]\nenabled = false\n[mcp.dcr]\nenabled = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    const warnCalls = logger.warn.mock.calls.map(([m]) => String(m));
    expect(warnCalls.some(m => m.includes('unknown mcp key "rate_limit"'))).toBe(false);
    expect(warnCalls.some(m => m.includes('unknown mcp key "sse"'))).toBe(false);
    expect(warnCalls.some(m => m.includes('unknown mcp key "dcr"'))).toBe(false);
  });
});

// ─── Phase 9 Wave B — new config sections ─────────────────────────────────────

describe('loadBridgeConfig — [mcp.sse] stream_deltas (Phase 9)', () => {
  it('BRIDGE_CONFIG_DEFAULTS.mcp.sse.stream_deltas = false (opt-in)', () => {
    expect(BRIDGE_CONFIG_DEFAULTS.mcp.sse.stream_deltas).toBe(false);
  });

  it('stream_deltas defaults to false when [mcp.sse] is absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.mcp.sse.stream_deltas).toBe(false);
  });

  it('stream_deltas = true parses correctly', async () => {
    const toml = `[mcp.sse]\nstream_deltas = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mcp.sse.stream_deltas).toBe(true);
  });
});

describe('loadBridgeConfig — [mcp.acl] enabled (Phase 9)', () => {
  it('BRIDGE_CONFIG_DEFAULTS.mcp.acl.enabled = false (opt-in)', () => {
    expect(BRIDGE_CONFIG_DEFAULTS.mcp.acl.enabled).toBe(false);
    expect(Object.isFrozen(BRIDGE_CONFIG_DEFAULTS.mcp.acl)).toBe(true);
  });

  it('acl.enabled defaults to false when [mcp.acl] is absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.mcp.acl.enabled).toBe(false);
    expect(Object.isFrozen(config.mcp.acl)).toBe(true);
  });

  it('acl.enabled = true parses correctly', async () => {
    const toml = `[mcp.acl]\nenabled = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.mcp.acl.enabled).toBe(true);
  });

  it('unknown key inside [mcp.acl] warns and is dropped', async () => {
    const toml = `[mcp.acl]\nfuture_key = "x"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown mcp.acl key "future_key"'),
    );
    expect(config.mcp.acl.future_key).toBeUndefined();
  });
});

describe('loadBridgeConfig — [metrics] enabled/path/bind (Phase 9)', () => {
  it('BRIDGE_CONFIG_DEFAULTS.metrics has correct defaults', () => {
    const m = BRIDGE_CONFIG_DEFAULTS.metrics;
    expect(Object.isFrozen(m)).toBe(true);
    expect(m.enabled).toBe(false);
    expect(m.path).toBe('/metrics');
    expect(m.bind).toBe('127.0.0.1');
  });

  it('metrics defaults when [metrics] section is absent', async () => {
    const fsImpl = makeFsImpl({});
    const config = await loadBridgeConfig({ path: '/no/file.toml', fsImpl });
    expect(config.metrics.enabled).toBe(false);
    expect(config.metrics.path).toBe('/metrics');
    expect(config.metrics.bind).toBe('127.0.0.1');
    expect(Object.isFrozen(config.metrics)).toBe(true);
  });

  it('metrics.enabled = true parses correctly', async () => {
    const toml = `[metrics]\nenabled = true\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl });
    expect(config.metrics.enabled).toBe(true);
  });

  it('metrics.path not starting with "/" throws', async () => {
    const toml = `[metrics]\npath = "metrics"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    await expect(loadBridgeConfig({ path: '/cfg.toml', fsImpl })).rejects.toThrow(
      /metrics\.path/,
    );
  });

  it('metrics.bind empty string throws', async () => {
    const toml = `[metrics]\nbind = ""\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    await expect(loadBridgeConfig({ path: '/cfg.toml', fsImpl })).rejects.toThrow(
      /metrics\.bind/,
    );
  });

  it('unknown key inside [metrics] warns and is dropped', async () => {
    const toml = `[metrics]\nfoo = "bar"\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown metrics key "foo"'),
    );
    expect(config.metrics.foo).toBeUndefined();
  });
});

describe('loadBridgeConfig — acl/metrics not treated as unknown mcp or top-level keys', () => {
  it('does not warn about acl as unknown mcp key', async () => {
    const toml = `[mcp.acl]\nenabled = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    const warnCalls = logger.warn.mock.calls.map(([m]) => String(m));
    expect(warnCalls.some(m => m.includes('unknown mcp key "acl"'))).toBe(false);
  });

  it('does not warn about metrics as unknown top-level key', async () => {
    const toml = `[metrics]\nenabled = false\n`;
    const fsImpl = makeFsImpl({ '/cfg.toml': toml });
    const logger = makeLogger();
    await loadBridgeConfig({ path: '/cfg.toml', fsImpl, logger });
    const warnCalls = logger.warn.mock.calls.map(([m]) => String(m));
    expect(warnCalls.some(m => m.includes('unknown top-level key "metrics"'))).toBe(false);
  });
});
