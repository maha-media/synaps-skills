/**
 * @file tests/scp-phase-2/00-config-memory.test.mjs
 *
 * Integration tests for the [memory] section of loadBridgeConfig().
 *
 * Mirrors the pattern established in tests/scp-phase-1/00-config-modes.test.mjs:
 *   - Use real temp TOML files written to os.tmpdir().
 *   - Import loadBridgeConfig + BRIDGE_CONFIG_DEFAULTS directly.
 *   - afterEach cleans up temp files.
 *
 * Covers:
 *   - Empty / missing [memory] table → all defaults preserved
 *   - enabled = true honoured
 *   - transport = 'socket' honoured
 *   - transport = 'http' (invalid) → falls back to 'cli' with a warning
 *   - cli_path override round-trip
 *   - brain_dir override + tilde expansion
 *   - recall_k valid and invalid ranges
 *   - recall_min_score valid and invalid ranges
 *   - recall_max_chars valid and invalid ranges
 *   - axel_socket override
 *   - consolidation_cron override
 *   - Full combined [memory] block round-trip
 *   - memory section is frozen in the returned config
 *
 * Constraints:
 *   - ESM only (.mjs)
 *   - No top-level await
 *   - vitest describe/it/expect/vi
 *   - Real fs (node:fs/promises) + os.tmpdir()
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
 *
 * @param {string} content  TOML content
 * @returns {Promise<string>}
 */
async function writeTempToml(content) {
  const file = path.join(
    os.tmpdir(),
    `scp-phase2-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}.toml`,
  );
  await fs.writeFile(file, content, 'utf8');
  tempFiles.push(file);
  return file;
}

