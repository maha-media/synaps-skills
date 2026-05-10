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
