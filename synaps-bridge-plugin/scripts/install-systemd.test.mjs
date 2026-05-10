/**
 * @file scripts/install-systemd.test.mjs
 *
 * Vitest tests for scripts/install-systemd.sh.
 *
 * Strategy: spawn the install script with --dry-run + HOME=$tmpdir +
 * PATH=$tmpdir/stubs:$PATH where stubs contain a fake `systemctl` that
 * exits 0.  Inspect the files the script created and their modes.
 *
 * The tests are hermetic: they never touch the real systemd, never read
 * real tokens, never modify the operator's home directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── paths ────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT     = path.resolve(__dirname, 'install-systemd.sh');
const PLUGIN_DIR = path.resolve(__dirname, '..');

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal stub directory with fake binaries that just exit 0
 * and echo their arguments.
 *
 * @param {string} stubDir
 * @param {Record<string,string>} [extras]  - name → script body overrides
 */
function createStubs(stubDir, extras = {}) {
  fs.mkdirSync(stubDir, { recursive: true });

  // Default stubs — exit 0 silently
  const defaults = {
    systemctl:  '#!/bin/sh\nexit 0\n',
    loginctl:   '#!/bin/sh\nexit 0\n',
    // `uname -s` must return Linux
    uname:      '#!/bin/sh\necho Linux\n',
    // `id -u` must return non-zero (non-root)
    id:         '#!/bin/sh\necho 1000\n',
  };

  const stubs = { ...defaults, ...extras };

  for (const [name, body] of Object.entries(stubs)) {
    const p = path.join(stubDir, name);
    fs.writeFileSync(p, body, { mode: 0o755 });
  }
}

/**
 * Run install-systemd.sh with the given flags inside a fresh tmpdir.
 *
 * @param {object}   opts
 * @param {string}   opts.home         - Temp HOME directory
 * @param {string}   opts.stubDir      - Directory with stub binaries
 * @param {string[]} [opts.args]       - Extra CLI args
 * @param {Record<string,string>} [opts.env] - Extra env overrides
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runInstaller(opts) {
  const { home, stubDir, args = [], env: extraEnv = {} } = opts;

  // Build PATH: stubs first, then real PATH so `bash` itself is found
  const stubbedPath = `${stubDir}:${process.env.PATH}`;

  const result = spawnSync('bash', [SCRIPT, '--dry-run', '--allow-root', ...args], {
    env: {
      ...process.env,
      HOME: home,
      PATH: stubbedPath,
      // Prevent XDG from bleeding real dirs into the test
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_STATE_HOME:  path.join(home, '.local', 'state'),
      USER: 'testuser',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 15_000,
  });

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Return the octal mode string for a path, e.g. "0600". */
function fileMode(filePath) {
  const stat = fs.statSync(filePath);
  return '0' + (stat.mode & 0o7777).toString(8).padStart(3, '0');
}

// ─── per-test tmpdir management ───────────────────────────────────────────────

let tmpHome = '';
let stubDir = '';

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'synaps-install-test-'));
  stubDir = path.join(tmpHome, '_stubs');
  createStubs(stubDir);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ─── tests ────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// 1. happy path — bridge.toml materialised
// ---------------------------------------------------------------------------

