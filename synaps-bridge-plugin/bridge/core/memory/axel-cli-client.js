/**
 * bridge/core/memory/axel-cli-client.js
 *
 * Thin promise-based wrapper around the `axel` CLI binary.
 * Shells out via execFile with AXEL_BRAIN=<path> env.
 *
 * No state beyond config. Stateless per call. All methods are async.
 * No I/O in constructor.
 *
 * Spec reference: PLATFORM.SPEC.md §6 — AxelCliClient transport layer
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as nodeFs } from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(nodeExecFile);

// ─── AxelCliClient ───────────────────────────────────────────────────────────

/**
 * Thin wrapper around the `axel` CLI binary.
 *
 * @example
 * const client = new AxelCliClient({ cliPath: 'axel' });
 * await client.init('/home/user/.synaps/u_alice.r8');
 * const results = await client.search('/home/user/.synaps/u_alice.r8', 'rust patterns');
 */
export class AxelCliClient {
  /**
   * @param {object}   [opts]
   * @param {string}   [opts.cliPath='axel']         - axel binary path or name on PATH.
   * @param {object}   [opts.logger=console]         - Logger with .warn/.debug methods.
   * @param {Function} [opts.execFile]               - Injectable execFile (file, args, opts) => Promise<{stdout, stderr}>.
   *                                                   Defaults to promisified node:child_process.execFile.
   * @param {object}   [opts.fs]                     - Injectable fs/promises-like object; must expose mkdir + access + constants.
   * @param {number}   [opts.defaultTimeoutMs=30000] - Per-call timeout in milliseconds.
   */
  constructor({
    cliPath = 'axel',
    logger = console,
    execFile = undefined,
    fs = undefined,
    defaultTimeoutMs = 30_000,
  } = {}) {
    this._cliPath          = cliPath;
    this._logger           = logger;
    this._execFile         = execFile ?? execFileAsync;
    this._fs               = fs ?? nodeFs;
    this._defaultTimeoutMs = defaultTimeoutMs;
  }

  // ─── private helpers ───────────────────────────────────────────────────────

  /**
   * Validate that brainPath is absolute.
   * @param {string} brainPath
   */
  _assertAbsolute(brainPath) {
    if (!path.isAbsolute(brainPath)) {
      throw new TypeError('brainPath must be an absolute path');
    }
  }

  /**
   * Run an axel subcommand.
   *
   * @param {string}   subcommand   - e.g. 'search', 'remember'
   * @param {string[]} args         - Additional args after the subcommand.
   * @param {string}   brainPath    - Absolute path to the .r8 brain file.
   * @returns {Promise<{stdout: string, stderr: string}>}
   */
  async _run(subcommand, args, brainPath) {
    const env = {
      ...process.env,
      AXEL_BRAIN: brainPath,
    };

    const execArgs = [subcommand, ...args];

    let result;
    try {
      result = await this._execFile(this._cliPath, execArgs, {
        env,
        timeout: this._defaultTimeoutMs,
      });
    } catch (err) {
      // Timeout: execFile rejects with signal === 'SIGTERM'
      if (err && err.signal === 'SIGTERM') {
        throw new Error(
          `axel ${subcommand} timed out after ${this._defaultTimeoutMs}ms`,
        );
      }

      // Non-zero exit code
      const code   = err.code ?? err.exitCode ?? 'unknown';
      const stderr = (err.stderr ?? '').slice(0, 500);
      const error  = new Error(
        `axel ${subcommand} failed (exit ${code}): ${stderr}`,
      );
      error.code   = code;
      error.stderr = err.stderr ?? '';
      throw error;
    }

    return result;
  }

  // ─── public API ───────────────────────────────────────────────────────────