/** Silent logger that captures warn calls for assertions. */
function makeLogger() {
  return {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

afterEach(async () => {
  for (const f of tempFiles.splice(0)) {
    await fs.unlink(f).catch(() => {});
  }
});

// ─── 1. Missing file → memory defaults ───────────────────────────────────────

describe('loadBridgeConfig [memory] — missing file', () => {
  it('returns all memory defaults when the config file does not exist', async () => {
    const nonExistent = path.join(os.tmpdir(), `no-such-file-${Date.now()}.toml`);
    const config = await loadBridgeConfig({ path: nonExistent });
    const D = BRIDGE_CONFIG_DEFAULTS.memory;

    expect(config.memory.enabled).toBe(D.enabled);
    expect(config.memory.transport).toBe(D.transport);
    expect(config.memory.cli_path).toBe(D.cli_path);
    expect(config.memory.brain_dir).toBe(D.brain_dir);
    expect(config.memory.recall_k).toBe(D.recall_k);
    expect(config.memory.recall_min_score).toBe(D.recall_min_score);
    expect(config.memory.recall_max_chars).toBe(D.recall_max_chars);
    expect(config.memory.axel_socket).toBe(D.axel_socket);
    expect(config.memory.consolidation_cron).toBe(D.consolidation_cron);
  });

  it('enabled defaults to false', async () => {
    const nonExistent = path.join(os.tmpdir(), `no-such-${Date.now()}.toml`);
    const config = await loadBridgeConfig({ path: nonExistent });
    expect(config.memory.enabled).toBe(false);
  });

  it('transport defaults to "cli"', async () => {
    const nonExistent = path.join(os.tmpdir(), `no-such-${Date.now()}.toml`);
    const config = await loadBridgeConfig({ path: nonExistent });
    expect(config.memory.transport).toBe('cli');
  });

  it('cli_path defaults to "axel"', async () => {
    const nonExistent = path.join(os.tmpdir(), `no-such-${Date.now()}.toml`);
    const config = await loadBridgeConfig({ path: nonExistent });
    expect(config.memory.cli_path).toBe('axel');
  });

  it('brain_dir defaults to "~/.local/share/synaps/memory"', async () => {
    const nonExistent = path.join(os.tmpdir(), `no-such-${Date.now()}.toml`);
    const config = await loadBridgeConfig({ path: nonExistent });
    expect(config.memory.brain_dir).toBe('~/.local/share/synaps/memory');
  });

  it('recall_k defaults to 8', async () => {
    const nonExistent = path.join(os.tmpdir(), `no-such-${Date.now()}.toml`);
    const config = await loadBridgeConfig({ path: nonExistent });
    expect(config.memory.recall_k).toBe(8);
  });

  it('recall_max_chars defaults to 2000', async () => {
    const nonExistent = path.join(os.tmpdir(), `no-such-${Date.now()}.toml`);
    const config = await loadBridgeConfig({ path: nonExistent });
    expect(config.memory.recall_max_chars).toBe(2000);
  });
});

// ─── 2. Empty [memory] table → all defaults ──────────────────────────────────

describe('loadBridgeConfig [memory] — empty table', () => {
  it('returns all memory defaults when [memory] is present but empty', async () => {
    const filePath = await writeTempToml('[memory]\n');
    const config = await loadBridgeConfig({ path: filePath });
    const D = BRIDGE_CONFIG_DEFAULTS.memory;

    expect(config.memory.enabled).toBe(D.enabled);
    expect(config.memory.transport).toBe(D.transport);
    expect(config.memory.cli_path).toBe(D.cli_path);
    expect(config.memory.recall_k).toBe(D.recall_k);
    expect(config.memory.recall_max_chars).toBe(D.recall_max_chars);
  });

  it('memory section is frozen when table is empty', async () => {
    const filePath = await writeTempToml('[memory]\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(Object.isFrozen(config.memory)).toBe(true);
  });
});

// ─── 3. enabled = true ───────────────────────────────────────────────────────

describe('loadBridgeConfig [memory] — enabled = true', () => {
  it('parses enabled = true from a real file', async () => {
    const filePath = await writeTempToml('[memory]\nenabled = true\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.enabled).toBe(true);
  });

  it('enabled = false round-trips correctly', async () => {
    const filePath = await writeTempToml('[memory]\nenabled = false\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.enabled).toBe(false);
  });
});

// ─── 4. transport validation ──────────────────────────────────────────────────

describe('loadBridgeConfig [memory] — transport', () => {
  it('transport = "cli" round-trips correctly', async () => {
    const filePath = await writeTempToml('[memory]\ntransport = "cli"\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.transport).toBe('cli');
  });

  it('transport = "socket" round-trips correctly', async () => {
    const filePath = await writeTempToml('[memory]\ntransport = "socket"\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.transport).toBe('socket');
  });

  it('transport = "http" (invalid) falls back to "cli" with a warning', async () => {
    const filePath = await writeTempToml('[memory]\ntransport = "http"\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });

    expect(config.memory.transport).toBe('cli');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('memory.transport'),
    );
  });

  it('transport = "grpc" (invalid) falls back to "cli" with a warning', async () => {
    const filePath = await writeTempToml('[memory]\ntransport = "grpc"\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });

    expect(config.memory.transport).toBe('cli');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('transport = "" (empty string, invalid) falls back to "cli" with a warning', async () => {
    const filePath = await writeTempToml('[memory]\ntransport = ""\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });

    expect(config.memory.transport).toBe('cli');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('memory.transport'),
    );
  });
});

// ─── 5. cli_path ─────────────────────────────────────────────────────────────

describe('loadBridgeConfig [memory] — cli_path', () => {
  it('cli_path override round-trips correctly', async () => {
    const filePath = await writeTempToml('[memory]\ncli_path = "/usr/local/bin/axel"\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.cli_path).toBe('/usr/local/bin/axel');
  });
});

// ─── 6. brain_dir ────────────────────────────────────────────────────────────

describe('loadBridgeConfig [memory] — brain_dir', () => {
  it('brain_dir override round-trips correctly', async () => {
    const filePath = await writeTempToml('[memory]\nbrain_dir = "/tmp/synaps-brains"\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.brain_dir).toBe('/tmp/synaps-brains');
  });

  it('brain_dir with tilde is preserved as-is (expansion is in MemoryGateway)', async () => {
    const filePath = await writeTempToml('[memory]\nbrain_dir = "~/.local/share/synaps/custom"\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.brain_dir).toBe('~/.local/share/synaps/custom');
  });
});

// ─── 7. recall_k ─────────────────────────────────────────────────────────────

describe('loadBridgeConfig [memory] — recall_k', () => {
  it('recall_k = 1 is the minimum valid value', async () => {
    const filePath = await writeTempToml('[memory]\nrecall_k = 1\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.recall_k).toBe(1);
  });

  it('recall_k = 50 is the maximum valid value', async () => {
    const filePath = await writeTempToml('[memory]\nrecall_k = 50\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.recall_k).toBe(50);
  });

  it('recall_k = 0 (too low) falls back to default with a warning', async () => {
    const filePath = await writeTempToml('[memory]\nrecall_k = 0\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });

    expect(config.memory.recall_k).toBe(BRIDGE_CONFIG_DEFAULTS.memory.recall_k);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('memory.recall_k'),
    );
  });

  it('recall_k = 51 (too high) falls back to default with a warning', async () => {
    const filePath = await writeTempToml('[memory]\nrecall_k = 51\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });

    expect(config.memory.recall_k).toBe(BRIDGE_CONFIG_DEFAULTS.memory.recall_k);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

// ─── 8. recall_min_score ─────────────────────────────────────────────────────

describe('loadBridgeConfig [memory] — recall_min_score', () => {
  it('recall_min_score = 0.0 (default) round-trips', async () => {
    const filePath = await writeTempToml('[memory]\nrecall_min_score = 0.0\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.recall_min_score).toBe(0.0);
  });

  it('recall_min_score = 0.75 round-trips correctly', async () => {
    const filePath = await writeTempToml('[memory]\nrecall_min_score = 0.75\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.recall_min_score).toBe(0.75);
  });

  it('recall_min_score = 1.0 (maximum valid) round-trips correctly', async () => {
    const filePath = await writeTempToml('[memory]\nrecall_min_score = 1.0\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.recall_min_score).toBe(1.0);
  });

  it('recall_min_score = -0.1 (negative) falls back with a warning', async () => {
    const filePath = await writeTempToml('[memory]\nrecall_min_score = -0.1\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });

    expect(config.memory.recall_min_score).toBe(BRIDGE_CONFIG_DEFAULTS.memory.recall_min_score);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('memory.recall_min_score'),
    );
  });

  it('recall_min_score = 1.5 (above 1) falls back with a warning', async () => {
    const filePath = await writeTempToml('[memory]\nrecall_min_score = 1.5\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });

    expect(config.memory.recall_min_score).toBe(BRIDGE_CONFIG_DEFAULTS.memory.recall_min_score);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

// ─── 9. recall_max_chars ─────────────────────────────────────────────────────

describe('loadBridgeConfig [memory] — recall_max_chars', () => {
  it('recall_max_chars = 100 (minimum valid) round-trips', async () => {
    const filePath = await writeTempToml('[memory]\nrecall_max_chars = 100\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.recall_max_chars).toBe(100);
  });

  it('recall_max_chars = 50000 (maximum valid) round-trips', async () => {
    const filePath = await writeTempToml('[memory]\nrecall_max_chars = 50000\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.recall_max_chars).toBe(50000);
  });

  it('recall_max_chars = 99 (too low) falls back with a warning', async () => {
    const filePath = await writeTempToml('[memory]\nrecall_max_chars = 99\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });

    expect(config.memory.recall_max_chars).toBe(BRIDGE_CONFIG_DEFAULTS.memory.recall_max_chars);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('memory.recall_max_chars'),
    );
  });

  it('recall_max_chars = 50001 (too high) falls back with a warning', async () => {
    const filePath = await writeTempToml('[memory]\nrecall_max_chars = 50001\n');
    const logger = makeLogger();
    const config = await loadBridgeConfig({ path: filePath, logger });

    expect(config.memory.recall_max_chars).toBe(BRIDGE_CONFIG_DEFAULTS.memory.recall_max_chars);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

// ─── 10. axel_socket ─────────────────────────────────────────────────────────

describe('loadBridgeConfig [memory] — axel_socket', () => {
  it('axel_socket override round-trips correctly', async () => {
    const filePath = await writeTempToml('[memory]\naxel_socket = "/run/myapp/axel.sock"\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.axel_socket).toBe('/run/myapp/axel.sock');
  });
});

// ─── 11. consolidation_cron ──────────────────────────────────────────────────

describe('loadBridgeConfig [memory] — consolidation_cron', () => {
  it('consolidation_cron override round-trips correctly', async () => {
    const filePath = await writeTempToml('[memory]\nconsolidation_cron = "30 2 * * *"\n');
    const config = await loadBridgeConfig({ path: filePath });
    expect(config.memory.consolidation_cron).toBe('30 2 * * *');
  });
});

// ─── 12. Full [memory] block round-trip ──────────────────────────────────────

describe('loadBridgeConfig [memory] — full block round-trip', () => {
  it('parses all memory fields from a real file', async () => {
    const toml = `
[memory]
enabled             = true
transport           = "cli"
cli_path            = "/usr/local/bin/axel"
brain_dir           = "/tmp/synaps-test-brains"
recall_k            = 12
recall_min_score    = 0.5
recall_max_chars    = 4000
axel_socket         = "/run/synaps/custom.sock"
consolidation_cron  = "0 1 * * *"
`;
    const filePath = await writeTempToml(toml);
    const config = await loadBridgeConfig({ path: filePath });
    const m = config.memory;

    expect(m.enabled).toBe(true);
    expect(m.transport).toBe('cli');
    expect(m.cli_path).toBe('/usr/local/bin/axel');
    expect(m.brain_dir).toBe('/tmp/synaps-test-brains');
    expect(m.recall_k).toBe(12);
    expect(m.recall_min_score).toBe(0.5);
    expect(m.recall_max_chars).toBe(4000);
    expect(m.axel_socket).toBe('/run/synaps/custom.sock');
    expect(m.consolidation_cron).toBe('0 1 * * *');
  });

  it('memory section is frozen after full-block parse', async () => {
    const toml = '[memory]\nenabled = true\nrecall_k = 5\n';
    const filePath = await writeTempToml(toml);
    const config = await loadBridgeConfig({ path: filePath });

    expect(Object.isFrozen(config.memory)).toBe(true);
  });

  it('memory does not affect other sections', async () => {
    const toml = '[memory]\nenabled = true\n';
    const filePath = await writeTempToml(toml);
    const config = await loadBridgeConfig({ path: filePath });

    expect(config.bridge.log_level).toBe('info');
    expect(config.rpc.binary).toBe('synaps');
    expect(config.platform.mode).toBe('bridge');
  });
});

// ─── 13. Combined full SCP + memory config ───────────────────────────────────

describe('loadBridgeConfig [memory] — combined SCP+memory round-trip', () => {
  it('parses a bridge.toml with all SCP sections + memory correctly', async () => {
    const toml = `
[platform]
mode = "scp"

[memory]
enabled          = true
transport        = "cli"
cli_path         = "axel"
brain_dir        = "~/.local/share/synaps/memory"
recall_k         = 8
recall_min_score = 0.0
recall_max_chars = 2000

[workspace]
image = "synaps/workspace:dev"

[web]
enabled   = true
http_port = 8723
`;
    const filePath = await writeTempToml(toml);
    const config = await loadBridgeConfig({ path: filePath });

    expect(config.platform.mode).toBe('scp');
    expect(config.memory.enabled).toBe(true);
    expect(config.memory.transport).toBe('cli');
    expect(config.memory.recall_k).toBe(8);
    expect(config.web.enabled).toBe(true);
    expect(config.workspace.image).toBe('synaps/workspace:dev');
    expect(Object.isFrozen(config)).toBe(true);
  });
});