describe('bridge.toml materialisation', () => {
  it('creates bridge.toml from example on first run', () => {
    const result = runInstaller({ home: tmpHome, stubDir });

    expect(result.status).toBe(0);

    const configPath = path.join(tmpHome, '.synaps-cli', 'bridge', 'bridge.toml');
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('bridge.toml content matches bridge.toml.example', () => {
    runInstaller({ home: tmpHome, stubDir });

    const configPath  = path.join(tmpHome, '.synaps-cli', 'bridge', 'bridge.toml');
    const examplePath = path.join(PLUGIN_DIR, 'config', 'bridge.toml.example');

    const installed = fs.readFileSync(configPath, 'utf8');
    const example   = fs.readFileSync(examplePath, 'utf8');

    expect(installed).toBe(example);
  });
});

// ---------------------------------------------------------------------------
// 2. env file scaffold
// ---------------------------------------------------------------------------

describe('env file scaffold', () => {
  it('creates env file scaffold on first run', () => {
    runInstaller({ home: tmpHome, stubDir });

    const envPath = path.join(tmpHome, '.config', 'synaps', 'slack-bridge.env');
    expect(fs.existsSync(envPath)).toBe(true);
  });

  it('env file has mode 0600', () => {
    runInstaller({ home: tmpHome, stubDir });

    const envPath = path.join(tmpHome, '.config', 'synaps', 'slack-bridge.env');
    expect(fileMode(envPath)).toBe('0600');
  });

  it('env file contains placeholder tokens, not real ones', () => {
    runInstaller({ home: tmpHome, stubDir });

    const envPath = path.join(tmpHome, '.config', 'synaps', 'slack-bridge.env');
    const content = fs.readFileSync(envPath, 'utf8');

    expect(content).toContain('SLACK_BOT_TOKEN=xoxb-REPLACE-ME');
    expect(content).toContain('SLACK_APP_TOKEN=xapp-REPLACE-ME');
    // No real tokens
    expect(content).not.toMatch(/xoxb-[A-Za-z0-9]{10,}/);
    expect(content).not.toMatch(/xapp-[A-Za-z0-9]{10,}/);
  });
});

// ---------------------------------------------------------------------------
// 3. rendered unit file — no placeholders
// ---------------------------------------------------------------------------

describe('rendered unit file', () => {
  it('writes rendered unit file to systemd user dir', () => {
    runInstaller({ home: tmpHome, stubDir });

    const unitPath = path.join(tmpHome, '.config', 'systemd', 'user', 'synaps-bridge.service');
    expect(fs.existsSync(unitPath)).toBe(true);
  });

  it('rendered unit has no remaining __PLACEHOLDERS__', () => {
    runInstaller({ home: tmpHome, stubDir });

    const unitPath = path.join(tmpHome, '.config', 'systemd', 'user', 'synaps-bridge.service');
    const content  = fs.readFileSync(unitPath, 'utf8');

    // Check only non-comment lines for unresolved placeholder tokens
    const nonCommentLines = content.split('\n')
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n');

    expect(nonCommentLines).not.toMatch(/__[A-Z_]+__/);
  });

  it('rendered unit contains absolute path to bin/synaps-bridge.js', () => {
    runInstaller({ home: tmpHome, stubDir });

    const unitPath = path.join(tmpHome, '.config', 'systemd', 'user', 'synaps-bridge.service');
    const content  = fs.readFileSync(unitPath, 'utf8');

    expect(content).toContain('bin/synaps-bridge.js');
    // The path should be absolute (starts with /)
    expect(content).toMatch(/ExecStart=\/.*bin\/synaps-bridge\.js/);
  });
});

// ---------------------------------------------------------------------------
// 4. idempotency — second run must not overwrite user data
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('does not overwrite bridge.toml on second run', () => {
    // First run
    runInstaller({ home: tmpHome, stubDir });

    const configPath = path.join(tmpHome, '.synaps-cli', 'bridge', 'bridge.toml');
    // Tamper with the file
    fs.appendFileSync(configPath, '\n# user-edit\n');
    const after1 = fs.readFileSync(configPath, 'utf8');

    // Second run
    const result = runInstaller({ home: tmpHome, stubDir });
    expect(result.status).toBe(0);

    const after2 = fs.readFileSync(configPath, 'utf8');
    expect(after2).toBe(after1);  // unchanged
    expect(result.stdout).toContain('exists; not overwriting');
  });

  it('does not overwrite env file on second run', () => {
    // First run
    runInstaller({ home: tmpHome, stubDir });

    const envPath = path.join(tmpHome, '.config', 'synaps', 'slack-bridge.env');
    // Simulate operator having filled in real tokens (we use dummy values)
    const edited = '# edited\nSLACK_BOT_TOKEN=xoxb-TEST\nSLACK_APP_TOKEN=xapp-TEST\n';
    fs.writeFileSync(envPath, edited, { mode: 0o600 });

    // Second run
    runInstaller({ home: tmpHome, stubDir });

    const after2 = fs.readFileSync(envPath, 'utf8');
    expect(after2).toBe(edited);   // operator's edits preserved
  });
});

// ---------------------------------------------------------------------------
// 5. macOS detection — must bail
// ---------------------------------------------------------------------------

describe('macOS detection', () => {
  it('exits non-zero on macOS (mocked uname returns Darwin)', () => {
    const darwinStubDir = path.join(tmpHome, '_darwin_stubs');
    createStubs(darwinStubDir, {
      uname: '#!/bin/sh\necho Darwin\n',
    });

    // Must NOT pass --allow-root override to uname — use raw spawn without helper flags
    const result = spawnSync('bash', [SCRIPT, '--dry-run', '--allow-root'], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PATH: `${darwinStubDir}:${process.env.PATH}`,
        XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
        USER: 'testuser',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/macOS/i);
  });
});

// ---------------------------------------------------------------------------
// 6. root detection — must bail
// ---------------------------------------------------------------------------

describe('root detection', () => {
  it('exits non-zero when id -u returns 0 (without --allow-root)', () => {
    const rootStubDir = path.join(tmpHome, '_root_stubs');
    createStubs(rootStubDir, {
      id: '#!/bin/sh\necho 0\n',
    });

    const result = spawnSync('bash', [SCRIPT, '--dry-run'], {
      env: {
        ...process.env,
        HOME: tmpHome,
        PATH: `${rootStubDir}:${process.env.PATH}`,
        XDG_CONFIG_HOME: path.join(tmpHome, '.config'),
        USER: 'root',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).not.toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/root/i);
  });
});

// ---------------------------------------------------------------------------
// 7. dry-run mode — systemctl never invoked for real
// ---------------------------------------------------------------------------

describe('dry-run flag', () => {
  it('prints [dry-run] for systemctl calls', () => {
    const result = runInstaller({ home: tmpHome, stubDir, args: ['--enable', '--start'] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[dry-run]');
    expect(result.stdout).toContain('daemon-reload');
    expect(result.stdout).toContain('enable synaps-bridge');
    expect(result.stdout).toContain('start  synaps-bridge');
  });
});

// ---------------------------------------------------------------------------
// 8. linger hint when --linger not passed
// ---------------------------------------------------------------------------

describe('linger hint', () => {
  it('prints a linger hint when --linger is not passed', () => {
    const result = runInstaller({ home: tmpHome, stubDir });

    expect(result.status).toBe(0);
    // The warning lands on stderr
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/linger/i);
  });
});