  /**
   * Check whether the brain file exists.
   *
   * @param {string} brainPath - Absolute path to the .r8 file.
   * @returns {Promise<boolean>}
   */
  async exists(brainPath) {
    this._assertAbsolute(brainPath);
    try {
      await this._fs.access(brainPath, this._fs.constants.F_OK);
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * Initialise a new brain file (idempotent).
   * Creates the parent directory, then calls `axel init --name <name>`.
   * If the brain file already exists, skips the axel call.
   *
   * @param {string} brainPath
   * @param {object} [opts]
   * @param {string} [opts.name='synaps-user']
   * @returns {Promise<{ok: true, created: boolean}>}
   */
  async init(brainPath, { name = 'synaps-user' } = {}) {
    this._assertAbsolute(brainPath);

    // mkdir -p the parent directory
    const parentDir = path.dirname(brainPath);
    await this._fs.mkdir(parentDir, { recursive: true });

    // Idempotency: skip axel if file already exists
    if (await this.exists(brainPath)) {
      return { ok: true, created: false };
    }

    await this._run('init', ['--name', name], brainPath);
    return { ok: true, created: true };
  }

  /**
   * Search the brain for documents matching a query.
   *
   * @param {string} brainPath
   * @param {string} query
   * @param {object} [opts]
   * @param {number} [opts.k=8]
   * @returns {Promise<Array<{id: string, content: string, score: number}>>}
   */
  async search(brainPath, query, { k = 8 } = {}) {
    this._assertAbsolute(brainPath);

    const { stdout } = await this._run(
      'search',
      [query, '--limit', String(k), '--json'],
      brainPath,
    );

    // Empty / whitespace-only stdout → no results
    if (!stdout || !stdout.trim()) {
      return [];
    }

    try {
      return JSON.parse(stdout);
    } catch {
      this._logger.warn(
        '[AxelCliClient] search: failed to parse JSON output; returning []',
        { stdout },
      );
      return [];
    }
  }

  /**
   * Store a memory in the brain.
   *
   * @param {string} brainPath
   * @param {string} content
   * @param {object} [opts]
   * @param {string} [opts.category]
   * @param {string} [opts.topic]
   * @param {string} [opts.title]
   * @returns {Promise<{ok: true, id?: string}>}
   */
  async remember(brainPath, content, { category, topic, title } = {}) {
    this._assertAbsolute(brainPath);

    if (!content || typeof content !== 'string' || !content.trim()) {
      throw new TypeError(
        'AxelCliClient.remember: content must be a non-empty string',
      );
    }

    const args = [content];
    if (category) args.push('--category', category);
    if (topic)    args.push('--topic', topic);
    if (title)    args.push('--title', title);

    const { stdout } = await this._run('remember', args, brainPath);

    // Try to extract an id from JSON output, if any
    let id;
    if (stdout && stdout.trim()) {
      try {
        const parsed = JSON.parse(stdout);
        id = parsed?.id ?? undefined;
      } catch {
        // non-JSON output is fine for remember
        this._logger.debug(
          '[AxelCliClient] remember: stdout is not JSON (that is OK)',
          { stdout },
        );
      }
    }

    return id !== undefined ? { ok: true, id } : { ok: true };
  }

  /**
   * Run the 4-phase consolidation.
   *
   * @param {string} brainPath
   * @param {object} [opts]
   * @param {string} [opts.since]       - ISO date string; if provided, passed as --since.
   * @param {boolean} [opts.dryRun=false]
   * @returns {Promise<{ok: true, summary?: object}>}
   */
  async consolidate(brainPath, { since, dryRun = false } = {}) {
    this._assertAbsolute(brainPath);

    const args = ['--json'];
    if (dryRun) args.push('--dry-run');
    if (since)  args.push('--since', since);

    const { stdout } = await this._run('consolidate', args, brainPath);

    let summary;
    if (stdout && stdout.trim()) {
      try {
        summary = JSON.parse(stdout);
      } catch {
        this._logger.warn(
          '[AxelCliClient] consolidate: failed to parse JSON output',
          { stdout },
        );
      }
    }

    return summary !== undefined ? { ok: true, summary } : { ok: true };
  }
}
